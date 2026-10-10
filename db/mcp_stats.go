package db

// MCP tool invocation stats — reuse observability, same pattern as skill_stats.
// Each time an MCP tool is executed by an agent we bump a per-(server,tool,agent) counter.

import "time"

// RecordMCPInvocation bumps the call counter for (serverName, toolName, agentKey).
// Best effort: errors are swallowed so a stats write never affects execution.
func (d *DB) RecordMCPInvocation(serverName, toolName, agentKey string) {
	if serverName == "" || toolName == "" {
		return
	}
	_, _ = d.Exec(`INSERT INTO mcp_stats (server_name, tool_name, agent_key, calls, last_at)
		VALUES ($1, $2, $3, 1, now())
		ON CONFLICT (server_name, tool_name, agent_key)
		DO UPDATE SET calls = mcp_stats.calls + 1, last_at = now()`, serverName, toolName, agentKey)
}

// MCPStat is the aggregated per-server invocation summary.
type MCPStat struct {
	ServerName string            `json:"server_name"`
	Calls      int64             `json:"calls"`
	LastAt     *time.Time        `json:"last_at,omitempty"`
	ByTool     map[string]int64  `json:"by_tool"`  // tool_name → calls
	ByAgent    map[string]int64  `json:"by_agent"` // agent_key → calls
}

// MCPStats returns per-server aggregated stats, newest-activity first.
func (d *DB) MCPStats() ([]*MCPStat, error) {
	rows, err := d.Query(`SELECT server_name, tool_name, agent_key, calls, last_at FROM mcp_stats ORDER BY last_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byName := map[string]*MCPStat{}
	order := []string{}
	for rows.Next() {
		var server, tool, agent string
		var calls int64
		var lastAt time.Time
		if err := rows.Scan(&server, &tool, &agent, &calls, &lastAt); err != nil {
			return nil, err
		}
		st, ok := byName[server]
		if !ok {
			st = &MCPStat{ServerName: server, ByTool: map[string]int64{}, ByAgent: map[string]int64{}}
			byName[server] = st
			order = append(order, server)
		}
		st.Calls += calls
		st.ByTool[tool] += calls
		if agent != "" {
			st.ByAgent[agent] += calls
		}
		if st.LastAt == nil || lastAt.After(*st.LastAt) {
			t := lastAt
			st.LastAt = &t
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]*MCPStat, 0, len(order))
	for _, n := range order {
		out = append(out, byName[n])
	}
	return out, nil
}
