// Package selfupdate gives AntiFox a one-click, in-place upgrade: it pulls the
// latest release binary from GitHub, verifies it (SHA256 + smoke test), stages it,
// and atomically swaps it in on the next start — with automatic rollback if the new
// binary won't boot. User data is never touched (it lives in PostgreSQL + the data
// dir, wholly separate from the executable).
//
// The process restart is NOT done by this process. After staging a new binary the
// server exits with ExitRestart; a thin supervisor (start.sh / systemd with
// RestartForceExitStatus=75 / the Docker entrypoint loop) relaunches it, and the
// next boot's Bootstrap performs the swap. Keeping download/verify/swap in Go (not
// the shell) means the one step that must never go wrong — putting a runnable binary
// in place — has a single, tested implementation.
//
// One full upgrade spans three starts:
//
//	① running server: /api/update/apply downloads + verifies → stages antifox.new → exit 75
//	② supervisor relaunches old binary: Bootstrap sees antifox.new → verify + smoke → swap → exit 75
//	③ supervisor relaunches (now the new binary): Bootstrap records an attempt; once it
//	   survives SettleDelay the upgrade marker is cleared and the upgrade is confirmed
//
// Any failure falls back to the old binary: ② discards a bad staged file; ③ rolls the
// backup back in after maxAttempts starts that never reached Settle.
package selfupdate

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Repo is the release source. Hardcoded, never a config value: a configurable update
// source on a pentest platform is a remote-code-execution channel for anyone who can
// edit config — a door we keep shut.
const Repo = "AntiFox-AI/antifox"

// ExitRestart is the "please relaunch me" exit code (EX_TEMPFAIL). The supervisor sees
// it and restarts immediately without counting it as a crash. 0 = clean user stop;
// anything else is treated as a crash (backoff then retry).
const ExitRestart = 75

// maxAttempts is how many starts a freshly-swapped binary gets to reach Settle before
// we conclude it can't boot and roll back.
const maxAttempts = 3

// SettleDelay is how long the new binary must stay up before the upgrade is confirmed.
const SettleDelay = 30 * time.Second

// smokeEnv short-circuits Bootstrap in the child process launched by the smoke test,
// so it never tries to apply/roll back the very files being staged.
const smokeEnv = "ANTIFOX_SELFUPDATE_SMOKE"

// binaryName is the executable name inside a release archive (and on disk).
func binaryName() string {
	if isWindows() {
		return "antifox.exe"
	}
	return "antifox"
}

// AssetName is the release asset for a platform, matching the release pipeline exactly
// (.github/workflows/release.yml names zips antifox-<tag>-<os>-<arch>.zip, where tag is
// the full git tag INCLUDING the leading v, e.g. antifox-v2.0.2-linux-amd64.zip).
func AssetName(tag, goos, goarch string) string {
	return fmt.Sprintf("antifox-%s-%s-%s.zip", tag, goos, goarch)
}

// Paths are every file a single upgrade touches, all beside the EXECUTABLE (never the
// CWD — a service's working dir may be / or anywhere, which would scatter the staged
// files and break the swap).
type Paths struct {
	Dir     string // directory holding the executable
	Current string // the running binary            antifox      / antifox.exe
	New     string // staged new version            antifox.new  / antifox.new.exe
	Sum     string // staged version's sha256 hex   antifox.new.sha256 / …
	Old     string // pre-swap backup               antifox.old  / antifox.old.exe
	Marker  string // upgrade-state marker          antifox.upgrade.json
}

// ResolvePaths derives all upgrade paths from the current executable. On Windows the
// .new/.old files keep the .exe suffix so they can be executed and renamed.
func ResolvePaths() (Paths, error) {
	exe, err := os.Executable()
	if err != nil {
		return Paths{}, fmt.Errorf("locate executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	dir := filepath.Dir(exe)
	name := filepath.Base(exe)
	ext := filepath.Ext(name) // ".exe" on Windows, usually "" on Unix
	stem := strings.TrimSuffix(name, ext)
	join := func(suffix string) string { return filepath.Join(dir, stem+suffix+ext) }
	return Paths{
		Dir:     dir,
		Current: exe,
		New:     join(".new"),
		Sum:     join(".new") + ".sha256",
		Old:     join(".old"),
		Marker:  filepath.Join(dir, stem+".upgrade.json"),
	}, nil
}

// marker tracks one swap's progress so a new binary that won't boot can be rolled back.
type marker struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Attempts int    `json:"attempts"`
	StagedAt int64  `json:"staged_at"`
}

func readMarker(path string) (marker, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return marker{}, false
	}
	var m marker
	if json.Unmarshal(b, &m) != nil {
		return marker{}, false
	}
	return m, true
}

func writeMarker(path string, m marker) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// cleanStaged removes the staged files (on success, verify failure, or cancel) so a
// stale antifox.new isn't retried on the next start.
func cleanStaged(p Paths) {
	_ = os.Remove(p.New)
	_ = os.Remove(p.Sum)
}

// CompareVersions returns -1/0/1 for a<b / a==b / a>b. ok=false when either side is not
// a clean three-part semver (e.g. a local "dev" build or a "0.3.7-2-gabc1234" git-describe
// build) — callers then disable one-click update, so a dev build is never "upgraded" over
// uncommitted work.
func CompareVersions(a, b string) (int, bool) {
	av, aok := parseVersion(a)
	bv, bok := parseVersion(b)
	if !aok || !bok {
		return 0, false
	}
	for i := range 3 {
		if av[i] != bv[i] {
			if av[i] < bv[i] {
				return -1, true
			}
			return 1, true
		}
	}
	return 0, true
}

// parseVersion parses "v1.2.3" / "1.2.3" into [3]int. Only a clean three-part form is
// accepted; anything with a suffix (git-describe, pre-release) is "not comparable".
func parseVersion(s string) ([3]int, bool) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if s == "" {
		return [3]int{}, false
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return [3]int{}, false
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}

// InDocker reports whether we run inside a container. In Docker a swap writes to the
// container's writable layer and is lost when the container is recreated — so the UI
// tells Docker users to pull a new image instead of using one-click update.
func InDocker() bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	b, err := os.ReadFile("/proc/1/cgroup")
	if err != nil {
		return false
	}
	s := string(b)
	return strings.Contains(s, "docker") || strings.Contains(s, "containerd")
}

func isWindows() bool { return os.PathSeparator == '\\' }

func orUnknown(s string) string {
	if strings.TrimSpace(s) == "" {
		return "unknown version"
	}
	return s
}
