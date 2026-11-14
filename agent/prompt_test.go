package agent

import (
	"strings"
	"testing"
)

func TestRenderSystemOverrideAndFallback(t *testing.T) {
	t.Cleanup(func() { PromptOverride = nil })

	// no override → built-in default
	PromptOverride = nil
	if got := renderSystem("planner", "DEFAULT", PlannerVars{Goal: "g"}); got != "DEFAULT" {
		t.Fatalf("no override should give default, got %q", got)
	}

	// override → rendered with vars
	PromptOverride = func(k string) (string, bool) {
		if k == "planner" {
			return "目标:{{.Goal}} 范围:{{.Scope}}", true
		}
		return "", false
	}
	if got := renderSystem("planner", "DEFAULT", PlannerVars{Goal: "拿下X", Scope: "*.x.com"}); got != "目标:拿下X 范围:*.x.com" {
		t.Fatalf("override render: %q", got)
	}

	// override referencing a non-catalog var → execution error → fallback to default
	PromptOverride = func(k string) (string, bool) { return "{{.NotInCatalog}}", true }
	if got := renderSystem("planner", "DEFAULT", PlannerVars{Goal: "x"}); got != "DEFAULT" {
		t.Fatalf("bad var should fall back to default, got %q", got)
	}

	// full plannerSystem path: DB body [A] is honored, then the code-owned tail
	// [C] (中间产物输出规约 / Intermediate artifact output rules) is ALWAYS
	// appended — editing the body can't drop it. Asserted in BOTH content
	// languages (the default here is zh; en is selected explicitly).
	PromptOverride = func(k string) (string, bool) { return "PLANNER {{.Goal}}", true }
	oldLang := ContentLang()
	t.Cleanup(func() { SetContentLang(oldLang) })
	for _, tc := range []struct {
		lang, marker string
	}{
		{"zh-CN", "中间产物输出规约"},
		{"en-US", "Intermediate artifact output rules"},
	} {
		SetContentLang(tc.lang)
		got := plannerSystem("拿下X", "/data")
		if !strings.HasPrefix(got, "PLANNER 拿下X") {
			t.Fatalf("plannerSystem body not honored (%s): %q", tc.lang, got)
		}
		if !strings.Contains(got, tc.marker) || !strings.Contains(got, "/data") {
			t.Fatalf("plannerSystem missing code-owned artifact tail (%s): %q", tc.lang, got)
		}
	}

	// worker dual-text via {{if .ProxyAddr}} in a user template, plus the code tail:
	// [B] trafficTool present only with a proxy, [C] artifact spec always present.
	PromptOverride = func(k string) (string, bool) {
		return "{{if .ProxyAddr}}走代理 {{.ProxyAddr}}{{else}}手动{{end}}", true
	}
	SetContentLang("en-US")
	withProxy := workerSystem("127.0.0.1:8080", "/data")
	if !strings.HasPrefix(withProxy, "走代理 127.0.0.1:8080") {
		t.Fatalf("worker proxy branch body: %q", withProxy)
	}
	if !strings.Contains(withProxy, "traffic_search") {
		t.Fatalf("worker with proxy should inject trafficTool: %q", withProxy)
	}
	if !strings.Contains(withProxy, "Intermediate artifact output rules") {
		t.Fatalf("worker missing artifact tail: %q", withProxy)
	}
	SetContentLang("zh-CN")
	noProxy := workerSystem("", "/data")
	if !strings.HasPrefix(noProxy, "手动") {
		t.Fatalf("worker no-proxy branch body: %q", noProxy)
	}
	if strings.Contains(noProxy, "traffic_search") {
		t.Fatalf("worker without proxy must NOT inject trafficTool: %q", noProxy)
	}
	if !strings.Contains(noProxy, "中间产物输出规约") {
		t.Fatalf("worker missing zh artifact tail: %q", noProxy)
	}
}
