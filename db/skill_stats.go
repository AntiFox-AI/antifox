package db

// Skill invocation stats — reuse observability. Each time an agent loads a skill
// (the Skill meta-tool's OnInvoke fires) we bump a per-(skill,agent) counter. The
// Skills page aggregates these into a monitoring panel.

import "time"

// RecordSkillInvocation bumps the call counter for (skillName, agentKey). Best
// effort: errors are swallowed so a stats write never affects agent execution.
func (d *DB) RecordSkillInvocation(skillName, agentKey string) {
	if skillName == "" {
		return
	}
	_, _ = d.Exec(`INSERT INTO skill_stats (skill_name, agent_key, calls, last_at)
		VALUES ($1, $2, 1, now())
		ON CONFLICT (skill_name, agent_key)
		DO UPDATE SET calls = skill_stats.calls + 1, last_at = now()`, skillName, agentKey)
}

// SkillStat is the aggregated per-skill invocation summary.
type SkillStat struct {
	SkillName string         `json:"skill_name"`
	Calls     int64          `json:"calls"`
	LastAt    *time.Time     `json:"last_at,omitempty"`
	ByAgent   map[string]int64 `json:"by_agent"` // agent_key → calls
}

// SkillStats returns per-skill aggregated stats (total calls, last invocation,
// per-agent breakdown), newest-activity first.
func (d *DB) SkillStats() ([]*SkillStat, error) {
	rows, err := d.Query(`SELECT skill_name, agent_key, calls, last_at FROM skill_stats ORDER BY last_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byName := map[string]*SkillStat{}
	order := []string{}
	for rows.Next() {
		var name, agentKey string
		var calls int64
		var lastAt time.Time
		if err := rows.Scan(&name, &agentKey, &calls, &lastAt); err != nil {
			return nil, err
		}
		st, ok := byName[name]
		if !ok {
			st = &SkillStat{SkillName: name, ByAgent: map[string]int64{}}
			byName[name] = st
			order = append(order, name)
		}
		st.Calls += calls
		if agentKey != "" {
			st.ByAgent[agentKey] += calls
		}
		if st.LastAt == nil || lastAt.After(*st.LastAt) {
			t := lastAt
			st.LastAt = &t
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]*SkillStat, 0, len(order))
	for _, n := range order {
		out = append(out, byName[n])
	}
	return out, nil
}
