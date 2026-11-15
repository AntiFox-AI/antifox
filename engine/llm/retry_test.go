package llm

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func retryAfterResp(v string) *http.Response {
	r := &http.Response{Header: http.Header{}}
	if v != "" {
		r.Header.Set("Retry-After", v)
	}
	return r
}

func TestRetryAfterDelayDeltaSeconds(t *testing.T) {
	cases := []struct {
		v    string
		want time.Duration
		ok   bool
	}{
		{"", 0, false},                 // absent
		{"5", 5 * time.Second, true},   // typical 429/503 hint
		{"0", 0, true},                 // retry immediately
		{"-1", 0, false},               // invalid
		{"abc", 0, false},              // invalid
		{"120", retryAfterCap, true},   // clamped
		{" 7 ", 7 * time.Second, true}, // trimmed
	}
	for _, c := range cases {
		got, ok := retryAfterDelay(retryAfterResp(c.v))
		if ok != c.ok || got != c.want {
			t.Errorf("Retry-After %q: got (%v, %v), want (%v, %v)", c.v, got, ok, c.want, c.ok)
		}
	}
	if _, ok := retryAfterDelay(nil); ok {
		t.Error("nil response should not yield a Retry-After delay")
	}
}

func TestRetryAfterDelayHTTPDate(t *testing.T) {
	future := time.Now().Add(3 * time.Second).UTC().Format(http.TimeFormat)
	got, ok := retryAfterDelay(retryAfterResp(future))
	if !ok {
		t.Fatal("expected HTTP-date form to be accepted")
	}
	if got < time.Second || got > 3*time.Second {
		t.Fatalf("delay = %v, want roughly 3s", got)
	}

	past := time.Now().Add(-time.Minute).UTC().Format(http.TimeFormat)
	got, ok = retryAfterDelay(retryAfterResp(past))
	if !ok || got != 0 {
		t.Fatalf("past date: got (%v, %v), want (0, true)", got, ok)
	}
}

func TestBackoffDelayJitterBounds(t *testing.T) {
	for attempt := 0; attempt < 8; attempt++ {
		base := 500 * time.Millisecond << attempt
		if base > 8*time.Second {
			base = 8 * time.Second
		}
		for i := 0; i < 50; i++ {
			d := backoffDelay(attempt)
			if d < base/2 || d > base {
				t.Fatalf("attempt %d: delay %v outside [%v, %v]", attempt, d, base/2, base)
			}
		}
	}
}

// TestDoStreamHonorsRetryAfter verifies the retry wait follows the server's
// header instead of the (much shorter) first backoff step.
func TestDoStreamHonorsRetryAfter(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	cfg := Config{HTTPClient: srv.Client(), MaxRetries: 1}
	start := time.Now()
	resp, err := doStream(context.Background(), cfg, srv.URL, []byte("{}"), func(*http.Request) {}, "test")
	if err != nil {
		t.Fatalf("doStream: %v", err)
	}
	resp.Body.Close()
	if calls != 2 {
		t.Fatalf("calls = %d, want 2", calls)
	}
	if elapsed := time.Since(start); elapsed < 900*time.Millisecond {
		t.Fatalf("elapsed = %v, want >= ~1s (Retry-After ignored?)", elapsed)
	}
}
