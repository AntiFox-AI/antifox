package selfupdate

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"runtime"
	"strings"
	"time"
)

// sumsAsset is the checksum manifest the release pipeline attaches, covering every zip.
const sumsAsset = "SHA256SUMS"

// maxBinarySize caps the extracted binary so a malformed zip can't fill the disk.
const maxBinarySize = 512 << 20 // 512 MiB

// Phase is a stage of the upgrade, used directly as the SSE event's phase field.
type Phase string

const (
	PhaseIdle     Phase = "idle"
	PhaseDownload Phase = "downloading"
	PhaseVerify   Phase = "verifying"
	PhaseExtract  Phase = "extracting"
	PhaseStaged   Phase = "staged"
	PhaseFailed   Phase = "failed"
)

// Progress reports upgrade progress to the caller. pct is meaningful only while
// downloading (0-100); other phases pass -1.
type Progress func(ph Phase, pct int, msg string)

// Stage downloads this platform's release archive, verifies it against SHA256SUMS,
// smoke-tests the extracted binary, and stages it as antifox.new. We download the full
// zip (not a bare binary) so SHA256SUMS can cover it and the archive can carry skills/
// later. On return the caller shuts down and exits with ExitRestart.
func Stage(ctx context.Context, c *http.Client, rel *Release, currentVersion string, prog Progress) error {
	if prog == nil {
		prog = func(Phase, int, string) {}
	}
	p, err := ResolvePaths()
	if err != nil {
		return err
	}
	if err := checkWritable(p.Dir); err != nil {
		return err
	}

	name := AssetName(rel.TagName, runtime.GOOS, runtime.GOARCH)
	asset, ok := rel.FindAsset(name)
	if !ok {
		return fmt.Errorf("this release has no build for %s/%s (missing %s)", runtime.GOOS, runtime.GOARCH, name)
	}

	prog(PhaseDownload, 0, "fetching checksum manifest…")
	sums, err := fetchSums(ctx, c, rel)
	if err != nil {
		return err
	}
	want, ok := sums[name]
	if !ok {
		return fmt.Errorf("%s does not list %s; refusing to install an unverified binary", sumsAsset, name)
	}

	// Temp files all live in the target directory so the final rename is atomic within
	// one filesystem (a cross-device rename fails, and /tmp is often a separate mount).
	zipPath := p.New + ".zip.part"
	binPath := p.New + ".part"
	defer func() { _ = os.Remove(zipPath); _ = os.Remove(binPath) }()

	prog(PhaseDownload, 0, fmt.Sprintf("downloading %s (%s)…", name, humanSize(asset.Size)))
	got, err := download(ctx, c, asset, zipPath, prog)
	if err != nil {
		return err
	}

	prog(PhaseVerify, -1, "verifying SHA256…")
	if !strings.EqualFold(got, want) {
		return fmt.Errorf("SHA256 mismatch: want %s, got %s (corrupt or tampered download)", short(want), short(got))
	}

	prog(PhaseExtract, -1, "extracting and smoke-testing…")
	if err := extractBinary(zipPath, binPath); err != nil {
		return err
	}
	if err := smokeTest(binPath); err != nil {
		return fmt.Errorf("new binary won't run on this system: %w", err)
	}

	// Persist the staged binary's own sha256: the next boot re-verifies before swapping,
	// guarding against the file changing between staging and restart.
	binSum, err := fileSHA256(binPath)
	if err != nil {
		return fmt.Errorf("checksum new binary: %w", err)
	}
	if err := os.WriteFile(p.Sum, []byte(binSum), 0o644); err != nil {
		return fmt.Errorf("write checksum: %w", err)
	}
	if err := os.Rename(binPath, p.New); err != nil {
		_ = os.Remove(p.Sum)
		return fmt.Errorf("stage new binary: %w", err)
	}

	if err := writeMarker(p.Marker, marker{
		From:     currentVersion,
		To:       strings.TrimPrefix(rel.TagName, "v"),
		StagedAt: time.Now().Unix(),
	}); err != nil {
		// The marker only affects auto-rollback; the staged file is in place, so don't abort.
		prog(PhaseStaged, -1, "warning: failed to write upgrade marker; auto-rollback will be unavailable")
	}

	prog(PhaseStaged, 100, "new version ready, restarting…")
	return nil
}

