package knowledge

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ExtractText returns the plain text of an uploaded document. Text formats are
// read raw; .docx/.pdf go through a best-effort python extractor. The python is
// chosen by PROBING candidates for the needed library (see findPythonWith), so a
// misordered PATH (e.g. a homebrew python3 without python-docx shadowing a pyenv
// one that has it) no longer breaks parsing.
func ExtractText(path string, raw []byte) (string, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".md", ".markdown", ".txt", ".text", ".csv", ".json", ".log", ".yaml", ".yml", ".htm", ".html", "":
		return string(raw), nil
	case ".docx":
		return pythonExtract(path, docxPy, "docx", raw)
	case ".pdf":
		return pythonExtract(path, pdfPy, "pdfplumber", raw)
	default:
		return "", fmt.Errorf("暂不支持的文件类型（支持 .md/.txt/.csv/.json/.docx/.pdf）")
	}
}

const docxPy = `import sys
from docx import Document
d = Document(sys.argv[1])
parts = [p.text for p in d.paragraphs]
for t in d.tables:
    for r in t.rows:
        parts.append(" | ".join(c.text for c in r.cells))
print("\n".join(parts))
`

const pdfPy = `import sys
text = ""
try:
    import pdfplumber
    with pdfplumber.open(sys.argv[1]) as pdf:
        text = "\n".join((pg.extract_text() or "") for pg in pdf.pages)
except Exception:
    try:
        from pypdf import PdfReader
    except Exception:
        from PyPDF2 import PdfReader
    r = PdfReader(sys.argv[1])
    text = "\n".join((pg.extract_text() or "") for pg in r.pages)
print(text)
`

func pythonExtract(path, script, requireMod string, raw []byte) (string, error) {
	// The upload lives only in memory (the caller passes the original filename, not a
	// real path). Write the bytes to a temp file so python can open it.
	tmp, err := os.CreateTemp("", "kbdoc-*"+filepath.Ext(path))
	if err != nil {
		return "", fmt.Errorf("创建临时文件失败: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, werr := tmp.Write(raw); werr != nil {
		tmp.Close()
		return "", fmt.Errorf("写入临时文件失败: %w", werr)
	}
	tmp.Close()

	py := findPythonWith(requireMod)
	if py == "" {
		return "", fmt.Errorf("未找到 python3（解析 .docx/.pdf 需 python3 + python-docx / pdfplumber）")
	}
	cmd := exec.Command(py, "-c", script, tmp.Name())
	var errb bytes.Buffer
	cmd.Stderr = &errb
	out, err := cmd.Output()
	if err != nil {
		detail := strings.TrimSpace(errb.String())
		if len(detail) > 400 {
			detail = "…" + detail[len(detail)-400:]
		}
		return "", fmt.Errorf("解析失败（python=%s；如缺库请对该 python 执行 pip install python-docx pdfplumber）: %v: %s",
			filepath.Base(py), err, detail)
	}
	return string(out), nil
}

// findPythonWith returns the first candidate python3 that can import requireMod.
// If none can, it returns the first python found anyway so the caller surfaces the
// real python stderr (missing-module message) instead of a generic "no python".
func findPythonWith(requireMod string) string {
	var first string
	for _, py := range pythonCandidates() {
		if first == "" {
			first = py
		}
		if exec.Command(py, "-c", "import "+requireMod).Run() == nil {
			return py
		}
	}
	return first
}

// pythonCandidates lists python3 interpreters to try, de-duplicated: PATH-resolved
// first, then common absolute locations (pyenv shim, homebrew, framework, system) —
// so we still find a lib-equipped python even when the server's PATH resolves to one
// without the libs.
func pythonCandidates() []string {
	var out []string
	seen := map[string]bool{}
	add := func(p string) {
		if p == "" || seen[p] {
			return
		}
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			out = append(out, p)
			seen[p] = true
		}
	}
	for _, c := range []string{"python3", "python"} {
		if p, err := exec.LookPath(c); err == nil {
			add(p)
		}
	}
	home, _ := os.UserHomeDir()
	add(filepath.Join(home, ".pyenv", "shims", "python3"))
	add("/opt/homebrew/bin/python3")
	add("/usr/local/bin/python3")
	add("/usr/bin/python3")
	return out
}
