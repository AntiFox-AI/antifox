package report

import (
	"os"
	"path/filepath"
	"testing"
)

// TestSkillSeedAndLoad verifies the seed → load round-trip, that a user edit
// overrides the built-in default, and that a missing/corrupt skill dir falls
// back to the built-in defaults instead of failing.
func TestSkillSeedAndLoad(t *testing.T) {
	dir := t.TempDir()
	if err := SeedSkillFiles(dir); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// en-US skeleton loads from disk and matches the built-in.
	sc := loadSkillContent(dir, "en-US")
	if len(sc.Checklist) != len(checklistAll) {
		t.Fatalf("checklist len = %d, want %d", len(sc.Checklist), len(checklistAll))
	}
	if sc.Methodology[0].Name != "Pre-engagement Interactions" {
		t.Fatalf("en methodology[0] = %q", sc.Methodology[0].Name)
	}

	// A user edit to a skeleton file overrides the built-in.
	edited := `{"intro":"CUSTOM INTRO","phases":[{"name":"Phase X","desc":"custom"}]}`
	p := filepath.Join(dir, reportSkillName, "skeleton", "zh-CN", "methodology.json")
	if err := os.WriteFile(p, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	sc = loadSkillContent(dir, "zh-CN")
	if sc.MethodologyIntro != "CUSTOM INTRO" || len(sc.Methodology) != 1 || sc.Methodology[0].Name != "Phase X" {
		t.Fatalf("edit not picked up: intro=%q phases=%d", sc.MethodologyIntro, len(sc.Methodology))
	}
	// unedited files for the same locale still come through.
	if len(sc.Checklist) != len(checklistAll) {
		t.Fatalf("checklist after edit = %d", len(sc.Checklist))
	}

	// A corrupt file falls back to the built-in default (no failure).
	if err := os.WriteFile(p, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	sc = loadSkillContent(dir, "zh-CN")
	if sc.MethodologyIntro != methodologyIntro("zh-CN") {
		t.Fatalf("corrupt file did not fall back: %q", sc.MethodologyIntro)
	}

	// Seed is idempotent and MUST NOT overwrite an existing (user-edited) file.
	sp := filepath.Join(dir, reportSkillName, "skeleton", "en-US", "standards.json")
	custom := []byte(`{"__user_edit__":true}`)
	if err := os.WriteFile(sp, custom, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := SeedSkillFiles(dir); err != nil {
		t.Fatalf("re-seed: %v", err)
	}
	if b, _ := os.ReadFile(sp); string(b) != string(custom) {
		t.Fatalf("re-seed overwrote a user-edited file: %q", string(b))
	}

	// An empty skill dir → all built-in defaults.
	sc = loadSkillContent("", "en-US")
	if sc.MethodologyIntro != methodologyIntro("en-US") || len(sc.Tools) != len(tools("en-US")) {
		t.Fatalf("empty skillDir did not use built-in defaults")
	}

	// Prompt override round-trips through the template renderer.
	sc = loadSkillContent(dir, "en-US")
	got := renderPrompt(sc.vulnUser, vulnPromptData{VulnClass: "SQLi", Severity: "High", Summary: "s", PoC: "p", Company: "Acme", LangDirective: "English"})
	if got == "" {
		t.Fatalf("vuln prompt template did not render")
	}
}
