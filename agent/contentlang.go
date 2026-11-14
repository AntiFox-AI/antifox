package agent

// Code-fixed, LLM-visible prompt segments (worker/planner framing, wrap-up
// prompts, runtime tool result strings) are dual-language: Chinese by default,
// English when the server selects en-US. The server resolves the setting
// (server.readContentLang) and calls SetContentLang once at boot — mirroring the
// seed-time language selection used by BuiltinPromptSeedsFor / SeedInLanguage,
// but for strings that live in code rather than in the seeded catalogs.

// contentLang holds the active content language for code-fixed prompt segments.
// "zh-CN" is the default and the fallback for unknown values.
var contentLang = "zh-CN"

// SetContentLang sets the active content language, normalizing to one of the two
// supported values ("zh-CN", "en-US"); anything else falls back to zh-CN.
func SetContentLang(l string) {
	if l == "en-US" {
		contentLang = "en-US"
	} else {
		contentLang = "zh-CN"
	}
}

// ContentLang returns the active content language.
func ContentLang() string { return contentLang }

// isEN reports whether English prompt segments should be used.
func isEN() bool { return contentLang == "en-US" }

// tr picks the active-language variant of a code-fixed segment: en when English
// is selected, zh (the in-code default) otherwise.
func tr(zh, en string) string {
	if isEN() {
		return en
	}
	return zh
}
