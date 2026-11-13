package tool

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"antifox/engine/permission"
)

// The interactive-shell tool family (opt-in; NOT in DefaultTools). ShellSessionTools
// returns all five. They require a task Manager on the ToolContext (tc.Tasks) — that is
// where the PTY sessions live and get cleaned up. See docs/交互式shell设计.md.

// ShellSessionTools returns the five interactive-shell tools. Callers add them to
// Options.Tools only when interactive shell is enabled for the agent.
func ShellSessionTools() []CoreTool {
	return []CoreTool{NewShellOpen(), NewShellSend(), NewShellRead(), NewShellClose(), NewShellList()}
}

func sessTool(name, desc string, schema map[string]any, readOnly bool, run func(context.Context, json.RawMessage, *ToolContext) (Result, error)) CoreTool {
	return Build(Spec{
		Name: name, Description: desc, Schema: schema,
		ReadOnly:   func(json.RawMessage) bool { return readOnly },
		Concurrent: func(json.RawMessage) bool { return false },
		Permissions: func(context.Context, json.RawMessage, permission.Context) permission.Decision {
			return permission.Allowed()
		},
		Run: run,
	})
}

func obj(props map[string]any, required ...string) map[string]any {
	m := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		m["required"] = required
	}
	return m
}
func strProp(d string) map[string]any  { return map[string]any{"type": "string", "description": d} }
func boolProp(d string) map[string]any { return map[string]any{"type": "boolean", "description": d} }
func intProp(d string) map[string]any  { return map[string]any{"type": "integer", "description": d} }
func arrStr(d string) map[string]any {
	return map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": d}
}

func jsonResult(v any) (Result, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return Errorf("marshal: " + err.Error()), nil
	}
	return Text(string(b)), nil
}

func sessManager(tc *ToolContext) (*Manager, *Result) {
	if InteractiveShellDisabled() {
		r := Errorf("interactive shell has been globally disabled (AGENT_CORE_DISABLE_INTERACTIVE_SHELL)")
		return nil, &r
	}
	if tc == nil || tc.Tasks == nil {
		r := Errorf("interactive shell requires the background task manager (not enabled)")
		return nil, &r
	}
	return tc.Tasks, nil
}

func ms(v int, def int) time.Duration {
	if v <= 0 {
		v = def
	}
	return time.Duration(v) * time.Millisecond
}

