package agent

import (
	"sort"
	"strings"
	"testing"
)

// TestSeedInLanguage verifies the English tool overlay: en-US swaps in the
// translated description/schema when a variant exists and leaves the seed
// untouched otherwise (unknown key, or a non-en-US language).
func TestSeedInLanguage(t *testing.T) {
	base := ToolSeed{Key: "record_fact", Desc: "Chinese desc", Schema: map[string]any{"type": "object"}}

	if got := SeedInLanguage(base, "zh-CN"); got.Desc != base.Desc || got.Schema["type"] != "object" {
		t.Fatalf("zh-CN must be a no-op, got desc=%q", got.Desc)
	}
	if got := SeedInLanguage(base, ""); got.Desc != base.Desc {
		t.Fatalf("empty lang must fall back to zh, got desc=%q", got.Desc)
	}

	en := SeedInLanguage(base, "en-US")
	if en.Desc == base.Desc || en.Desc == "" {
		t.Fatalf("en-US must swap the description, got %q", en.Desc)
	}
	if len(en.Schema) == 0 || en.Schema["type"] != "object" {
		t.Fatalf("en-US must provide a schema, got %v", en.Schema)
	}
	// Keys/Agents are behavioral wiring and must never be touched.
	if en.Key != base.Key {
		t.Fatalf("key must not change, got %q", en.Key)
	}

	// The overlay also covers the separately-seeded traffic host tools.
	if _, _, ok := EnglishToolVariant("traffic_search"); !ok {
		t.Fatal("traffic_search must have an English variant")
	}
	if _, _, ok := EnglishToolVariant("definitely_not_a_tool"); ok {
		t.Fatal("unknown tool key must not report a variant")
	}
}

// TestBuiltinPromptSeedsFor verifies language selection of prompt variants:
// en-US returns English bodies, everything else falls back to the Chinese
// defaults, and both maps cover the same agent keys with equal template vars.
func TestBuiltinPromptSeedsFor(t *testing.T) {
	zh := BuiltinPromptSeedsFor("zh-CN")
	en := BuiltinPromptSeedsFor("en-US")
	if len(zh) != len(en) {
		t.Fatalf("variant maps differ in size: zh=%d en=%d", len(zh), len(en))
	}
	for key, zhTmpl := range zh {
		enTmpl, ok := en[key]
		if !ok {
			t.Fatalf("agent %q missing from en-US variants", key)
		}
		// Same set of {{.Var}} placeholders must be preserved by translation.
		if varsOf(zhTmpl) != varsOf(enTmpl) {
			t.Fatalf("agent %q: template vars differ zh=%q en=%q", key, varsOf(zhTmpl), varsOf(enTmpl))
		}
	}
	// Unknown language falls back to Chinese.
	fallback := BuiltinPromptSeedsFor("fr-FR")
	if fallback["worker"] != zh["worker"] {
		t.Fatal("unknown lang must fall back to Chinese defaults")
	}
	if DefaultAssistantPromptFor("en-US") == DefaultAssistantPrompt {
		t.Fatal("en-US assistant starter prompt must differ from Chinese")
	}
}

// varsOf returns the sorted, comma-joined set of {{.Name}} placeholders in a
// template, so a translation that drops or renames a placeholder is caught.
func varsOf(s string) string {
	set := map[string]bool{}
	for i := 0; i+2 < len(s); i++ {
		if s[i] == '{' && s[i+1] == '{' && s[i+2] == '.' {
			for j := i; j+1 < len(s); j++ {
				if s[j] == '}' && s[j+1] == '}' {
					set[s[i:j+2]] = true
					i = j
					break
				}
			}
		}
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}
