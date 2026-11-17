package llm

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// doStream sends the streaming request with retries on transient failures and
// returns a 200 response (caller reads + closes the body). Only the request
// establishment phase is retried — connection reset / timeout / 429 / 5xx before
// any stream data is consumed — so retrying is safe (it can't duplicate
// partially-streamed assistant output). A mid-stream drop is the caller's to
// surface. Context cancellation is never retried and interrupts the backoff.
//
// Waits between attempts honour the server's Retry-After header (delta-seconds
// or HTTP-date, capped at retryAfterCap) when present; otherwise an
// equal-jitter exponential backoff is used.
func doStream(ctx context.Context, cfg Config, url string, body []byte, setHeaders func(*http.Request), errPrefix string) (*http.Response, error) {
	// Rate limit once per logical request (outside the retry loop, so retries do
	// not consume additional tokens). Shared across all callers of this provider.
	if err := cfg.limiter.Wait(ctx); err != nil {
		return nil, err
	}
	retries := cfg.retries()
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		setHeaders(req)

		resp, err := cfg.HTTPClient.Do(req)
		if err == nil && resp.StatusCode == http.StatusOK {
			return resp, nil
		}

		retryable := false
		switch {
		case err != nil:
			retryable = ctx.Err() == nil // transient network error (not cancellation)
		case isRetryableStatus(resp.StatusCode):
			retryable = true
		}
		if attempt >= retries || !retryable {
			if err != nil {
				return nil, err
			}
			data, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			return nil, fmt.Errorf("%s: status %d: %s", errPrefix, resp.StatusCode, strings.TrimSpace(string(data)))
		}
		// A server-supplied Retry-After wins over our own backoff (capacity-aware
		// gateways use it to say exactly how long to stay away).
		delay := backoffDelay(attempt)
		if d, ok := retryAfterDelay(resp); ok {
			delay = d
		}
		if resp != nil {
			resp.Body.Close()
		}
		if !sleepCtx(ctx, delay) {
			return nil, ctx.Err() // context cancelled during backoff
		}
	}
}

func isRetryableStatus(code int) bool {
	switch code {
	case http.StatusRequestTimeout, // 408
		http.StatusTooManyRequests,     // 429
		http.StatusInternalServerError, // 500
		http.StatusBadGateway,          // 502
		http.StatusServiceUnavailable,  // 503
		http.StatusGatewayTimeout:      // 504
		return true
	}
	return false
}

// retryAfterCap bounds a server-requested wait so a pathological header value
// cannot stall a task indefinitely. Long waits beyond this are clamped and the
// retry proceeds; the next attempt surfaces a fresh error if the peer is still
// unavailable.
const retryAfterCap = 60 * time.Second

// retryAfterDelay reads Retry-After from a retryable response, accepting both
// forms defined by RFC 9110: delta-seconds and an HTTP-date. ok=false when the
// header is absent or unparseable, in which case the caller falls back to its
// own backoff. Negative delta-seconds are rejected; a past HTTP-date means
// "retry now" and yields 0.
func retryAfterDelay(resp *http.Response) (time.Duration, bool) {
	if resp == nil {
		return 0, false
	}
	v := strings.TrimSpace(resp.Header.Get("Retry-After"))
	if v == "" {
		return 0, false
	}
	var d time.Duration
	if secs, err := strconv.Atoi(v); err == nil {
		if secs < 0 {
			return 0, false
		}
		d = time.Duration(secs) * time.Second
	} else if t, err := http.ParseTime(v); err == nil {
		d = time.Until(t)
		if d < 0 {
			d = 0
		}
	} else {
		return 0, false
	}
	if d > retryAfterCap {
		d = retryAfterCap
	}
	return d, true
}

// backoffDelay returns the wait before retry number attempt (0-based) using
// "equal jitter": half fixed, half random. Concurrent agents sharing a provider
// therefore don't retry in lockstep after a shared outage. The base doubles per
// attempt (0.5s, 1s, 2s, … capped at 8s), so the result stays within
// [base/2, base].
func backoffDelay(attempt int) time.Duration {
	base := 500 * time.Millisecond << attempt
	if base > 8*time.Second || base <= 0 { // cap, and guard shift overflow
		base = 8 * time.Second
	}
	half := base / 2
	return half + time.Duration(rand.Int64N(int64(half)+1))
}

// backoffSleep waits a jittered exponential backoff, interruptible by ctx.
// Returns false if the context was cancelled.
func backoffSleep(ctx context.Context, attempt int) bool {
	return sleepCtx(ctx, backoffDelay(attempt))
}

// sleepCtx waits for d, returning false if ctx is cancelled first. A
// non-positive duration is a no-op.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
