package report

// Editable report skill loader. The report skeleton (methodology / checklist /
// tools / standards / personnel) and the AI prompts live as editable files under
// <skillDir>/report-generation/ so they can be tuned in the Skills page without
// recompiling — the engine reads them on every generation. Any file that is
// missing or unparseable transparently falls back to the built-in Go defaults
// (defaults.go / reporti18n.go), so generation never hard-fails on a bad edit.
//
// Layout:
//   report-generation/
//     SKILL.md
//     prompts/report-level.tmpl      (system  ===USER===  user  — text/template)
//     prompts/vuln-narrative.tmpl
//     skeleton/<locale>/methodology.json   {intro, phases:[{name,desc}]}
//     skeleton/<locale>/checklist.json     [{category,name,desc}]
//     skeleton/<locale>/tools.json         [{name,desc}]
//     skeleton/<locale>/standards.json     ["..."]
//     skeleton/<locale>/personnel.json     [{name,role,contact}]

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"text/template"
)

const reportSkillName = "report-generation"

// skillContent is the resolved skeleton + prompt overrides for one generation.
type skillContent struct {
	MethodologyIntro string
	Methodology      []kv
	Tools            []kv
	Standards        []string
	Checklist        []checklistItem
	Personnel        []map[string]string
	// prompt template bodies (already split on ===USER===). Empty → built-in.
	reportLevelSys, reportLevelUser string
	vulnSys, vulnUser               string
}

// loadSkillContent resolves the report skeleton + prompts for a locale, reading
// the editable skill files with a per-file fallback to the built-in defaults.
// skillDir is the platform skill root; "" → all built-in defaults.
func loadSkillContent(skillDir, locale string) *skillContent {
	loc := normLocale(locale)
	sc := &skillContent{
		MethodologyIntro: methodologyIntro(loc),
		Methodology:      methodology(loc),
		Tools:            tools(loc),
		Standards:        standards(loc),
		Checklist:        checklist(loc),
		Personnel:        defaultPersonnel(loc),
	}
	if strings.TrimSpace(skillDir) == "" {
		return sc
	}
	base := filepath.Join(skillDir, reportSkillName)
	skelDir := filepath.Join(base, "skeleton", loc)

	if b, err := os.ReadFile(filepath.Join(skelDir, "methodology.json")); err == nil {
		var m struct {
			Intro  string `json:"intro"`
			Phases []kv   `json:"phases"`
		}
		if json.Unmarshal(b, &m) == nil && strings.TrimSpace(m.Intro) != "" && len(m.Phases) > 0 {
			sc.MethodologyIntro, sc.Methodology = m.Intro, m.Phases
		}
	}
	if b, err := os.ReadFile(filepath.Join(skelDir, "tools.json")); err == nil {
		var t []kv
		if json.Unmarshal(b, &t) == nil && len(t) > 0 {
			sc.Tools = t
		}
	}
	if b, err := os.ReadFile(filepath.Join(skelDir, "standards.json")); err == nil {
		var s []string
		if json.Unmarshal(b, &s) == nil && len(s) > 0 {
			sc.Standards = s
		}
	}
	if b, err := os.ReadFile(filepath.Join(skelDir, "checklist.json")); err == nil {
		var c []checklistItem
		if json.Unmarshal(b, &c) == nil && len(c) > 0 {
			sc.Checklist = c
		}
	}
	if b, err := os.ReadFile(filepath.Join(skelDir, "personnel.json")); err == nil {
		var p []map[string]string
		if json.Unmarshal(b, &p) == nil && len(p) > 0 {
			sc.Personnel = p
		}
	}
	sc.reportLevelSys, sc.reportLevelUser = loadPromptFile(filepath.Join(base, "prompts", "report-level.tmpl"))
	sc.vulnSys, sc.vulnUser = loadPromptFile(filepath.Join(base, "prompts", "vuln-narrative.tmpl"))
	return sc
}

// loadPromptFile reads a "system ===USER=== user" prompt file. Returns empty
// strings when the file is missing or malformed (caller keeps the built-in).
func loadPromptFile(path string) (sys, user string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", ""
	}
	parts := strings.SplitN(string(b), "===USER===", 2)
	if len(parts) != 2 {
		return "", ""
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
}

// renderPrompt executes a text/template body with data; "" on empty/parse error
// so callers can detect "no override" and use the built-in prompt.
func renderPrompt(body string, data any) string {
	if strings.TrimSpace(body) == "" {
		return ""
	}
	t, err := template.New("p").Parse(body)
	if err != nil {
		return ""
	}
	var buf bytes.Buffer
	if t.Execute(&buf, data) != nil {
		return ""
	}
	return strings.TrimSpace(buf.String())
}
