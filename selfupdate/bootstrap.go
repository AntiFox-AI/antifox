package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Action is what Bootstrap tells main to do.
type Action int

const (
	Continue Action = iota // start the server normally
	Restart                // exit with ExitRestart so the supervisor relaunches us
)

// State describes the upgrade situation at this boot, so /api/update/check can tell the
// user how the last upgrade went.
type State struct {
	Pending     bool   // swapped, not yet confirmed stable
	RolledBack  bool   // this boot just auto-rolled back
	FailedStage bool   // a staged file failed verify/smoke and was discarded
	Detail      string // one-line, user-facing
}

// Bootstrap runs at the very top of main, before opening any port or database.
//
//	① antifox.new exists   → verify + smoke, swap and request restart; else discard and run old
//	② only the marker left → just swapped; count an attempt, roll back after too many failures
//	③ nothing              → normal start
func Bootstrap() (Action, State) {
	if os.Getenv(smokeEnv) != "" {
		return Continue, State{}
	}
	p, err := ResolvePaths()
	if err != nil {
		log.Printf("[update] skipping bootstrap: %v", err)
		return Continue, State{}
	}
	if _, err := os.Stat(p.New); err == nil {
		return applyStaged(p)
	}
	m, ok := readMarker(p.Marker)
	if !ok {
		return Continue, State{}
	}
	return confirmOrRollback(p, m)
}

// applyStaged verifies the staged file and swaps it in, or discards it on failure. This
// is the only place the executable is overwritten; the smoke test here is the last gate
// against a binary the supervisor would otherwise relaunch forever.
func applyStaged(p Paths) (Action, State) {
	m, _ := readMarker(p.Marker)
	if err := verifyStaged(p); err != nil {
		log.Printf("[update] staged binary failed verification, discarded, keeping current: %v", err)
		cleanStaged(p)
		_ = os.Remove(p.Marker)
		return Continue, State{FailedStage: true, Detail: "new version failed verification, discarded: " + err.Error()}
	}
	if err := swap(p); err != nil {
		log.Printf("[update] swap failed, keeping current: %v", err)
		cleanStaged(p)
		_ = os.Remove(p.Marker)
		return Continue, State{FailedStage: true, Detail: "swap failed: " + err.Error()}
	}
	m.Attempts = 0
	if m.StagedAt == 0 {
		m.StagedAt = time.Now().Unix()
	}
	if err := writeMarker(p.Marker, m); err != nil {
		log.Printf("[update] write marker failed (no auto-rollback): %v", err)
	}
	log.Printf("[update] swapped in %s, exiting to restart (exit %d)", orUnknown(m.To), ExitRestart)
	return Restart, State{Pending: true}
}

// confirmOrRollback runs on a post-swap boot: count the attempt, roll back if the new
// binary keeps failing to reach Settle. Covers "runs but crashes during init"; a binary
// that can't exec at all is caught earlier by the smoke test.
func confirmOrRollback(p Paths, m marker) (Action, State) {
	m.Attempts++
	if m.Attempts > maxAttempts {
		if err := rollback(p); err != nil {
			log.Printf("[update] new version failed %d times and rollback failed: %v", maxAttempts, err)
			_ = os.Remove(p.Marker)
			return Continue, State{Detail: "new version failed to start and rollback failed: " + err.Error()}
		}
		log.Printf("[update] new version failed %d times, rolled back to %s, exiting to restart (exit %d)", maxAttempts, orUnknown(m.From), ExitRestart)
		_ = os.Remove(p.Marker)
		return Restart, State{RolledBack: true, Detail: fmt.Sprintf("new version failed to start, rolled back to %s", orUnknown(m.From))}
	}
	if err := writeMarker(p.Marker, m); err != nil {
		log.Printf("[update] update marker write failed: %v", err)
	}
	log.Printf("[update] new version starting (attempt %d/%d); will confirm once stable", m.Attempts, maxAttempts)
	return Continue, State{Pending: true}
}

// Settle, called by main after the HTTP listener is up and SettleDelay has passed,
// clears the upgrade marker — the new version has proven it can run.
func Settle() {
	p, err := ResolvePaths()
	if err != nil {
		return
	}
	if _, ok := readMarker(p.Marker); !ok {
		return // not a post-upgrade boot
	}
	if err := os.Remove(p.Marker); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("[update] clear upgrade marker failed: %v", err)
		return
	}
	log.Printf("[update] new version stable, upgrade confirmed (previous kept as %s)", p.Old)
}