// fetchSums downloads and parses SHA256SUMS → map[filename]hex.
func fetchSums(ctx context.Context, c *http.Client, rel *Release) (map[string]string, error) {
	asset, ok := rel.FindAsset(sumsAsset)
	if !ok {
		return nil, fmt.Errorf("release has no %s; refusing to upgrade without integrity check", sumsAsset)
	}
	body, err := httpGet(ctx, c, asset.URL)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", sumsAsset, err)
	}
	defer body.Close()
	raw, err := io.ReadAll(io.LimitReader(body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", sumsAsset, err)
	}
	out := parseSums(string(raw))
	if len(out) == 0 {
		return nil, fmt.Errorf("%s is empty or unrecognizable", sumsAsset)
	}
	return out, nil
}

// parseSums parses a sha256sum-style manifest. A line counts only when its first field
// is a 64-hex digest — otherwise any two-word line would poison the table.
func parseSums(raw string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) != 2 || !isHexSHA256(fields[0]) {
			continue
		}
		name := strings.TrimPrefix(fields[1], "*") // shasum binary mode prefixes a *
		if name != "" {
			out[name] = strings.ToLower(fields[0])
		}
	}
	return out
}

func isHexSHA256(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f', c >= 'A' && c <= 'F':
		default:
			return false
		}
	}
	return true
}

// download writes the asset to dst while computing its SHA256 and reporting progress.
func download(ctx context.Context, c *http.Client, a Asset, dst string, prog Progress) (string, error) {
	body, err := httpGet(ctx, c, a.URL)
	if err != nil {
		return "", fmt.Errorf("download %s: %w", a.Name, err)
	}
	defer body.Close()

	f, err := os.Create(dst)
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}
	defer f.Close()

	h := sha256.New()
	pw := &progressWriter{total: a.Size, prog: prog, last: time.Now()}
	if _, err := io.Copy(io.MultiWriter(f, h, pw), body); err != nil {
		return "", fmt.Errorf("download interrupted: %w", err)
	}
	if err := f.Sync(); err != nil {
		return "", fmt.Errorf("flush to disk: %w", err)
	}
	if a.Size > 0 && pw.written != a.Size {
		return "", fmt.Errorf("incomplete download: want %d bytes, got %d", a.Size, pw.written)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// httpGet issues an allowlist-bound GET and returns the response body.
func httpGet(ctx context.Context, c *http.Client, rawURL string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	if err := checkURL(req.URL); err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return resp.Body, nil
}

// extractBinary pulls the antifox executable out of the release archive. It matches by
// BASENAME (not a reconstructed path) so a version mismatch in the folder name can't
// break extraction.
func extractBinary(zipPath, dst string) error {
	want := binaryName()
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("open archive: %w", err)
	}
	defer zr.Close()

	for _, entry := range zr.File {
		if entry.FileInfo().IsDir() || !strings.EqualFold(path.Base(entry.Name), want) {
			continue
		}
		rc, err := entry.Open()
		if err != nil {
			return fmt.Errorf("read %s: %w", entry.Name, err)
		}
		defer rc.Close()
		f, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return fmt.Errorf("write new binary: %w", err)
		}
		defer f.Close()
		n, err := io.Copy(f, io.LimitReader(rc, maxBinarySize+1))
		if err != nil {
			return fmt.Errorf("unzip %s: %w", entry.Name, err)
		}
		if n > maxBinarySize {
			return fmt.Errorf("archived binary exceeds %s, refusing", humanSize(maxBinarySize))
		}
		if n == 0 {
			return fmt.Errorf("archived %s is empty", want)
		}
		return f.Sync()
	}
	return fmt.Errorf("%s not found in the release archive", want)
}

// checkWritable confirms the executable's directory is writable up front, so a non-root
// run or a system-dir install fails before downloading tens of MB rather than at swap.
func checkWritable(dir string) error {
	probe, err := os.CreateTemp(dir, ".antifox-update-probe-*")
	if err != nil {
		return fmt.Errorf("program dir %s is not writable; cannot self-update (check permissions or update manually): %w", dir, err)
	}
	name := probe.Name()
	_ = probe.Close()
	_ = os.Remove(name)
	return nil
}

// progressWriter counts bytes and rate-limits reporting so not every 32 KiB chunk fires.
type progressWriter struct {
	total   int64
	written int64
	prog    Progress
	last    time.Time
}

func (w *progressWriter) Write(b []byte) (int, error) {
	w.written += int64(len(b))
	if time.Since(w.last) < 300*time.Millisecond {
		return len(b), nil
	}
	w.last = time.Now()
	pct := -1
	if w.total > 0 {
		pct = int(w.written * 100 / w.total)
	}
	w.prog(PhaseDownload, pct, fmt.Sprintf("downloading %s / %s", humanSize(w.written), humanSize(w.total)))
	return len(b), nil
}

func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGT"[exp])
}

func short(sum string) string {
	if len(sum) > 12 {
		return sum[:12] + "…"
	}
	return sum
}
