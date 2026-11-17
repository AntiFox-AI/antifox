package server

import (
	"net/http/httptest"
	"testing"
)

// TestClientIPTrustedProxy verifies the anti-spoofing rule: forwarded headers
// (X-Real-IP / X-Forwarded-For) are only trusted when the direct peer is a
// loopback/private proxy; otherwise RemoteAddr wins, so a client cannot forge
// its source IP to bypass source-level rate limiting.
func TestClientIPTrustedProxy(t *testing.T) {
	cases := []struct {
		name       string
		remoteAddr string // what net/http reports as the direct peer
		xrealip    string
		xff        string
		want       string
	}{
		{
			name:       "trusted loopback proxy, X-Real-IP wins",
			remoteAddr: "127.0.0.1:43210",
			xrealip:    "203.0.113.9",
			xff:        "1.2.3.4, 5.6.7.8",
			want:       "203.0.113.9",
		},
		{
			name:       "trusted loopback proxy, XFF takes last hop",
			remoteAddr: "127.0.0.1:43210",
			xrealip:    "",
			xff:        "spoofed.1.2.3, 203.0.113.55",
			want:       "203.0.113.55",
		},
		{
			// 默认私网不可信（防内网客户端伪造）：10.x 直连即便带 XFF 也只认直连来源。
			name:       "untrusted private peer ignores forged XFF (default loopback-only)",
			remoteAddr: "10.0.0.1:43210",
			xrealip:    "",
			xff:        "203.0.113.77",
			want:       "10.0.0.1",
		},
		{
			// IPv6 回环反代：SplitHostPort 正确去括号，X-Real-IP 被采信。
			name:       "trusted IPv6 loopback proxy, X-Real-IP wins",
			remoteAddr: "[::1]:43210",
			xrealip:    "203.0.113.88",
			xff:        "",
			want:       "203.0.113.88",
		},
		{
			name:       "untrusted public peer ignores forged XFF",
			remoteAddr: "8.8.8.8:43210",
			xrealip:    "",
			xff:        "203.0.113.9",
			want:       "8.8.8.8",
		},
		{
			name:       "untrusted public peer ignores X-Real-IP",
			remoteAddr: "8.8.8.8:43210",
			xrealip:    "203.0.113.9",
			want:       "8.8.8.8",
		},
		{
			name:       "no forwarded headers, fall back to RemoteAddr",
			remoteAddr: "203.0.113.200:43210",
			want:       "203.0.113.200",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://example.com/", nil)
			r.RemoteAddr = tc.remoteAddr
			if tc.xrealip != "" {
				r.Header.Set("X-Real-IP", tc.xrealip)
			}
			if tc.xff != "" {
				r.Header.Set("X-Forwarded-For", tc.xff)
			}
			if got := clientIP(r); got != tc.want {
				t.Fatalf("clientIP() = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestIsTrustedProxyIP pins the default trusted-proxy classification: ONLY loopback
// is trusted by default — private ranges are NOT (an internal-LAN client must not be
// able to forge forwarded headers to bypass per-source lockout).
func TestIsTrustedProxyIP(t *testing.T) {
	trusted := []string{"127.0.0.1", "127.5.5.5", "::1"}
	for _, ip := range trusted {
		if !isTrustedProxyIP(ip) {
			t.Errorf("isTrustedProxyIP(%q) = false, want true", ip)
		}
	}
	untrusted := []string{"8.8.8.8", "203.0.113.9", "10.0.0.1", "172.16.0.1", "192.168.1.1", "not-an-ip"}
	for _, ip := range untrusted {
		if isTrustedProxyIP(ip) {
			t.Errorf("isTrustedProxyIP(%q) = true, want false", ip)
		}
	}
}

// TestSetTrustedProxies verifies an explicitly configured proxy range becomes trusted
// (reverse proxy not on loopback), and that the default loopback-only set is restored
// when cleared — so an empty setting never widens trust.
func TestSetTrustedProxies(t *testing.T) {
	defer SetTrustedProxies("") // restore loopback-only for other tests
	SetTrustedProxies("10.0.0.0/8, 192.168.1.5")
	for _, ip := range []string{"127.0.0.1", "::1", "10.1.2.3", "192.168.1.5"} {
		if !isTrustedProxyIP(ip) {
			t.Errorf("after SetTrustedProxies: isTrustedProxyIP(%q) = false, want true", ip)
		}
	}
	for _, ip := range []string{"192.168.1.6", "172.16.0.1", "8.8.8.8"} {
		if isTrustedProxyIP(ip) {
			t.Errorf("after SetTrustedProxies: isTrustedProxyIP(%q) = true, want false", ip)
		}
	}
	SetTrustedProxies("")
	if isTrustedProxyIP("10.1.2.3") {
		t.Error("empty SetTrustedProxies should restore loopback-only, but 10.x still trusted")
	}
}
