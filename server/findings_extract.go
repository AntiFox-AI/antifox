package server

// 漏洞补录：从任务的 agent 转录（主 Agent 综合 + workers）里用 AI 提取被描述但
// 从未 report_finding 落库的确认漏洞，补建成 finding 节点。因为探索图/发现页/报告
// 都读同一批 finding 节点，一次补录三处同时出现。

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"antifox/db"
	"antifox/report"
)

// POST /api/tasks/{id}/extract-findings — back-fill findings from the transcript.
func (s *Server) extractFindings(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.PathValue("id"))
	if t == nil {
		writeErr(w, 404, "no active task")
		return
	}
	expID := t.Store.ID()
	transcript := s.m.pg.ExplorationSynthesis(expID, 48000)
	if strings.TrimSpace(transcript) == "" {
		writeErr(w, 400, "该任务暂无可分析的会话记录")
		return
	}

	// 附上探索图里已记录的【事实】（含 worker 发现的接口/暴露面）——仅靠对话转录会漏掉
	// 用 record_fact 写回、却没升级成 finding 的暴露/信息泄露，让"梳理"能把它们提出来。
	if facts, ferr := t.Store.ListByKind(db.KindFact, 200); ferr == nil && len(facts) > 0 {
		var fb strings.Builder
		fb.WriteString("\n\n【探索图已记录的事实（可能含未升级为发现的暴露/攻击面）】\n")
		for _, n := range facts {
			var p struct {
				Summary string `json:"summary"`
				Detail  string `json:"detail"`
			}
			_ = json.Unmarshal(n.Payload, &p)
			sm := strings.TrimSpace(p.Summary)
			if sm == "" {
				continue
			}
			fb.WriteString("- ")
			fb.WriteString(sm)
			if d := strings.TrimSpace(p.Detail); d != "" {
				if rr := []rune(d); len(rr) > 200 {
					d = string(rr[:200])
				}
				fb.WriteString("：")
				fb.WriteString(d)
			}
			fb.WriteString("\n")
		}
		transcript += fb.String()
	}

	// existing findings → dedup labels for the AI + a server-side guard
	existingNodes, _ := t.Store.ListByKind(db.KindFinding, 500)
	labels := make([]string, 0, len(existingNodes))
	existingKeys := make([]string, 0, len(existingNodes))
	for _, n := range existingNodes {
		var p struct {
			VulnClass string `json:"vulnclass"`
			Summary   string `json:"summary"`
		}
		_ = json.Unmarshal(n.Payload, &p)
		labels = append(labels, strings.TrimSpace(p.VulnClass+" — "+p.Summary))
		existingKeys = append(existingKeys, normalizeVuln(p.VulnClass+p.Summary))
	}

	extracted, err := report.ExtractFindings(s.ctx, s.m.pg, transcript, labels)
	if err != nil {
		writeErr(w, 502, "AI 提取失败："+err.Error())
		return
	}

	taskID, _ := strconv.ParseInt(t.ID, 10, 64)
	begin := s.m.pg.ExplorationBeginNode(expID)
	created := 0
	for _, e := range extracted {
		if strings.TrimSpace(e.Summary) == "" && strings.TrimSpace(e.VulnClass) == "" {
			continue
		}
		key := normalizeVuln(e.VulnClass + e.Summary)
		if containsSimilar(existingKeys, key) {
			continue // already recorded
		}
		payload := map[string]any{
			"vulnclass": e.VulnClass, "severity": normalizeSeverity(e.Severity), "summary": e.Summary,
			"evidence": map[string]any{"by": "补录", "poc": e.Evidence},
		}
		id, aerr := t.Store.AddNode(db.KindFinding, payload, 9, "confirmed", "补录", nil)
		if aerr != nil {
			continue
		}
		if begin > 0 {
			_ = t.Store.Link(begin, db.RelYields, id) // connect into the graph
		}
		_, _ = t.Store.AddStandaloneFinding(taskID, id, e.VulnClass, normalizeSeverity(e.Severity), e.Summary, e.Evidence, "补录", nil)
		existingKeys = append(existingKeys, key)
		created++
	}
	writeJSON(w, 200, map[string]any{"extracted": len(extracted), "created": created})
}

func normalizeSeverity(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "critical", "严重", "high", "高危", "高":
		if strings.Contains(strings.ToLower(s), "crit") || strings.Contains(s, "严重") {
			return "high" // AntiFox severity set is high|medium|low
		}
		return "high"
	case "medium", "中危", "中", "med":
		return "medium"
	case "low", "低危", "低", "info", "信息":
		return "low"
	}
	return "medium"
}

func normalizeVuln(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r > 127 { // keep CJK
			b.WriteRune(r)
		}
	}
	return b.String()
}

// containsSimilar reports whether key strongly overlaps any existing key (either
// contains the other on a ≥8-char prefix) — a light dedup on top of the AI's.
func containsSimilar(existing []string, key string) bool {
	if key == "" {
		return false
	}
	for _, e := range existing {
		if e == "" {
			continue
		}
		if strings.Contains(e, key) || strings.Contains(key, e) {
			return true
		}
		n := 12
		if len([]rune(key)) >= n && len([]rune(e)) >= n {
			if string([]rune(key)[:n]) == string([]rune(e)[:n]) {
				return true
			}
		}
	}
	return false
}
