package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeTokens struct {
	calls  int
	forced int
}

func (f *fakeTokens) Token(_ context.Context, force bool) (string, string, error) {
	f.calls++
	if force {
		f.forced++
		return "tok-new", "acct-1", nil
	}
	return "tok-old", "acct-1", nil
}

const codexSSE = "event: response.output_item.added\n" +
	`data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"c1","name":"shell"}}` + "\n\n" +
	"event: response.function_call_arguments.delta\n" +
	`data: {"type":"response.function_call_arguments.delta","delta":"{\"cmd\":\"id\"}"}` + "\n\n" +
	"event: response.completed\n" +
	`data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":3}}}` + "\n\n"

func TestCodexRequestShapeAuthAndRefresh(t *testing.T) {
	var bodies []map[string]any
	var auths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" {
			t.Errorf("path = %s", r.URL.Path)
		}
		auths = append(auths, r.Header.Get("authorization"))
		if got := r.Header.Get("chatgpt-account-id"); got != "acct-1" {
			t.Errorf("chatgpt-account-id = %q", got)
		}
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		bodies = append(bodies, m)
		if r.Header.Get("authorization") == "Bearer tok-old" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"expired"}`))
			return
		}
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte(codexSSE))
	}))
	defer srv.Close()

	ts := &fakeTokens{}
	p, err := NewProvider(Config{Format: FormatOpenAICodex, BaseURL: srv.URL, Model: "gpt-5-codex", TokenSource: ts, MaxRetries: -1, ReasoningEffort: "max"})
	if err != nil {
		t.Fatal(err)
	}
	temp := 0.2
	msg, stop, usage, err := p.Complete(context.Background(), CompletionRequest{
		Messages:    []Message{{Role: RoleUser, Content: []ContentBlock{TextBlock("hi")}}},
		MaxTokens:   4096,
		Temperature: &temp,
	})
	if err != nil {
		t.Fatal(err)
	}
	if ts.forced != 1 || len(auths) != 2 || auths[1] != "Bearer tok-new" {
		t.Fatalf("expected one forced refresh + retry, got forced=%d auths=%v", ts.forced, auths)
	}
	b := bodies[1]
	if b["stream"] != true || b["store"] != false {
		t.Errorf("stream/store = %v/%v", b["stream"], b["store"])
	}
	for _, k := range []string{"max_output_tokens", "temperature"} {
		if _, ok := b[k]; ok {
			t.Errorf("%s must not be sent to the ChatGPT backend", k)
		}
	}
	if s, _ := b["instructions"].(string); s == "" {
		t.Error("instructions must be non-empty")
	}
	if r, _ := b["reasoning"].(map[string]any); r["effort"] != "high" || r["summary"] != "auto" {
		t.Errorf("reasoning = %v", b["reasoning"])
	}
	if stop != "tool_use" || len(msg.Content) != 1 || msg.Content[0].Name != "shell" || !strings.Contains(string(msg.Content[0].Input), "id") {
		t.Errorf("unexpected message %+v stop=%s", msg, stop)
	}
	if usage.InputTokens != 10 || usage.OutputTokens != 3 {
		t.Errorf("usage = %+v", usage)
	}
}

func TestCodexNeedsTokenSource(t *testing.T) {
	if _, err := NewProvider(Config{Format: FormatOpenAICodex}); err == nil {
		t.Fatal("expected error without a token source")
	}
}

func TestCodexReasoningDefaultsLow(t *testing.T) {
	effort := func(cfg Config, req CompletionRequest) any {
		cfg.Format, cfg.TokenSource = FormatOpenAICodex, &fakeTokens{}
		p, err := NewProvider(cfg)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := p.(*openaiResponsesProvider).buildBody(req, true)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		if r, ok := m["reasoning"].(map[string]any); ok {
			return r["effort"]
		}
		return nil
	}
	if e := effort(Config{}, CompletionRequest{}); e != "low" {
		t.Errorf("unset effort = %v, want low", e)
	}
	if e := effort(Config{ReasoningEffort: "medium", ThinkingType: "enabled"}, CompletionRequest{}); e != "medium" {
		t.Errorf("explicit effort = %v, want medium", e)
	}
	if e := effort(Config{ThinkingType: "disabled"}, CompletionRequest{}); e != nil {
		t.Errorf("thinking off should omit reasoning, got %v", e)
	}
	if e := effort(Config{}, CompletionRequest{Thinking: "disabled"}); e != nil {
		t.Errorf("per-request disabled should omit reasoning, got %v", e)
	}
}
