package report

// Deterministic docx pipeline: assemble reportDoc → JSON → python-docx renderer.
// The renderer is embedded so it ships in the single binary; it's written to disk
// per run and invoked as a subprocess. Requires python3 + python-docx at runtime;
// callers fall back to the Markdown report when GenerateDocx returns an error.

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"antifox/db"
)

//go:embed pybuilder/report_builder.py
var reportBuilderPy string

// GenerateDocx builds the report and renders it to a .docx under workDir. Returns
// the absolute path to the generated file. taskID is used only to name the file.
func GenerateDocx(ctx context.Context, pg *db.DB, in *GenInput, workDir, taskID string) (string, error) {
	py := findPython()
	if py == "" {
		return "", fmt.Errorf("未找到可用的 python3（报告 docx 渲染需要 python3 + python-docx）")
	}
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return "", fmt.Errorf("创建报告目录失败: %w", err)
	}

	doc := BuildDoc(ctx, pg, in)
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "", fmt.Errorf("组装报告 JSON 失败: %w", err)
	}

	// write the embedded renderer + the input JSON to disk
	builderPath := filepath.Join(workDir, "report_builder.py")
	if err := os.WriteFile(builderPath, []byte(reportBuilderPy), 0o644); err != nil {
		return "", fmt.Errorf("写入渲染器失败: %w", err)
	}
	stamp := nowStamp(ctx)
	inPath := filepath.Join(workDir, fmt.Sprintf("task-%s-%s.json", safeName(taskID), stamp))
	outPath := filepath.Join(workDir, fmt.Sprintf("task-%s-%s.docx", safeName(taskID), stamp))
	if err := os.WriteFile(inPath, data, 0o644); err != nil {
		return "", fmt.Errorf("写入报告 JSON 失败: %w", err)
	}
	defer os.Remove(inPath)

	cctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, py, builderPath, inPath, outPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("python 渲染失败: %v: %s", err, strings.TrimSpace(string(out)))
	}
	if _, err := os.Stat(outPath); err != nil {
		return "", fmt.Errorf("渲染完成但未找到输出文件: %w", err)
	}
	return outPath, nil
}

// findPython prefers a project venv (which would have python-docx installed),
// then falls back to python3 / python on PATH.
func findPython() string {
	candidates := []string{
		"venv/bin/python3", "venv/bin/python",
		".venv/bin/python3", ".venv/bin/python",
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "venv", "bin", "python3"),
			filepath.Join(dir, "venv", "bin", "python3.exe"),
		)
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			if abs, err := filepath.Abs(c); err == nil {
				return abs
			}
			return c
		}
	}
	names := []string{"python3", "python"}
	if runtime.GOOS == "windows" {
		names = []string{"python.exe", "python3.exe", "python"}
	}
	var cands []string
	for _, n := range names {
		if p, err := exec.LookPath(n); err == nil {
			cands = append(cands, p)
		}
	}
	if runtime.GOOS != "windows" {
		if home, err := os.UserHomeDir(); err == nil {
			cands = append(cands, filepath.Join(home, ".pyenv", "shims", "python3"))
		}
		cands = append(cands, "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3")
	}
	// prefer a python that can import python-docx; fall back to the first found so
	// the caller still surfaces the real stderr instead of "no python".
	var first string
	seen := map[string]bool{}
	for _, p := range cands {
		if p == "" || seen[p] {
			continue
		}
		if fi, err := os.Stat(p); err != nil || fi.IsDir() {
			continue
		}
		seen[p] = true
		if first == "" {
			first = p
		}
		if exec.Command(p, "-c", "import docx").Run() == nil {
			return p
		}
	}
	return first
}

// PythonAvailable reports whether python3 + the python-docx module are usable.
func PythonAvailable() bool {
	py := findPython()
	if py == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, py, "-c", "import docx").Run() == nil
}

func safeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	out := b.String()
	if out == "" {
		return "report"
	}
	return out
}

// nowStamp returns a filesystem-safe timestamp. Date.now is available in Go (unlike
// the workflow sandbox); use wall clock for a unique-ish filename.
func nowStamp(_ context.Context) string {
	return time.Now().Format("20060102-150405")
}
