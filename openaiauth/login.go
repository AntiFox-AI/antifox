package openaiauth

import (
	"context"
	"errors"
	"fmt"
	"html"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// loginTTL bounds how long a started login waits for the browser.
const loginTTL = 10 * time.Minute

// Login status values reported to the UI.
const (
	StatusPending = "pending"
	StatusDone    = "done"
	StatusError   = "error"
)

type login struct {
	verifier string
	created  time.Time
	status   string
	err      string
	cred     *Credential
}

// LoginStatus is the UI-facing view of a login attempt.
type LoginStatus struct {
	Status string `json:"status"`
	Email  string `json:"email,omitempty"`
	Plan   string `json:"plan,omitempty"`
	Error  string `json:"error,omitempty"`
}

// LoginManager runs browser logins: it creates PKCE sessions, runs the
// temporary callback listener on the registered redirect port, and exchanges
// the returned code for tokens.
type LoginManager struct {
	addr   string // callback listen address, e.g. 127.0.0.1:1455 (0.0.0.0:1455 in Docker)
	client *http.Client

	mu       sync.Mutex
	sessions map[string]*login
	srv      *http.Server
}

// NewLoginManager builds a manager listening for callbacks on addr.
func NewLoginManager(addr string, client *http.Client) *LoginManager {
	if addr == "" {
		addr = "127.0.0.1:1455"
	}
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &LoginManager{addr: addr, client: client, sessions: map[string]*login{}}
}

// Start begins a login. It returns the URL to open in the browser and the state
// that identifies this attempt. listenErr is non-empty when the automatic
// callback listener could not start; the paste-URL fallback still works.
func (m *LoginManager) Start() (authURL, state, listenErr string) {
	verifier, challenge := pkce()
	state = randString(32)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gcLocked()
	m.sessions[state] = &login{verifier: verifier, created: time.Now(), status: StatusPending}
	if err := m.ensureListenerLocked(); err != nil {
		listenErr = err.Error()
	}
	return AuthorizeURL(state, challenge), state, listenErr
}

// Status reports the state of a login attempt.
func (m *LoginManager) Status(state string) LoginStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	l := m.sessions[state]
	if l == nil {
		return LoginStatus{Status: StatusError, Error: "login session not found or expired — start again"}
	}
	st := LoginStatus{Status: l.status, Error: l.err}
	if l.cred != nil {
		st.Email, st.Plan = l.cred.Email, l.cred.Plan
	}
	return st
}

// Peek returns the credential of a finished login without consuming it.
func (m *LoginManager) Peek(state string) (*Credential, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if l := m.sessions[state]; l != nil && l.cred != nil {
		c := *l.cred
		return &c, true
	}
	return nil, false
}

// Take returns and consumes the credential of a finished login.
func (m *LoginManager) Take(state string) (*Credential, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l := m.sessions[state]
	if l == nil || l.cred == nil {
		return nil, false
	}
	delete(m.sessions, state)
	m.maybeStopLocked()
	return l.cred, true
}

// CompleteFromURL finishes a login from the redirect URL the user pasted (the
// fallback when the browser could not reach the callback listener).
func (m *LoginManager) CompleteFromURL(ctx context.Context, state, redirect string) LoginStatus {
	u, err := url.Parse(strings.TrimSpace(redirect))
	if err != nil || u.Query().Get("code") == "" {
		return LoginStatus{Status: StatusError, Error: "that URL has no ?code= — copy the full address from the browser after signing in"}
	}
	q := u.Query()
	if s := q.Get("state"); s != "" && s != state {
		return LoginStatus{Status: StatusError, Error: "that URL belongs to a different sign-in attempt"}
	}
	m.complete(ctx, state, q.Get("code"), q.Get("error_description"))
	return m.Status(state)
}

// complete exchanges the code and records the outcome on the session.
func (m *LoginManager) complete(ctx context.Context, state, code, oauthErr string) error {
	m.mu.Lock()
	l := m.sessions[state]
	if l == nil {
		m.mu.Unlock()
		return errors.New("unknown or expired login session")
	}
	if l.status == StatusDone {
		m.mu.Unlock()
		return nil
	}
	verifier := l.verifier
	m.mu.Unlock()

	var cred *Credential
	var err error
	if oauthErr != "" {
		err = errors.New(oauthErr)
	} else {
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		cred, err = Exchange(cctx, m.client, code, verifier)
		cancel()
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil {
		l.status, l.err = StatusError, err.Error()
		log.Printf("[openaiauth] ChatGPT sign-in failed: %v", err)
	} else {
		l.status, l.cred = StatusDone, cred
		log.Printf("[openaiauth] ChatGPT sign-in ok: %s (%s)", cred.Email, cred.Plan)
	}
	m.maybeStopLocked()
	return err
}

// ---- callback listener ----

func (m *LoginManager) ensureListenerLocked() error {
	if m.srv != nil {
		return nil
	}
	ln, err := net.Listen("tcp", m.addr)
	if err != nil {
		return fmt.Errorf("cannot listen on %s for the sign-in callback (%v) — paste the redirect URL instead", m.addr, err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/callback", m.handleCallback)
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	m.srv = srv
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("[openaiauth] callback listener: %v", err)
		}
	}()
	log.Printf("[openaiauth] ChatGPT sign-in callback listening on %s", m.addr)
	// Safety net: shut down after the TTL even if the browser never returns.
	time.AfterFunc(loginTTL+time.Minute, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.gcLocked()
		m.maybeStopLocked()
	})
	return nil
}

// maybeStopLocked stops the listener once no login is waiting for a callback.
func (m *LoginManager) maybeStopLocked() {
	if m.srv == nil {
		return
	}
	for _, l := range m.sessions {
		if l.status == StatusPending && time.Since(l.created) < loginTTL {
			return
		}
	}
	srv := m.srv
	m.srv = nil
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx) // lets the in-flight callback response finish
		log.Printf("[openaiauth] callback listener stopped")
	}()
}

func (m *LoginManager) gcLocked() {
	for k, l := range m.sessions {
		if time.Since(l.created) > loginTTL+30*time.Minute {
			delete(m.sessions, k)
		}
	}
}

func (m *LoginManager) handleCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	oauthErr := q.Get("error_description")
	if oauthErr == "" {
		oauthErr = q.Get("error")
	}
	err := m.complete(r.Context(), q.Get("state"), q.Get("code"), oauthErr)
	w.Header().Set("content-type", "text/html; charset=utf-8")
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintf(w, callbackPage, "Sign-in failed", html.EscapeString(err.Error())+"<br>Return to AntiFox and try again.", "")
		return
	}
	fmt.Fprintf(w, callbackPage, "Signed in to ChatGPT", "You can close this tab and return to AntiFox.", "<script>setTimeout(()=>window.close(),1500)</script>")
}

const callbackPage = `<!doctype html><html><head><meta charset="utf-8"><title>AntiFox · ChatGPT sign-in</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0b0c;color:#eee}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem}p{color:#aaa}</style></head>
<body><main><h1>%s</h1><p>%s</p></main>%s</body></html>`
