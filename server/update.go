package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"runtime"
	"sync"
	"time"

	"antifox/selfupdate"
)

// HTTP face for one-click updates. The actual download/verify/swap lives in the
// selfupdate package; this file owns the auth boundary, concurrency mutex, progress
// broadcast, and telling main "time to exit for a restart".
//
// The restart is not performed here: after staging, the process exits with
// selfupdate.ExitRestart and a supervisor (start.sh / systemd RestartForceExitStatus=75
// / the Docker entrypoint loop) relaunches it.

// BuildVersion is the backend version, injected from cmd/antifox via -ldflags. "dev"
// for local builds, which disables one-click update (CompareVersions is "not comparable").
var BuildVersion = "dev"

// ── restart signaling ──
var (
	restartOnce sync.Once
	restartCh   = make(chan struct{})
)

// RestartRequested is closed when staging/rollback is ready and main should exit with
// ExitRestart.
func RestartRequested() <-chan struct{} { return restartCh }

func requestRestart() { restartOnce.Do(func() { close(restartCh) }) }

// ── boot state (how the last upgrade went) ──
var (
	bootStateMu sync.Mutex
	bootState   selfupdate.State
)

// SetBootUpdateState is called once by main at startup.
func SetBootUpdateState(st selfupdate.State) {
	bootStateMu.Lock()
	bootState = st
	bootStateMu.Unlock()
}

func bootUpdateState() selfupdate.State {
	bootStateMu.Lock()
	defer bootStateMu.Unlock()
	return bootState
}

// ── release lookup cache ──
// The top-bar "update available" hint checks on every full page load, but the
// unauthenticated GitHub API is 60/hour/IP — so cache it. An explicit "check" forces a refresh.
type releaseCache struct {
	mu  sync.Mutex
	rel *selfupdate.Release
	err error
	at  time.Time
}

const (
	releaseTTL     = 30 * time.Minute
	releaseErrTTL  = 2 * time.Minute // cache failures briefly so a GitHub outage doesn't hang every load
	releaseTimeout = 20 * time.Second
)

var relCache = &releaseCache{}

func (c *releaseCache) get(ctx context.Context, client *http.Client, force bool) (*selfupdate.Release, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !force {
		ttl := releaseTTL
		if c.err != nil {
			ttl = releaseErrTTL
		}
		if !c.at.IsZero() && time.Since(c.at) < ttl {
			return c.rel, c.err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, releaseTimeout)
	defer cancel()
	rel, err := selfupdate.FetchLatest(ctx, client)
	// A cancelled request (user closed the tab) isn't a GitHub problem — don't cache it.
	if err != nil && ctx.Err() != nil && errors.Is(ctx.Err(), context.Canceled) {
		return c.rel, err
	}
	c.rel, c.err, c.at = rel, err, time.Now()
	return rel, err
}

// ── progress hub (SSE) ──
type updateProgress struct {
	Phase   selfupdate.Phase `json:"phase"`
	Percent int              `json:"percent"` // meaningful while downloading; -1 otherwise
	Message string           `json:"message"`
	Version string           `json:"version,omitempty"`
	Error   string           `json:"error,omitempty"`
}

type updateHub struct {
	mu      sync.Mutex
	running bool // also the apply mutex: a second /apply while running → 409
	cur     updateProgress
	subs    map[chan updateProgress]struct{}
}

var updHub = &updateHub{
	cur:  updateProgress{Phase: selfupdate.PhaseIdle, Percent: -1},
	subs: map[chan updateProgress]struct{}{},
}

func (h *updateHub) begin(version string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.running {
		return false
	}
	h.running = true
	h.cur = updateProgress{Phase: selfupdate.PhaseDownload, Percent: 0, Message: "preparing…", Version: version}
	h.fanout(h.cur)
	return true
}

func (h *updateHub) finish(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.running = false
	if err != nil {
		h.cur = updateProgress{Phase: selfupdate.PhaseFailed, Percent: -1, Message: "update failed", Error: err.Error(), Version: h.cur.Version}
	} else {
		h.cur = updateProgress{Phase: selfupdate.PhaseStaged, Percent: 100, Message: "new version ready, restarting…", Version: h.cur.Version}
	}
	h.fanout(h.cur)
}

func (h *updateHub) publish(ph selfupdate.Phase, pct int, msg string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.cur = updateProgress{Phase: ph, Percent: pct, Message: msg, Version: h.cur.Version}
	h.fanout(h.cur)
}

// fanout must be called with h.mu held. Subscriber channels are buffered; a full one is
// skipped — progress is droppable, and a stuck SSE connection must never block the update.
func (h *updateHub) fanout(p updateProgress) {
	for ch := range h.subs {
		select {
		case ch <- p:
		default:
		}
	}
}

func (h *updateHub) snapshot() (updateProgress, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.cur, h.running
}

func (h *updateHub) subscribe() (<-chan updateProgress, func()) {
	ch := make(chan updateProgress, 64)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subs, ch)
			h.mu.Unlock()
			close(ch)
		})
	}
}

