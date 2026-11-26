package openaiauth

import (
	"context"
	"log"
	"net/http"
	"sync"
	"time"
)

// refreshSkew refreshes the access token this long before it expires.
const refreshSkew = 5 * time.Minute

// Source hands out a valid access token for one ChatGPT account, refreshing it
// when it is about to expire. It implements llm.TokenSource.
//
// There is exactly one Source per account per process (see SourceFor): OpenAI
// rotates refresh tokens, so two independent refreshers for the same account
// would invalidate each other.
type Source struct {
	mu     sync.Mutex
	cred   *Credential
	client *http.Client
}

// Token returns (access token, account id). force=true refreshes regardless of
// expiry (used after a 401).
func (s *Source) Token(ctx context.Context, force bool) (string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if force || s.cred.AccessToken == "" || time.Until(s.cred.ExpiresAt) < refreshSkew {
		nc, err := Refresh(ctx, s.client, s.cred)
		if err != nil {
			return "", "", err
		}
		s.cred = nc
		persist(nc)
	}
	return s.cred.AccessToken, s.cred.AccountID, nil
}

// Credential returns a copy of the current credential.
func (s *Source) Credential() Credential {
	s.mu.Lock()
	defer s.mu.Unlock()
	return *s.cred
}

var (
	regMu     sync.Mutex
	registry  = map[string]*Source{} // account id → source
	persistFn func(c *Credential)
)

// SetPersister registers the callback that saves a refreshed credential (the
// server writes it back to every profile signed in to that account).
func SetPersister(fn func(c *Credential)) {
	regMu.Lock()
	persistFn = fn
	regMu.Unlock()
}

func persist(c *Credential) {
	regMu.Lock()
	fn := persistFn
	regMu.Unlock()
	if fn != nil {
		cp := *c
		go fn(&cp)
	} else {
		log.Printf("[openaiauth] refreshed ChatGPT token for %s (not persisted: no persister)", c.Email)
	}
}

// SourceFor returns the process-wide Source for the account in credJSON. A
// newer stored credential (e.g. after signing in again) replaces the cached one.
func SourceFor(credJSON string, client *http.Client) (*Source, error) {
	c, err := ParseCredential(credJSON)
	if err != nil {
		return nil, err
	}
	regMu.Lock()
	defer regMu.Unlock()
	if s := registry[c.AccountID]; s != nil {
		s.mu.Lock()
		if c.RefreshToken != s.cred.RefreshToken && c.ExpiresAt.After(s.cred.ExpiresAt) {
			s.cred = c
		}
		s.mu.Unlock()
		return s, nil
	}
	if client == nil {
		client = http.DefaultClient
	}
	s := &Source{cred: c, client: client}
	registry[c.AccountID] = s
	return s, nil
}

// Latest returns the freshest known credential JSON for the account in credJSON
// (the cached source may have refreshed it since credJSON was produced).
func Latest(credJSON string) string {
	c, err := ParseCredential(credJSON)
	if err != nil {
		return credJSON
	}
	regMu.Lock()
	s := registry[c.AccountID]
	regMu.Unlock()
	if s == nil {
		return credJSON
	}
	cur := s.Credential()
	if cur.ExpiresAt.After(c.ExpiresAt) {
		return cur.JSON()
	}
	return credJSON
}
