package llm

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestOpenAIStreamAcceptHeader guards the Accept header of the streaming path:
// some OpenAI-compatible gateways (e.g. vLLM-based ones) 406 a stream:true
// request whose Accept does not also list application/json, so both media types
// must be offered.
func TestOpenAIStreamAcceptHeader(t *testing.T) {
	var gotAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAccept = r.Header.Get("Accept")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(`data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}` + "\n\n"))
		_, _ = w.Write([]byte(`data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}` + "\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer srv.Close()

	p, err := NewProvider(Config{Format: FormatOpenAI, BaseURL: srv.URL, APIKey: "test-key", Model: "test-model"})
	if err != nil {
		t.Fatal(err)
	}

	var text string
	for ev, serr := range p.Stream(context.Background(), CompletionRequest{
		Messages:  []Message{{Role: RoleUser, Content: []ContentBlock{{Type: BlockText, Text: "ping"}}}},
		MaxTokens: 8,
	}) {
		if serr != nil {
			t.Fatalf("stream error: %v", serr)
		}
		if ev.Type == SETextDelta {
			text += ev.Text
		}
	}
	if text != "OK" {
		t.Fatalf("streamed text = %q, want %q", text, "OK")
	}
	if !strings.Contains(gotAccept, "text/event-stream") || !strings.Contains(gotAccept, "application/json") {
		t.Fatalf("Accept = %q, want both text/event-stream and application/json", gotAccept)
	}
}