// verifyStaged re-checks the staged file's SHA256, then actually runs it once.
func verifyStaged(p Paths) error {
	want, err := os.ReadFile(p.Sum)
	if err != nil {
		return fmt.Errorf("read checksum: %w", err)
	}
	got, err := fileSHA256(p.New)
	if err != nil {
		return fmt.Errorf("compute checksum: %w", err)
	}
	if !strings.EqualFold(strings.TrimSpace(string(want)), got) {
		return errors.New("SHA256 mismatch (corrupt or tampered)")
	}
	return smokeTest(p.New)
}

// smokeTest launches the binary with -h to confirm it can execute on this system,
// catching truncated downloads, wrong arch (exec format error), missing deps, etc.
func smokeTest(bin string) error {
	if err := os.Chmod(bin, 0o755); err != nil {
		return fmt.Errorf("chmod: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "-h")
	cmd.Env = append(os.Environ(), smokeEnv+"=1")
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return errors.New("smoke test timed out (new binary unresponsive)")
	}
	if err != nil {
		snippet := strings.TrimSpace(string(out))
		if len(snippet) > 300 {
			snippet = snippet[:300] + "…"
		}
		return fmt.Errorf("smoke test failed: %v: %s", err, snippet)
	}
	return nil
}

// swap replaces the current binary with the staged one. Both Unix and Windows allow
// renaming a running executable (Windows forbids delete/overwrite, not rename), so no
// platform split and no need to stop ourselves first.
func swap(p Paths) error {
	if err := os.Remove(p.Old); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("clear old backup %s: %w", p.Old, err)
	}
	if err := os.Rename(p.Current, p.Old); err != nil {
		return fmt.Errorf("back up current: %w", err)
	}
	if err := os.Rename(p.New, p.Current); err != nil {
		if rerr := os.Rename(p.Old, p.Current); rerr != nil {
			return fmt.Errorf("install new failed (%v) and restore failed: %w", err, rerr)
		}
		return fmt.Errorf("install new: %w", err)
	}
	_ = os.Remove(p.Sum)
	return nil
}

// rollback puts the swap's backup back (automatic path, on repeated boot failure).
func rollback(p Paths) error {
	if _, err := os.Stat(p.Old); err != nil {
		return fmt.Errorf("no backup to roll back to %s: %w", p.Old, err)
	}
	failed := p.Current + ".failed"
	_ = os.Remove(failed)
	if err := os.Rename(p.Current, failed); err != nil {
		return fmt.Errorf("move failed version aside: %w", err)
	}
	if err := os.Rename(p.Old, p.Current); err != nil {
		return fmt.Errorf("restore old version: %w", err)
	}
	return nil
}

// Rollback is /api/update/rollback: deliberately go back to the previous version. It
// only swaps; the restart is left to the supervisor (caller exits with ExitRestart).
func Rollback() error {
	p, err := ResolvePaths()
	if err != nil {
		return err
	}
	if _, err := os.Stat(p.Old); err != nil {
		return errors.New("no previous version to roll back to (" + p.Old + " missing)")
	}
	cleanStaged(p)
	if err := smokeTest(p.Old); err != nil {
		return fmt.Errorf("previous version won't execute, refusing to roll back: %w", err)
	}
	tmp := p.Current + ".swap"
	_ = os.Remove(tmp)
	if err := os.Rename(p.Current, tmp); err != nil {
		return fmt.Errorf("move current aside: %w", err)
	}
	if err := os.Rename(p.Old, p.Current); err != nil {
		_ = os.Rename(tmp, p.Current)
		return fmt.Errorf("install previous version: %w", err)
	}
	if err := os.Rename(tmp, p.Old); err != nil { // keep it so we can roll forward again
		log.Printf("[update] post-rollback backup tidy failed (harmless): %v", err)
	}
	_ = os.Remove(p.Marker)
	return nil
}

// HasBackup reports whether a previous version is available to roll back to.
func HasBackup() bool {
	p, err := ResolvePaths()
	if err != nil {
		return false
	}
	_, err = os.Stat(p.Old)
	return err == nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
