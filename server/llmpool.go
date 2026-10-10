package server

import (
	"log"
	"time"

	"antifox/agent"
	"antifox/db"
	"antifox/llmpool"

	"antifox/engine/llm"
)

// LLM 轮询(故障转移)服务端接线（移植自 AntiFox 0.3.3，适配 antifox 单二进制）：
//   - 只有【全局激活配置】这条路径(未 pin、未绑定)才轮询；
//   - 链序 = 激活配置(永远居首) → 其余按 priority DESC，排除 pool_exclude 的；
//   - 熔断状态进程级共享(s.llmHealth)，重建 pool 不清空、重启从 PG 恢复未过期窗口。

// newLLMHealthRegistry builds the process-wide circuit-breaker registry, mirroring
// state into PG so a cooling-off window survives a restart. Writes are async and
// best-effort — the in-memory copy is authoritative.
func newLLMHealthRegistry(pg *db.DB) *llmpool.Registry {
	if pg == nil {
		return llmpool.NewRegistry(nil, nil)
	}
	persist := func(id int64, st llmpool.State) {
		h := db.LLMHealth{ProfileID: id, Fails: st.Fails, Trips: st.Trips, LastError: st.LastError}
		if !st.OpenUntil.IsZero() {
			t := st.OpenUntil
			h.OpenUntil = &t
		}
		go func() {
			if err := pg.SaveLLMHealth(h); err != nil {
				log.Printf("[llmpool] 熔断状态落库失败: %v", err)
			}
		}()
	}
	forget := func(id int64) { go func() { _ = pg.ClearLLMHealth(id) }() }
	reg := llmpool.NewRegistry(persist, forget)
	if rows, err := pg.LoadLLMHealth(); err == nil {
		for _, h := range rows {
			st := llmpool.State{Fails: h.Fails, Trips: h.Trips, LastError: h.LastError, LastAt: h.LastAt}
			if h.OpenUntil != nil {
				st.OpenUntil = *h.OpenUntil
			}
			reg.Restore(h.ProfileID, st)
			log.Printf("[llmpool] 恢复熔断状态: 配置 #%d 冷却至 %s", h.ProfileID, st.OpenUntil.Format(time.RFC3339))
		}
	}
	return reg
}

// poolMember builds one chain member from a profile, reusing the per-profile provider
// cache so every agent pointing at the same profile shares one provider (hence one
// rate limiter). Returns nil when the profile can't be built.
func (s *Server) poolMember(p *db.LLMProfile, rank int) *llmpool.Member {
	prov, cfg, ok := s.providerForProfile(p.ID)
	if !ok {
		return nil
	}
	return &llmpool.Member{
		ID: p.ID, Name: p.Name, Model: p.Model, Format: p.Format,
		Priority: p.Priority, Active: p.IsDefault, Rank: rank,
		WindowTokens: cfg.CompactionWindow(), Prov: prov,
	}
}

// poolChain builds the failover chain. headID/headProv/headCfg describe the member
// that must lead — the globally active profile — passed in so applyLLM's already-built
// provider is reused instead of duplicated. Returns nil when failover is off or the
// chain has fewer than two usable members (then the caller uses the bare provider —
// byte-for-byte the old behavior).
func (s *Server) poolChain(headID int64, headProv llm.Provider, headCfg agent.Config) *llmpool.Pool {
	if s.m == nil || s.m.pg == nil || !s.m.LLMPoolEnabled() {
		return nil
	}
	profs, err := s.m.pg.PoolProfiles()
	if err != nil {
		log.Printf("[llmpool] 读取轮询链失败: %v", err)
		return nil
	}
	members := []*llmpool.Member{{
		ID: headID, Name: headCfg.Model, Model: headCfg.Model, Rank: llmpool.RankActive,
		WindowTokens: headCfg.CompactionWindow(), Prov: headProv, Active: true,
	}}
	// fill display name from the profile row if we have it
	for _, p := range profs {
		if p.ID == headID {
			members[0].Name, members[0].Format, members[0].Priority = p.Name, p.Format, p.Priority
			break
		}
	}
	for _, p := range profs {
		if p.ID == headID {
			continue
		}
		if m := s.poolMember(p, p.Priority); m != nil {
			members = append(members, m)
		}
	}
	if len(members) < 2 {
		return nil // nothing to fail over to
	}
	return llmpool.New(members, s.llmHealth)
}