// NewShellOpen 开一个交互会话。
func NewShellOpen() CoreTool {
	desc := "Open a persistent PTY interactive session to run [interactive programs that need a real TTY] (msfconsole/interactive ssh/mysql, Python or other REPLs/password prompts/nc sessions); returns a session_id. **For one-shot, non-interactive commands use Bash**. mode: interactive=block until the first prompt/quiet, then return startup output; hands-free(default)=return immediately, then poll with shell_read; dispatch=return immediately, notify on completion; monitor=return immediately, watch the keywords in watch in the background and notify on a hit (session stays alive; good for waiting for a match, but the session only lives for this run). Set prompt_regex (e.g. 'msf6? >\\s*$') to precisely detect command completion. Always shell_close when done."
	schema := obj(map[string]any{
		"command":          strProp("interactive program to run, e.g. 'msfconsole -q' / 'ssh user@host' / 'python3'"),
		"mode":             strProp("interactive | hands-free(default) | dispatch | monitor"),
		"watch":            arrStr("required for monitor mode: array of keywords/regexes to watch; a hit on any one triggers a notification (each reported only once)"),
		"prompt_regex":     strProp("optional: prompt regex used to detect command completion (matched against end of output)"),
		"rows":             intProp("optional: PTY rows (default 24)"),
		"cols":             intProp("optional: PTY columns (default 80)"),
		"quiet_ms":         intProp("optional: milliseconds of quiet considered complete (default 8000)"),
		"startup_grace_ms": intProp("optional: startup grace period in ms during which quiet detection is suppressed (default 15000)"),
	}, "command")
	return sessTool("shell_open", desc, schema, false, func(ctx context.Context, in json.RawMessage, tc *ToolContext) (Result, error) {
		m, errR := sessManager(tc)
		if errR != nil {
			return *errR, nil
		}
		var a struct {
			Command        string   `json:"command"`
			Mode           string   `json:"mode"`
			PromptRegex    string   `json:"prompt_regex"`
			Watch          []string `json:"watch"`
			Rows           int      `json:"rows"`
			Cols           int      `json:"cols"`
			QuietMs        int      `json:"quiet_ms"`
			StartupGraceMs int      `json:"startup_grace_ms"`
		}
		_ = json.Unmarshal(in, &a)
		if a.Command == "" {
			return Errorf("command is required"), nil
		}
		mode := a.Mode
		if mode == "" {
			mode = "hands-free"
		}
		switch mode {
		case "hands-free", "interactive", "dispatch", "monitor":
		default:
			return Errorf("mode must be interactive | hands-free | dispatch | monitor"), nil
		}
		var watch []*regexp.Regexp
		if mode == "monitor" {
			if len(a.Watch) == 0 {
				return Errorf("monitor mode requires watch (keywords/regexes to watch)"), nil
			}
			for _, w := range a.Watch {
				re, err := regexp.Compile(w)
				if err != nil {
					return Errorf("invalid watch regex " + w + ": " + err.Error()), nil
				}
				watch = append(watch, re)
			}
		}
		var pr *regexp.Regexp
		if a.PromptRegex != "" {
			re, err := regexp.Compile(a.PromptRegex)
			if err != nil {
				return Errorf("invalid prompt_regex: " + err.Error()), nil
			}
			pr = re
		}
		workDir := ""
		var env []string
		if tc != nil {
			workDir, env = tc.WorkingDir, tc.Env
		}
		s, err := m.openSession(a.Command, workDir, env, a.Rows, a.Cols, mode, pr)
		if err != nil {
			return Errorf("failed to open session: " + err.Error()), nil
		}
		quiet, grace := ms(a.QuietMs, sessDefQuietMs), ms(a.StartupGraceMs, sessDefGraceMs)
		switch mode {
		case "interactive":
			by := s.waitComplete(ctx, quiet, grace, ms(0, sessWaitCapMs), pr, "")
			out, cur, _ := s.readSince(0, 0, sessDefReadByte*4, false)
			return jsonResult(map[string]any{"session_id": s.id, "state": "running", "done_by": by, "output": out, "cursor": cur, "running": s.running()})
		case "dispatch":
			go m.dispatchWaiter(s, quiet, grace, ms(0, sessWaitCapMs))
			return jsonResult(map[string]any{"session_id": s.id, "state": "running", "dispatched": true})
		case "monitor":
			go m.monitorWaiter(s, watch)
			return jsonResult(map[string]any{"session_id": s.id, "state": "running", "monitoring": len(watch)})
		default: // hands-free
			return jsonResult(map[string]any{"session_id": s.id, "state": "running"})
		}
	})
}

