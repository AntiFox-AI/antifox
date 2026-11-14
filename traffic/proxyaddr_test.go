package traffic

import "testing"

func TestProxyAddr(t *testing.T) {
	for in, want := range map[string]string{
		":8788":          "http://127.0.0.1:8788",
		"127.0.0.1:8788": "http://127.0.0.1:8788",
		"localhost:8788": "http://localhost:8788",
	} {
		if got := (&Traffic{addr: in}).ProxyAddr(); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}
