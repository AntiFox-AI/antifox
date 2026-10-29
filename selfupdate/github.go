package selfupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// latestURL is GitHub's "latest published release" endpoint (skips drafts/prereleases).
const latestURL = "https://api.github.com/repos/" + Repo + "/releases/latest"

const userAgent = "antifox-selfupdate"

// allowedHosts bounds every host the upgrade path may reach. With checkURL below, any
// redirect off this list fails — a first gate against DNS/MITM swapping the binary; the
// second gate is the SHA256SUMS comparison.
var allowedHosts = map[string]bool{
	"api.github.com":                       true,
	"github.com":                           true,
	"objects.githubusercontent.com":        true, // where release assets actually live
	"release-assets.githubusercontent.com": true,
	"raw.githubusercontent.com":            true,
}

// Release is the subset of a GitHub release we use.
type Release struct {
	TagName     string    `json:"tag_name"`
	Name        string    `json:"name"`
	Body        string    `json:"body"`
	Draft       bool      `json:"draft"`
	Prerelease  bool      `json:"prerelease"`
	PublishedAt time.Time `json:"published_at"`
	HTMLURL     string    `json:"html_url"`
	Assets      []Asset   `json:"assets"`
}

// Asset is one file attached to a release.
type Asset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
	Size int64  `json:"size"`
}

// FindAsset finds a release asset by name (case-insensitive).
func (r *Release) FindAsset(name string) (Asset, bool) {
	for _, a := range r.Assets {
		if strings.EqualFold(a.Name, name) {
			return a, true
		}
	}
	return Asset{}, false
}

// NewClient builds an HTTP client that only talks to GitHub hosts over verified TLS.
// proxy (or, when empty, ANTIFOX_UPDATE_PROXY / HTTPS_PROXY) routes the request out —
// useful where GitHub is only reachable through an egress proxy. We do NOT reuse the
// default transport: the upgrade path must force TLS verification regardless of any
// InsecureSkipVerify set elsewhere.
func NewClient(proxy string) *http.Client {
	tr := &http.Transport{ForceAttemptHTTP2: true, TLSHandshakeTimeout: 15 * time.Second}
	if p := strings.TrimSpace(proxy); p == "" {
		p = strings.TrimSpace(os.Getenv("ANTIFOX_UPDATE_PROXY"))
		if p == "" {
			p = strings.TrimSpace(os.Getenv("HTTPS_PROXY"))
		}
		proxy = p
	}
	if proxy != "" {
		if pu, err := url.Parse(proxy); err == nil {
			tr.Proxy = http.ProxyURL(pu)
		}
	}
	return &http.Client{
		Transport: tr,
		Timeout:   30 * time.Minute, // whole-archive download; no per-request deadline
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			return checkURL(req.URL)
		},
	}
}

// checkURL enforces https + the host allowlist.
func checkURL(u *url.URL) error {
	if u.Scheme != "https" {
		return fmt.Errorf("refusing non-HTTPS URL: %s://%s", u.Scheme, u.Host)
	}
	if !allowedHosts[strings.ToLower(u.Hostname())] {
		return fmt.Errorf("refusing non-GitHub host: %s", u.Hostname())
	}
	return nil
}

// FetchLatest queries the latest published release.
func FetchLatest(ctx context.Context, c *http.Client) (*Release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, latestURL, nil)
	if err != nil {
		return nil, err
	}
	if err := checkURL(req.URL); err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("reach GitHub failed (you can set a proxy via ANTIFOX_UPDATE_PROXY): %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusForbidden, http.StatusTooManyRequests:
		// Unauthenticated GitHub API is 60 req/hour/IP — easy to hit behind a shared egress.
		return nil, fmt.Errorf("GitHub API rate-limited (60/hour), try again later")
	case http.StatusNotFound:
		return nil, fmt.Errorf("repo %s has no published release yet", Repo)
	default:
		return nil, fmt.Errorf("GitHub returned %d", resp.StatusCode)
	}

	var rel Release
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, fmt.Errorf("parse release: %w", err)
	}
	if strings.TrimSpace(rel.TagName) == "" {
		return nil, fmt.Errorf("release is missing a tag")
	}
	return &rel, nil
}
