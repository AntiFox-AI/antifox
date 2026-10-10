package server

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"antifox/engine/mcp"
	actool "antifox/engine/tool"
	"antifox/db"
	"antifox/mcphttp"
)

// mcpClient is the shared surface of a connected MCP server (stdio or remote http),
// so tools/list and cleanup are handled uniformly regardless of transport.
type mcpClient interface {
	Tools(context.Context) ([]actool.CoreTool, error)
	Close() error
}

// connectMCP dials one MCP server per its transport. HTTP headers are taken from
// m.Headers (a dedicated JSONB column), NOT m.Env. Callers must Close the client.
func connectMCP(ctx context.Context, m *db.MCPServer) (mcpClient, error) {
	switch m.Transport {
	case "stdio":
		if m.Command == "" {
			return nil, fmt.Errorf("stdio 传输缺少命令")
		}
		return mcp.NewStdioClient(ctx, m.Name, m.Command, jsonStrMap(m.Env), jsonStrSlice(m.Args)...)
	case "http":
		if m.URL == "" {
			return nil, fmt.Errorf("http 传输缺少 URL")
		}
		return mcphttp.New(ctx, m.Name, m.URL, jsonStrMap(m.Headers))
	default:
		return nil, fmt.Errorf("未知传输方式 %q", m.Transport)
	}
}

// mcpTimeout returns a context deadline for MCP connect+discovery. Uses the
// server-level timeout_seconds when set, otherwise a generous default.
func mcpTimeout(ctx context.Context, m *db.MCPServer) (context.Context, context.CancelFunc) {
	dur := 90 * time.Second
	if m.TimeoutSeconds > 0 {
		dur = time.Duration(m.TimeoutSeconds) * time.Second
	}
	return context.WithTimeout(ctx, dur)
}

// discoverAndCacheMCP connects to one MCP, lists its tools, persists the tool cache,
// and saves the health status row (ok | error + message) so the UI shows whether the
// server is actually reachable.
func (s *Server) discoverAndCacheMCP(ctx context.Context, m *db.MCPServer) error {
	cctx, cancel := mcpTimeout(ctx, m)
	defer cancel()
	cl, err := connectMCP(cctx, m)
	if err != nil {
		s.m.pg.SaveMCPHealth(m.ID, "error", err.Error())
		return err
	}
	defer cl.Close()
	ts, err := cl.Tools(cctx)
	if err != nil {
		s.m.pg.SaveMCPHealth(m.ID, "error", err.Error())
		return err
	}
	tools := make([]db.MCPTool, 0, len(ts))
	for _, t := range ts {
		tools = append(tools, db.MCPTool{Name: t.Name(), Description: t.Description()})
	}
	if err := s.m.pg.SaveMCPTools(m.ID, tools); err != nil {
		return err
	}
	s.m.pg.SaveMCPHealth(m.ID, "ok", "")
	log.Printf("[mcp] %s 发现 %d 个工具并已缓存", m.Name, len(tools))
	return nil
}

// healthCheckMCP does a quick connect+tools/list and saves the status row so the UI
// shows whether the server is reachable. The tool cache is NOT refreshed (use
// refresh for that) — this is a lightweight status probe.
func (s *Server) healthCheckMCP(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	servers, err := s.m.pg.ListMCP()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	var m *db.MCPServer
	for _, srv := range servers {
		if srv.ID == id {
			m = srv
			break
		}
	}
	if m == nil {
		writeErr(w, 404, "MCP server not found")
		return
	}
	ctx, cancel := mcpTimeout(r.Context(), m)
	defer cancel()
	cl, err := connectMCP(ctx, m)
	if err != nil {
		s.m.pg.SaveMCPHealth(m.ID, "error", err.Error())
		writeJSON(w, 200, map[string]any{"status": "error", "error": err.Error()})
		return
	}
	defer cl.Close()
	if _, err := cl.Tools(ctx); err != nil {
		s.m.pg.SaveMCPHealth(m.ID, "error", err.Error())
		writeJSON(w, 200, map[string]any{"status": "error", "error": err.Error()})
		return
	}
	s.m.pg.SaveMCPHealth(m.ID, "ok", "")
	writeJSON(w, 200, map[string]any{"status": "ok"})
}

// mcpStats returns per-server MCP tool invocation stats.
func (s *Server) mcpStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.m.pg.MCPStats()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	var totalCalls int64
	for _, st := range stats {
		totalCalls += st.Calls
	}
	servers, _ := s.m.pg.ListMCP()
	enabled := 0
	for _, m := range servers {
		if m.Enabled {
			enabled++
		}
	}
	writeJSON(w, 200, map[string]any{
		"servers":      stats,
		"total_calls":  totalCalls,
		"enabled_count": enabled,
		"total_count":   len(servers),
	})
}

// discoverEmptyMCPsOnStartup fills the tool cache for any enabled MCP that has none
// yet (notably the seeded browser MCP on first run). Runs sequentially in one
// goroutine so we never spawn many stdio servers (npx) at once, and never blocks
// startup. Best-effort: a failure leaves the cache empty to retry next start.
func (s *Server) discoverEmptyMCPsOnStartup() {
	servers, err := s.m.pg.ListMCP()
	if err != nil {
		log.Printf("[mcp] 启动自动发现: 读取列表失败: %v", err)
		return
	}
	for _, m := range servers {
		if !m.Enabled || len(m.Tools) > 0 {
			continue
		}
		ctx, cancel := context.WithTimeout(s.ctx, 90*time.Second)
		if err := s.discoverAndCacheMCP(ctx, m); err != nil {
			log.Printf("[mcp] 启动自动发现 %s 失败: %v", m.Name, err)
		}
		cancel()
	}
}