// updateClient builds the GitHub client (direct, or via ANTIFOX_UPDATE_PROXY/HTTPS_PROXY).
func updateClient() *http.Client { return selfupdate.NewClient("") }

// GET /api/update/check — latest release vs current version.
func (s *Server) updateCheck(w http.ResponseWriter, r *http.Request) {
	mode := "binary"
	if selfupdate.InDocker() {
		mode = "docker"
	}
	boot := bootUpdateState()
	out := map[string]any{
		"current":     BuildVersion,
		"mode":        mode,
		"os":          runtime.GOOS,
		"arch":        runtime.GOARCH,
		"has_backup":  selfupdate.HasBackup(),
		"repo":        selfupdate.Repo,
		"boot_notice": boot.Detail,
		"rolled_back": boot.RolledBack,
	}
	force := r.URL.Query().Get("force") != ""
	rel, err := relCache.get(r.Context(), updateClient(), force)
	if err != nil {
		out["error"] = err.Error()
		writeJSON(w, 200, out)
		return
	}
	out["latest"] = rel.TagName
	out["notes"] = rel.Body
	out["html_url"] = rel.HTMLURL
	if !rel.PublishedAt.IsZero() {
		out["published_at"] = rel.PublishedAt.Format(time.RFC3339)
	}
	asset := selfupdate.AssetName(rel.TagName, runtime.GOOS, runtime.GOARCH)
	out["asset"] = asset
	if a, ok := rel.FindAsset(asset); ok {
		out["asset_available"] = true
		out["size"] = a.Size
	} else {
		out["asset_available"] = false
	}
	cmp, comparable := selfupdate.CompareVersions(BuildVersion, rel.TagName)
	out["comparable"] = comparable
	out["has_update"] = comparable && cmp < 0
	if !comparable {
		out["reason"] = fmt.Sprintf("current version %q is not a released version; one-click update is disabled", BuildVersion)
	}
	writeJSON(w, 200, out)
}

// POST /api/update/apply — download + stage, then exit for the supervisor to restart.
// Returns 202 immediately; the (minutes-long) download runs in the background on s.ctx.
func (s *Server) updateApply(w http.ResponseWriter, r *http.Request) {
	if selfupdate.InDocker() {
		writeErr(w, 400, "running in Docker — update by pulling a new image (docker compose pull), not in-place")
		return
	}
	rel, err := relCache.get(r.Context(), updateClient(), false)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	cmp, comparable := selfupdate.CompareVersions(BuildVersion, rel.TagName)
	if !comparable {
		writeErr(w, 400, fmt.Sprintf("current version %q is not a released version; one-click update is disabled", BuildVersion))
		return
	}
	if cmp >= 0 {
		writeErr(w, 400, fmt.Sprintf("already on the latest version %s", BuildVersion))
		return
	}
	if !updHub.begin(rel.TagName) {
		writeErr(w, 409, "an update is already in progress")
		return
	}
	go func() {
		// s.ctx, not the request ctx: the HTTP response returns immediately and would
		// otherwise cancel the download.
		err := selfupdate.Stage(s.ctx, updateClient(), rel, BuildVersion, func(ph selfupdate.Phase, pct int, msg string) {
			updHub.publish(ph, pct, msg)
		})
		updHub.finish(err)
		if err != nil {
			log.Printf("[update] update failed: %v", err)
			return
		}
		log.Printf("[update] %s → %s staged, exiting to complete the swap", BuildVersion, rel.TagName)
		time.Sleep(1500 * time.Millisecond) // let the last progress reach the client
		requestRestart()
	}()
	writeJSON(w, 202, map[string]any{"ok": true, "target": rel.TagName})
}

// POST /api/update/rollback — go back to the previous version (the pre-swap backup).
func (s *Server) updateRollback(w http.ResponseWriter, r *http.Request) {
	if _, running := updHub.snapshot(); running {
		writeErr(w, 409, "an update is in progress; cannot roll back")
		return
	}
	if err := selfupdate.Rollback(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	log.Printf("[update] rolled back to the previous version, exiting to complete the switch")
	writeJSON(w, 202, map[string]any{"ok": true})
	go func() {
		time.Sleep(500 * time.Millisecond)
		requestRestart()
	}()
}

// GET /api/update/stream — SSE progress. Auth via ?token= (EventSource can't set headers).
func (s *Server) updateStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	send := func(p updateProgress) {
		b, _ := json.Marshal(p)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}
	cur, _ := updHub.snapshot()
	send(cur) // current state immediately, so a late subscriber isn't blank

	ch, cancel := updHub.subscribe()
	defer cancel()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case p, ok := <-ch:
			if !ok {
				return
			}
			send(p)
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}
