// Package openaiauth implements "Sign in with ChatGPT": the OAuth 2.0 + PKCE flow
// against auth.openai.com that lets a ChatGPT Plus/Pro/Team subscription be used
// as an LLM backend (the same flow the Codex CLI uses), plus token storage and
// automatic refresh.
//
// The redirect URI is fixed by the OAuth client registration to
// http://localhost:1455/auth/callback, so login needs a short-lived listener on
// port 1455 (see LoginManager). When that port can't be reached from the
// browser (remote server), the user can paste the final redirect URL instead.
package openaiauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	Issuer      = "https://auth.openai.com"
	ClientID    = "app_EMoamEEZ73f0CkXaXp7hrann"
	RedirectURI = "http://localhost:1455/auth/callback"
	Scope       = "openid profile email offline_access"
	// CodexBaseURL is the ChatGPT-subscription Responses endpoint (provider appends /responses).
	CodexBaseURL = "https://chatgpt.com/backend-api/codex"
)

// Credential is what gets stored (as JSON) in llm_profiles.api_key for an
// openai-codex profile.
type Credential struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	IDToken      string    `json:"id_token,omitempty"`
	AccountID    string    `json:"account_id"`
	Email        string    `json:"email,omitempty"`
	Plan         string    `json:"plan,omitempty"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// JSON encodes the credential for storage.
func (c *Credential) JSON() string {
	b, _ := json.Marshal(c)
	return string(b)
}

// Hint is the human-readable label shown instead of a key hint.
func (c *Credential) Hint() string {
	h := "ChatGPT"
	if c.Plan != "" {
		h += " " + c.Plan
	}
	if c.Email != "" {
		h += " · " + c.Email
	}
	return h
}

// ParseCredential decodes a stored credential.
func ParseCredential(s string) (*Credential, error) {
	var c Credential
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &c); err != nil {
		return nil, fmt.Errorf("openaiauth: stored ChatGPT credential is not valid JSON — sign in again")
	}
	if c.RefreshToken == "" && c.AccessToken == "" {
		return nil, fmt.Errorf("openaiauth: stored ChatGPT credential is empty — sign in again")
	}
	return &c, nil
}

// pkce returns a random code_verifier and its S256 code_challenge.
func pkce() (verifier, challenge string) {
	verifier = randString(64)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

func randString(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)[:n]
}

// AuthorizeURL builds the browser URL that starts login.
func AuthorizeURL(state, challenge string) string {
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", ClientID)
	q.Set("redirect_uri", RedirectURI)
	q.Set("scope", Scope)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("id_token_add_organizations", "true")
	q.Set("codex_cli_simplified_flow", "true")
	q.Set("state", state)
	q.Set("originator", "codex_cli_rs")
	return Issuer + "/oauth/authorize?" + q.Encode()
}

type tokenResp struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
}

// Exchange trades an authorization code for tokens.
func Exchange(ctx context.Context, client *http.Client, code, verifier string) (*Credential, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", RedirectURI)
	form.Set("client_id", ClientID)
	form.Set("code_verifier", verifier)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, Issuer+"/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	tr, err := doToken(client, req)
	if err != nil {
		return nil, err
	}
	return credFrom(tr, nil)
}

// Refresh obtains a fresh access token. Fields the server omits (id_token,
// a non-rotated refresh_token) are carried over from prev.
func Refresh(ctx context.Context, client *http.Client, prev *Credential) (*Credential, error) {
	body, _ := json.Marshal(map[string]string{
		"client_id":     ClientID,
		"grant_type":    "refresh_token",
		"refresh_token": prev.RefreshToken,
		"scope":         "openid profile email",
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, Issuer+"/oauth/token", strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	tr, err := doToken(client, req)
	if err != nil {
		return nil, err
	}
	return credFrom(tr, prev)
}

func doToken(client *http.Client, req *http.Request) (*tokenResp, error) {
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openaiauth: token request: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("openaiauth: token endpoint status %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var tr tokenResp
	if err := json.Unmarshal(data, &tr); err != nil {
		return nil, fmt.Errorf("openaiauth: decode token response: %w", err)
	}
	if tr.AccessToken == "" {
		return nil, fmt.Errorf("openaiauth: token response has no access_token")
	}
	return &tr, nil
}

func credFrom(tr *tokenResp, prev *Credential) (*Credential, error) {
	c := &Credential{AccessToken: tr.AccessToken, RefreshToken: tr.RefreshToken, IDToken: tr.IDToken}
	if prev != nil {
		if c.RefreshToken == "" {
			c.RefreshToken = prev.RefreshToken
		}
		if c.IDToken == "" {
			c.IDToken = prev.IDToken
		}
		c.AccountID, c.Email, c.Plan = prev.AccountID, prev.Email, prev.Plan
	}
	// Identity: prefer id_token claims, fall back to the access token's.
	for _, tok := range []string{c.IDToken, c.AccessToken} {
		cl := jwtClaims(tok)
		if cl == nil {
			continue
		}
		if e, _ := cl["email"].(string); e != "" && c.Email == "" {
			c.Email = e
		}
		if auth, ok := cl["https://api.openai.com/auth"].(map[string]any); ok {
			if a, _ := auth["chatgpt_account_id"].(string); a != "" && c.AccountID == "" {
				c.AccountID = a
			}
			if p, _ := auth["chatgpt_plan_type"].(string); p != "" && c.Plan == "" {
				c.Plan = p
			}
		}
	}
	switch {
	case tr.ExpiresIn > 0:
		c.ExpiresAt = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)
	default:
		if cl := jwtClaims(c.AccessToken); cl != nil {
			if exp, ok := cl["exp"].(float64); ok {
				c.ExpiresAt = time.Unix(int64(exp), 0)
			}
		}
		if c.ExpiresAt.IsZero() {
			c.ExpiresAt = time.Now().Add(time.Hour)
		}
	}
	if c.AccountID == "" {
		return nil, fmt.Errorf("openaiauth: signed in, but no ChatGPT account id in the token — is this account on a ChatGPT plan?")
	}
	return c, nil
}

// jwtClaims decodes a JWT payload without verifying it (we only read our own
// tokens, fresh from the token endpoint over TLS).
func jwtClaims(tok string) map[string]any {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}
