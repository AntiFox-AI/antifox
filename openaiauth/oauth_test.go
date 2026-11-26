package openaiauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func fakeJWT(claims map[string]any) string {
	b, _ := json.Marshal(claims)
	return "e30." + base64.RawURLEncoding.EncodeToString(b) + ".sig"
}

func TestPKCEAndAuthorizeURL(t *testing.T) {
	v, c := pkce()
	sum := sha256.Sum256([]byte(v))
	if c != base64.RawURLEncoding.EncodeToString(sum[:]) || len(v) != 64 {
		t.Fatal("bad PKCE pair")
	}
	u, err := url.Parse(AuthorizeURL("st", c))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if q.Get("client_id") != ClientID || q.Get("redirect_uri") != RedirectURI || q.Get("code_challenge_method") != "S256" || q.Get("state") != "st" {
		t.Fatalf("bad authorize url: %s", u)
	}
}

func TestCredFromClaims(t *testing.T) {
	id := fakeJWT(map[string]any{
		"email":                       "a@example.com",
		"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "acct-9", "chatgpt_plan_type": "pro"},
	})
	c, err := credFrom(&tokenResp{IDToken: id, AccessToken: "x.y.z", RefreshToken: "r1", ExpiresIn: 3600}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.AccountID != "acct-9" || c.Email != "a@example.com" || c.Plan != "pro" || time.Until(c.ExpiresAt) < 59*time.Minute {
		t.Fatalf("unexpected credential %+v", c)
	}
	if !strings.Contains(c.Hint(), "a@example.com") {
		t.Errorf("hint = %q", c.Hint())
	}
	// Refresh response without id_token / refresh_token keeps the previous ones.
	n, err := credFrom(&tokenResp{AccessToken: "x.y.z", ExpiresIn: 60}, c)
	if err != nil || n.RefreshToken != "r1" || n.AccountID != "acct-9" {
		t.Fatalf("refresh carry-over failed: %+v %v", n, err)
	}
	if _, err := credFrom(&tokenResp{AccessToken: "x.y.z"}, nil); err == nil {
		t.Fatal("expected error when no account id")
	}
}

func TestLoginPasteFallbackRejectsWrongState(t *testing.T) {
	m := NewLoginManager("127.0.0.1:0", nil)
	_, state, _ := m.Start()
	st := m.CompleteFromURL(context.Background(), state, "http://localhost:1455/auth/callback?code=abc&state=other")
	if st.Status != StatusError || !strings.Contains(st.Error, "different") {
		t.Fatalf("status = %+v", st)
	}
	if st := m.CompleteFromURL(context.Background(), state, "not a url"); st.Status != StatusError {
		t.Fatalf("status = %+v", st)
	}
	if s := m.Status("nope"); s.Status != StatusError {
		t.Fatal("unknown state should be an error")
	}
}

func TestSourceForSharesPerAccount(t *testing.T) {
	c := &Credential{AccessToken: "a", RefreshToken: "r", AccountID: "acct-share", ExpiresAt: time.Now().Add(time.Hour)}
	s1, err := SourceFor(c.JSON(), nil)
	if err != nil {
		t.Fatal(err)
	}
	s2, _ := SourceFor(c.JSON(), nil)
	if s1 != s2 {
		t.Fatal("same account must share one Source")
	}
	tok, acct, err := s1.Token(context.Background(), false)
	if err != nil || tok != "a" || acct != "acct-share" {
		t.Fatalf("token = %q %q %v", tok, acct, err)
	}
	// A re-login (newer credential) replaces the cached one.
	n := *c
	n.RefreshToken, n.AccessToken, n.ExpiresAt = "r2", "b", time.Now().Add(2*time.Hour)
	_, _ = SourceFor(n.JSON(), nil)
	if tok, _, _ := s1.Token(context.Background(), false); tok != "b" {
		t.Fatalf("expected replaced token, got %q", tok)
	}
	if !strings.Contains(Latest(c.JSON()), `"b"`) {
		t.Error("Latest should return the newer credential")
	}
}

func TestCallbackHandler(t *testing.T) {
	m := NewLoginManager("127.0.0.1:0", nil)
	_, state, _ := m.Start()
	defer func() { m.mu.Lock(); m.sessions = map[string]*login{}; m.maybeStopLocked(); m.mu.Unlock() }()

	// Unknown state → 400 error page, real session untouched.
	rec := httptest.NewRecorder()
	m.handleCallback(rec, httptest.NewRequest("GET", "/auth/callback?code=x&state=bogus", nil))
	if rec.Code != 400 || m.Status(state).Status != StatusPending {
		t.Fatalf("bogus state: code=%d status=%v", rec.Code, m.Status(state))
	}
	// User denied consent at OpenAI → session becomes an error.
	rec = httptest.NewRecorder()
	m.handleCallback(rec, httptest.NewRequest("GET", "/auth/callback?error=access_denied&state="+state, nil))
	if rec.Code != 400 || m.Status(state).Status != StatusError || !strings.Contains(m.Status(state).Error, "access_denied") {
		t.Fatalf("denied: code=%d status=%+v", rec.Code, m.Status(state))
	}
	if _, ok := m.Take(state); ok {
		t.Fatal("failed login must not yield a credential")
	}
}
