package server

import (
	"log"
	"net/http"
	"os"
	"strings"

	"antifox/openaiauth"
)

// "Sign in with ChatGPT" for openai-codex LLM profiles.
//
// Flow: the UI calls start → opens auth_url in a new browser tab → the user signs
// in at auth.openai.com → OpenAI redirects to http://localhost:1455/auth/callback,
// served by a temporary listener (openaiauth.LoginManager) → the UI polls status
// until "done" → the profile is saved with oauth_state, and the server swaps in the
// credential (tokens never reach the browser). If the browser can't reach port 1455
// (remote server), the user pastes the final redirect URL into complete instead.
//
// ANTIFOX_OAUTH_CALLBACK_ADDR sets the listener address (default 127.0.0.1:1455;
// Docker uses 0.0.0.0:1455 with the port published to the host's loopback only).

func (s *Server) initCodexAuth() {
	s.codexLogin = openaiauth.NewLoginManager(strings.TrimSpace(os.Getenv("ANTIFOX_OAUTH_CALLBACK_ADDR")), nil)
	if s.m == nil || s.m.pg == nil {
		return
	}
	pg := s.m.pg
	openaiauth.SetPersister(func(c *openaiauth.Credential) {
		if err := pg.UpdateCodexCredential(c.AccountID, c.JSON(), c.Hint()); err != nil {
			log.Printf("[openaiauth] saving refreshed ChatGPT token failed: %v", err)
		}
	})
}

// POST /api/llm/oauth/openai/start → {auth_url, state, listen_error?}
func (s *Server) codexAuthStart(w http.ResponseWriter, r *http.Request) {
	authURL, state, listenErr := s.codexLogin.Start()
	out := map[string]any{"auth_url": authURL, "state": state, "redirect_uri": openaiauth.RedirectURI}
	if listenErr != "" {
		out["listen_error"] = listenErr
	}
	writeJSON(w, 200, out)
}

// GET /api/llm/oauth/openai/status?state=… → {status: pending|done|error, email, plan, error}
func (s *Server) codexAuthStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.codexLogin.Status(r.URL.Query().Get("state")))
}

// POST /api/llm/oauth/openai/complete {state, redirect_url} — paste-URL fallback.
func (s *Server) codexAuthComplete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		State       string `json:"state"`
		RedirectURL string `json:"redirect_url"`
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, s.codexLogin.CompleteFromURL(r.Context(), body.State, body.RedirectURL))
}

// codexCredentialFor resolves the credential to store when saving an openai-codex
// profile with a finished sign-in. Returns ok=false if the sign-in isn't done.
func (s *Server) codexCredentialFor(state string) (credJSON, hint string, ok bool) {
	c, ok := s.codexLogin.Take(state)
	if !ok {
		return "", "", false
	}
	// A connection test may already have refreshed this account's token.
	credJSON = openaiauth.Latest(c.JSON())
	if nc, err := openaiauth.ParseCredential(credJSON); err == nil {
		c = nc
	}
	return credJSON, c.Hint(), true
}