// NewShellSend 向会话发送输入/按键。
func NewShellSend() CoreTool {
	desc := "Send input to an interactive session. Combinable (sent in order of appearance): text=text (no Enter); submit=true append Enter to execute; keys=named keys [ctrl+c/tab/up/...]; hex=raw bytes ['0x1b',...]; paste=multi-line paste (bracketed paste, not executed line by line). wait=true (default) waits for the command to complete and returns incremental output."
	schema := obj(map[string]any{
		"session_id":   strProp("session id (returned by shell_open)"),
		"text":         strProp("text to type (no automatic Enter)"),
		"submit":       boolProp("whether to append Enter after the text to execute it"),
		"keys":         arrStr("named keys: ctrl+c/ctrl+d/tab/enter/esc/up/down/left/right/..."),
		"hex":          arrStr("hex bytes of raw input, e.g. ['0x1b','0x5b','0x41']"),
		"paste":        strProp("multi-line paste (bracketed paste, does not trigger line-by-line execution)"),
		"wait":         boolProp("whether to synchronously wait for the command to complete (default true)"),
		"prompt_regex": strProp("optional: overrides the session's default completion prompt regex"),
		"quiet_ms":     intProp("optional: quiet-detection threshold in ms (default 8000)"),
		"timeout_ms":   intProp("optional: hard timeout in ms for wait (default 120000)"),
	}, "session_id")
	return sessTool("shell_send", desc, schema, false, func(ctx context.Context, in json.RawMessage, tc *ToolContext) (Result, error) {
		m, errR := sessManager(tc)
		if errR != nil {
			return *errR, nil
		}
		var a struct {
			SessionID   string   `json:"session_id"`
			Text        string   `json:"text"`
			Paste       string   `json:"paste"`
			PromptRegex string   `json:"prompt_regex"`
			Submit      bool     `json:"submit"`
			Keys        []string `json:"keys"`
			Hex         []string `json:"hex"`
			Wait        *bool    `json:"wait"`
			QuietMs     int      `json:"quiet_ms"`
			TimeoutMs   int      `json:"timeout_ms"`
		}
		_ = json.Unmarshal(in, &a)
		s, ok := m.session(a.SessionID)
		if !ok {
			return Errorf("session not found: " + a.SessionID), nil
		}
		if !s.running() {
			return Errorf("session already ended (exit " + fmtExit(s.exit()) + "); use shell_read to read tail output or shell_close"), nil
		}
		before := s.total
		// build & write input in order: text, submit(\r), keys, hex, paste
		var payload []byte
		if a.Text != "" {
			payload = append(payload, a.Text...)
		}
		if a.Submit {
			payload = append(payload, '\r')
		}
		for _, k := range a.Keys {
			if b, ok := keyToBytes(k); ok {
				payload = append(payload, b...)
			} else {
				return Errorf("unknown key: " + k), nil
			}
		}
		if len(a.Hex) > 0 {
			payload = append(payload, hexToBytes(a.Hex)...)
		}
		if a.Paste != "" {
			payload = append(payload, "\x1b[200~"...)
			payload = append(payload, a.Paste...)
			payload = append(payload, "\x1b[201~"...)
		}
		if len(payload) == 0 {
			return Errorf("no input to send (give at least one of text/submit/keys/hex/paste)"), nil
		}
		if _, err := s.ptmx.Write(payload); err != nil {
			return Errorf("write failed: " + err.Error()), nil
		}
		wait := a.Wait == nil || *a.Wait
		if !wait {
			return jsonResult(map[string]any{"session_id": s.id, "sent": len(payload), "running": s.running()})
		}
		pr := s.prompt
		if a.PromptRegex != "" {
			if re, err := regexp.Compile(a.PromptRegex); err == nil {
				pr = re
			}
		}
		by := s.waitComplete(ctx, ms(a.QuietMs, sessDefQuietMs), 0, ms(a.TimeoutMs, sessWaitCapMs), pr, "")
		out, cur, omitted := s.readSince(before, 0, sessDefReadByte, false)
		return jsonResult(map[string]any{"session_id": s.id, "output": out, "done_by": by, "cursor": cur, "running": s.running(), "omitted": omitted})
	})
}