// poolForActive wraps the globally-active provider in the failover chain. Returns
// prov unchanged when failover is off or there's nothing to fall back to.
func (s *Server) poolForActive(activeID int64, prov llm.Provider, cfg agent.Config) llm.Provider {
	pool := s.poolChain(activeID, prov, cfg)
	if pool == nil {
		return prov
	}
	names := make([]string, 0, len(pool.Members()))
	for _, m := range pool.Members() {
		names = append(names, m.Name+"/"+m.Model)
	}
	log.Printf("[llmpool] LLM 轮询已启用，链路(%d): %v", len(names), names)
	return pool
}

// poolForBinding wraps a role-bound / task-pinned profile's provider so it ALSO fails
// over to the chain (bound profile as head) when the pool is on. Off / single usable
// member → returns the bare provider unchanged (old behavior). This is what lets a
// planner-strong / worker-weak 分级 role, or a task pinned to one profile, keep running
// when that profile runs out of credit instead of failing hard.
func (s *Server) poolForBinding(id int64, prov llm.Provider, cfg agent.Config) llm.Provider {
	if pool := s.poolChain(id, prov, cfg); pool != nil {
		return pool
	}
	return prov
}

// LLMPoolMemberStatus is one chain entry as shown in the UI.
type LLMPoolMemberStatus struct {
	ProfileID    string `json:"profile_id"`
	Name         string `json:"name"`
	Model        string `json:"model"`
	Format       string `json:"format"`
	Priority     int    `json:"priority"`
	Active       bool   `json:"active"`   // the globally-activated profile
	Excluded     bool   `json:"excluded"` // pool_exclude — not a failover target
	State        string `json:"state"`    // "ok" | "degraded" | "tripped"
	Fails        int    `json:"fails"`
	Trips        int    `json:"trips"`
	CooldownSecs int    `json:"cooldown_secs"`
	LastError    string `json:"last_error,omitempty"`
	LastAt       string `json:"last_at,omitempty"`
}

// llmPoolStatus reports the whole picture for the LLM page: whether failover is on,
// the resolved chain order, and each profile's breaker state. Excluded profiles are
// listed too (flagged) so the user can see why one isn't in line.
func (s *Server) llmPoolStatus() map[string]any {
	out := map[string]any{"enabled": false, "chain": []LLMPoolMemberStatus{}}
	if s.m == nil || s.m.pg == nil {
		return out
	}
	out["enabled"] = s.m.LLMPoolEnabled()
	all, err := s.m.pg.ListProfiles()
	if err != nil {
		return out
	}
	health := s.llmHealth.Snapshot()
	now := time.Now()
	chain := make([]LLMPoolMemberStatus, 0, len(all))
	for _, p := range all {
		st := health[p.ID]
		m := LLMPoolMemberStatus{
			ProfileID: i64s(p.ID), Name: p.Name, Model: p.Model, Format: p.Format,
			Priority: p.Priority, Active: p.IsDefault, Excluded: p.PoolExclude,
			State: "ok", Fails: st.Fails, Trips: st.Trips, LastError: st.LastError,
		}
		if st.Open() {
			m.State = "tripped"
			m.CooldownSecs = int(st.OpenUntil.Sub(now).Seconds()) + 1
		} else if st.Fails > 0 {
			m.State = "degraded"
		}
		if !st.LastAt.IsZero() {
			m.LastAt = st.LastAt.Format(time.RFC3339)
		}
		chain = append(chain, m)
	}
	sortPoolStatus(chain)
	out["chain"] = chain
	return out
}

// sortPoolStatus orders rows like the live chain: active first, then priority DESC,
// then id ASC (incoming slice is id-ordered, so a stable insertion sort suffices).
func sortPoolStatus(in []LLMPoolMemberStatus) {
	for i := 1; i < len(in); i++ {
		for j := i; j > 0 && poolLess(in[j], in[j-1]); j-- {
			in[j], in[j-1] = in[j-1], in[j]
		}
	}
}

func poolLess(a, b LLMPoolMemberStatus) bool {
	if a.Active != b.Active {
		return a.Active
	}
	return a.Priority > b.Priority
}
