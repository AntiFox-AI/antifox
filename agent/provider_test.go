package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestConnectionSendsSessionHeader: 配了会话头时，连接测试也得带上(头值非空)，
// 否则 opencode 等网关会因缺 session id 返回 400，测试结果与实际运行不一致。
func TestConnectionSendsSessionHeader(t *testing.T) {
	const hk = "X-Session-Id"
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get(hk)
		if got == "" {
			http.Error(w, `{"error":{"message":"missing session id"}}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer srv.Close()

	cfg := ConfigFrom("openai", "m", srv.URL, "k", "")
	cfg.SessionHeaderKey = hk
	if _, err := TestConnection(context.Background(), cfg); err != nil {
		t.Fatalf("TestConnection with session header: %v", err)
	}
	if got == "" {
		t.Fatalf("expected %s header to be sent", hk)
	}
}

// TestConnectionNoSessionHeaderWhenUnset: 未填会话头时不发送任何会话头。
func TestConnectionNoSessionHeaderWhenUnset(t *testing.T) {
	const hk = "X-Session-Id"
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get(hk)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer srv.Close()

	cfg := ConfigFrom("openai", "m", srv.URL, "k", "")
	if _, err := TestConnection(context.Background(), cfg); err != nil {
		t.Fatalf("TestConnection: %v", err)
	}
	if got != "" {
		t.Fatalf("expected no %s header when unset, got %q", hk, got)
	}
}
