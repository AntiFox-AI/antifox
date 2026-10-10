package db

// Support for retroactive finding extraction (漏洞补录): gather an exploration's
// agent OUTPUT transcript (the synthesis + worker conclusions) so an LLM can pull
// out confirmed vulns the agents described but never recorded via report_finding.

import "strings"

// ExplorationSynthesis returns the agent-generated text for an exploration —
// the 主 Agent (mainagent) synthesis first (it holds the vuln round-up), then
// planner/worker text — concatenated and capped at maxChars. Only kind in
// (text, result): the actual model output, not thinking/tool traffic.
func (d *DB) ExplorationSynthesis(expID int64, maxChars int) string {
	rows, err := d.Query(`
		SELECT worker, coalesce(NULLIF(detail,''), summary, '') AS content
		FROM activity
		WHERE exploration_id=$1 AND kind IN ('text','result') AND coalesce(NULLIF(detail,''), summary, '') <> ''
		ORDER BY (worker='mainagent') DESC, id ASC`, expID)
	if err != nil {
		return ""
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var worker, content string
		if err := rows.Scan(&worker, &content); err != nil {
			break
		}
		if b.Len()+len(content) > maxChars {
			remain := maxChars - b.Len()
			if remain > 200 {
				b.WriteString("\n【" + worker + "】\n")
				b.WriteString(content[:remain])
			}
			break
		}
		b.WriteString("\n【" + worker + "】\n")
		b.WriteString(content)
	}
	return b.String()
}

// FindingSourceTranscript returns the real work transcript that produced a finding
// node — the activity recorded against the INTENT that yielded it (intent →yields→
// finding), covering tool calls (requests/commands), their results (responses), and
// agent text (analysis). This lets enrichment extract the ACTUAL reproduction steps
// and evidence instead of expanding a one-line summary. Falls back to the finding
// node's own activity when no yielding intent is linked. Capped at maxChars. Empty
// when nothing is recorded. thinking/usage rows are excluded (internal/accounting).
// FindingReproTranscript returns a REQUEST/RESPONSE-focused transcript for the finding's
// intent: real tool calls (requests/commands, full) + their results (responses, trimmed
// per-item to a snippet) + turn summaries — dropping the agent's thinking/prose. Smaller,
// cheaper and MORE accurate for reproduction-recipe enrichment than FindingSourceTranscript
// (which omits responses → the AI would guess them; and includes no per-response cap).
func (d *DB) FindingReproTranscript(nodeID int64, maxChars int) string {
	var expID int64
	if err := d.QueryRow(`SELECT exploration_id FROM exploration_nodes WHERE id=$1`, nodeID).Scan(&expID); err != nil || expID == 0 {
		return ""
	}
	scope := nodeID
	var intentID int64
	if err := d.QueryRow(`SELECT src_id FROM exploration_edges WHERE dst_id=$1 AND rel='yields' ORDER BY created_at LIMIT 1`, nodeID).Scan(&intentID); err == nil && intentID > 0 {
		scope = intentID
	}
	rows, err := d.Query(`
		SELECT kind, coalesce(tool,''), coalesce(NULLIF(detail,''), summary, '') AS content
		FROM activity
		WHERE exploration_id=$1 AND node_id=$2 AND kind IN ('tool_use','tool_result','result')
		  AND coalesce(NULLIF(detail,''), summary, '') <> ''
		ORDER BY id ASC`, expID, scope)
	if err != nil {
		return ""
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var kind, tool, content string
		if err := rows.Scan(&kind, &tool, &content); err != nil {
			break
		}
		// Responses (tool_result) can be huge (full 4KB+ pages); the recipe needs the
		// status line + a short indicator, not the whole body. Requests kept full.
		if kind == "tool_result" && len(content) > 700 {
			content = strings.ToValidUTF8(content[:700], "") + " …(响应已截断)"
		}
		label := "请求"
		if kind == "tool_result" {
			label = "响应"
		} else if kind == "result" {
			label = "小结"
		}
		hdr := "\n【" + label
		if tool != "" {
			hdr += ":" + tool
		}
		hdr += "】\n"
		if b.Len()+len(hdr)+len(content) > maxChars {
			break
		}
		b.WriteString(hdr)
		b.WriteString(content)
	}
	return b.String()
}

func (d *DB) FindingSourceTranscript(nodeID int64, maxChars int) string {
	var expID int64
	if err := d.QueryRow(`SELECT exploration_id FROM exploration_nodes WHERE id=$1`, nodeID).Scan(&expID); err != nil || expID == 0 {
		return ""
	}
	// the intent that yielded this finding holds the work transcript; fall back to
	// the finding node itself if the edge is absent (e.g. back-filled findings).
	scope := nodeID
	var intentID int64
	if err := d.QueryRow(`SELECT src_id FROM exploration_edges WHERE dst_id=$1 AND rel='yields' ORDER BY id LIMIT 1`, nodeID).Scan(&intentID); err == nil && intentID > 0 {
		scope = intentID
	}
	rows, err := d.Query(`
		SELECT worker, kind, coalesce(tool,''), coalesce(NULLIF(detail,''), summary, '') AS content
		FROM activity
		WHERE exploration_id=$1 AND node_id=$2 AND kind IN ('text','result','tool_use')
		  AND coalesce(NULLIF(detail,''), summary, '') <> ''
		ORDER BY id ASC`, expID, scope)
	if err != nil {
		return ""
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var worker, kind, tool, content string
		if err := rows.Scan(&worker, &kind, &tool, &content); err != nil {
			break
		}
		hdr := "\n【" + worker + " · " + kind
		if tool != "" {
			hdr += ":" + tool
		}
		hdr += "】\n"
		if b.Len()+len(hdr)+len(content) > maxChars {
			if remain := maxChars - b.Len() - len(hdr); remain > 200 {
				b.WriteString(hdr)
				b.WriteString(strings.ToValidUTF8(content[:remain], ""))
			}
			break
		}
		b.WriteString(hdr)
		b.WriteString(content)
	}
	return b.String()
}

// ExplorationBeginNode returns the origin/begin node id of an exploration (the
// root the graph hangs off), used to link retroactively-created findings so they
// appear connected in the exploration graph. Returns 0 if none.
func (d *DB) ExplorationBeginNode(expID int64) int64 {
	var id int64
	// prefer the origin fact (begin); fall back to the goal node.
	if err := d.QueryRow(`SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND state='origin' ORDER BY id LIMIT 1`, expID).Scan(&id); err == nil && id > 0 {
		return id
	}
	_ = d.QueryRow(`SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind='goal' ORDER BY id LIMIT 1`, expID).Scan(&id)
	return id
}