// NewShellRead 读输出：增量流 或 整屏快照。
func NewShellRead() CoreTool {
	desc := "Read an interactive session's output (sends no input). view=stream(default) incremental raw stream (preferred for streaming tools; continue from since_cursor, or drain to get everything); view=screen full-screen vt snapshot (for full-screen programs like vim/htop)."
	schema := obj(map[string]any{
		"session_id":   strProp("session id"),
		"view":         strProp("stream(default) | screen"),
		"since_cursor": intProp("stream: read after this cursor; if omitted, continue from the session's internal cursor"),
		"max_lines":    intProp("stream: max number of lines returned (default 200)"),
		"max_bytes":    intProp("stream: max number of bytes returned (default 8192)"),
		"drain":        boolProp("stream: true=return all raw output since last time (ignores limits)"),
	}, "session_id")
	// per-session read cursor kept here (tool-side) so unspecified reads continue.
	return sessTool("shell_read", desc, schema, true, func(_ context.Context, in json.RawMessage, tc *ToolContext) (Result, error) {
		m, errR := sessManager(tc)
		if errR != nil {
			return *errR, nil
		}
		var a struct {
			SessionID   string `json:"session_id"`
			View        string `json:"view"`
			SinceCursor *int64 `json:"since_cursor"`
			MaxLines    int    `json:"max_lines"`
			MaxBytes    int    `json:"max_bytes"`
			Drain       bool   `json:"drain"`
		}
		_ = json.Unmarshal(in, &a)
		s, ok := m.session(a.SessionID)
		if !ok {
			return Errorf("session not found: " + a.SessionID), nil
		}
		if a.View == "screen" {
			grid, rows, cols, cx, cy := s.screen()
			return jsonResult(map[string]any{"view": "screen", "screen": grid, "rows": rows, "cols": cols,
				"cursor": map[string]int{"row": cy, "col": cx}, "running": s.running()})
		}
		var from int64
		if a.SinceCursor != nil {
			from = *a.SinceCursor
		} else {
			from = s.readCursor()
		}
		maxLines, maxBytes := a.MaxLines, a.MaxBytes
		if maxLines == 0 {
			maxLines = sessDefReadLine
		}
		if maxBytes == 0 {
			maxBytes = sessDefReadByte
		}
		out, cur, omitted := s.readSince(from, maxLines, maxBytes, a.Drain)
		s.setReadCursor(cur)
		res := map[string]any{"view": "stream", "output": out, "cursor": cur, "running": s.running(), "omitted": omitted}
		if ec := s.exit(); ec != nil {
			res["exit_code"] = *ec
		}
		return jsonResult(res)
	})
}

// NewShellClose 关闭会话。
func NewShellClose() CoreTool {
	schema := obj(map[string]any{"session_id": strProp("session id")}, "session_id")
	return sessTool("shell_close", "Close an interactive session (kills the process, releases the PTY).", schema, false, func(_ context.Context, in json.RawMessage, tc *ToolContext) (Result, error) {
		m, errR := sessManager(tc)
		if errR != nil {
			return *errR, nil
		}
		var a struct {
			SessionID string `json:"session_id"`
		}
		_ = json.Unmarshal(in, &a)
		s, ok := m.session(a.SessionID)
		if !ok {
			return Errorf("session not found: " + a.SessionID), nil
		}
		ec := s.exit()
		s.kill()
		m.sessMu.Lock()
		delete(m.sessions, a.SessionID)
		m.sessMu.Unlock()
		return jsonResult(map[string]any{"closed": a.SessionID, "exit_code": exitOrNil(ec)})
	})
}

// NewShellList 列出会话。
func NewShellList() CoreTool {
	return sessTool("shell_list", "List all current interactive sessions and their status.", obj(map[string]any{}), true, func(_ context.Context, _ json.RawMessage, tc *ToolContext) (Result, error) {
		m, errR := sessManager(tc)
		if errR != nil {
			return *errR, nil
		}
		m.reapSessions()
		m.sessMu.Lock()
		defer m.sessMu.Unlock()
		out := make([]map[string]any, 0, len(m.sessions))
		for _, s := range m.sessions {
			s.mu.Lock()
			out = append(out, map[string]any{"session_id": s.id, "command": s.command, "state": s.state,
				"mode": s.mode, "idle_ms": time.Since(s.lastOut).Milliseconds()})
			s.mu.Unlock()
		}
		return jsonResult(map[string]any{"sessions": out})
	})
}

// --- small helpers ---

func fmtExit(ec *int) string {
	if ec == nil {
		return "?"
	}
	return fmt.Sprintf("%d", *ec)
}
func exitOrNil(ec *int) any {
	if ec == nil {
		return nil
	}
	return *ec
}
