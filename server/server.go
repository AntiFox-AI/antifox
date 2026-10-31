package server

import (
	"context"
	"encoding/json"

	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"antifox/engine/llm"
	"antifox/engine/memory"
	actool "antifox/engine/tool"
	"antifox/engine/transcript"
	"antifox/agent"
	"antifox/db"
	"antifox/llmpool"
	"antifox/report"
	"antifox/traffic"
)

// Server exposes the AntiFox backend over a JSON HTTP API for the shadcn/ui
// frontend.
type Server struct {
	m      *Manager
	engine *Engine
	ctx    context.Context

	skillDir string // root directory for skill subdirectories
	dataDir  string // data root; report .docx files are written under dataDir/reports
	jwtKey   []byte // HS256 signing key loaded from / generated into dataDir/jwt.key

	loginLimiter *loginLimiter // 登录失败限流/锁定（按 IP + 账号）

	// reportJobs tracks async .docx report generation per task (in-memory; reports
	// are regenerable so a restart simply drops job state). Guarded by reportMu.
	reportMu   sync.Mutex
	reportJobs map[string]*reportJob

	// enrichJobs tracks async per-finding AI enrichment (「AI 分析」), keyed by
	// exploration node id. Enrichment can be a multi-minute LLM generation for stored
	// findings; running it as a background job (on s.ctx, not the request ctx) means a
	// page switch / disconnect can't abort it, re-clicks dedup to the same job, and the
	// UI can poll status + resume the spinner on return. Result persists to PG. Guarded
	// by enrichMu; in-memory (a restart drops job state, PG keeps finished results).
	enrichMu   sync.Mutex
	enrichJobs map[int64]*enrichJob

	cfgMu     sync.Mutex
	mainAgent *agent.MainAgent // nil when no LLM provider is configured
	chatAgent *agent.ChatAgent // conversational runner for the chat page; nil w/o LLM
	llmCfg    agent.Config     // current LLM config (key not exposed)
	llmOn     bool

	// chatBusy guards the per-task main-agent run: the chat handler launches the
	// agent on the server's background ctx (not the request ctx) and returns
	// immediately, so a page reload / proxy timeout can't abort a live run. This
	// map serializes turns per task — one main-agent run at a time per task, so
	// concurrent messages don't corrupt the shared exp<id>-main transcript.
	chatMu   sync.Mutex
	chatBusy map[string]bool
	// chatCancel holds the cancel func for each in-flight conversation run (keyed by
	// convBusyKey), so a manual stop can abort JUST that session's agent run. Set/
	// cleared alongside chatBusy under chatMu. Aborting a run does NOT touch the P3
	// trigger queue — the drain goroutine simply proceeds to the next queued fire.
	chatCancel map[string]context.CancelFunc
	// chatLock serializes main-agent turns PER TASK. A new steering message preempts
	// (cancels) the in-flight turn, then waits on this lock for it to release before
	// taking over — so human steering is never rejected, just interleaved cleanly.
	chatLock map[string]*sync.Mutex

	// triggerQ serializes P3 trigger fires PER AGENT: multiple fires for the same
	// custom agent queue up (FIFO) and run one at a time — the next conversation
	// only starts after the previous one finishes. triggerRun marks that a drain
	// goroutine is already active for that agent key so we don't spawn two. Distinct
	// agents still run concurrently. Queue is in-memory (matches chatBusy); a restart
	// drops pending fires — the scheduler re-fires on its next tick from watermarks.
	queueMu    sync.Mutex
	triggerQ   map[string][]triggeredRun
	triggerRun map[string]bool

	// profAgents caches the dedicated planner/worker built for a specific (non-active)
	// LLM profile, keyed by profile id, so tasks pinned to that profile share one
	// provider (and its rate limiter). Built lazily on first use; invalidated when any
	// profile is saved/activated/deleted so edits take effect. The active-profile path
	// stays on the global engine planner/worker (applyLLM).
	profMu         sync.Mutex
	profAgents     map[int64]*profBundle
	profChatAgents map[int64]*agent.ChatAgent // per-profile ChatAgent cache (chat page)
	// provCache holds a bare llm.Provider per profile id, so every agent/failover-member
	// pointing at the same profile shares one provider + rate limiter. Guarded by its OWN
	// mutex (NOT profMu): agentsForProfile holds profMu and calls providerForProfile via
	// poolForBinding, so a shared lock would self-deadlock. Invalidated alongside profAgents.
	provMu    sync.Mutex
	provCache map[int64]llm.Provider

	// llmHealth is the process-wide LLM circuit-breaker registry backing the failover
	// pool. Outlives any single Pool instance so rebuilding the pool never forgets which
	// backends are broken; mirrors cooling-off windows to PG so they survive a restart.
	llmHealth *llmpool.Registry
}

// profBundle is a planner/worker pair built from one LLM profile.
type profBundle struct {
	pl *agent.Planner
	wk *agent.Worker
}

// triggeredRun is one queued P3 trigger fire awaiting its turn for an agent.
// taskID + mergeable let the drainer coalesce several event triggers (finding/goal)
// from the SAME task into one conversation before it starts (interval fires don't merge).
type triggeredRun struct {
	agentKey  string
	title     string
	message   string
	taskID    int64 // source task for finding/goal triggers; 0 for interval/none
	mergeable bool  // true for finding/goal event triggers (merge by taskID)
}

func New(ctx context.Context, m *Manager, skillDir string, dataDir string) *Server {
	key, err := loadOrCreateJWTKey(dataDir)
	if err != nil {
		log.Fatalf("[auth] JWT key: %v", err)
	}
	s := &Server{m: m, engine: NewEngine(m), ctx: ctx, skillDir: skillDir, dataDir: dataDir, jwtKey: key, chatBusy: map[string]bool{},
		chatCancel: map[string]context.CancelFunc{}, chatLock: map[string]*sync.Mutex{}, triggerQ: map[string][]triggeredRun{}, triggerRun: map[string]bool{},
		profAgents: map[int64]*profBundle{}, profChatAgents: map[int64]*agent.ChatAgent{}, reportJobs: map[string]*reportJob{},
		enrichJobs: map[int64]*enrichJob{}, provCache: map[int64]llm.Provider{}}
	s.loginLimiter = newLoginLimiter()
	s.llmHealth = newLLMHealthRegistry(m.pg) // process-wide LLM circuit breaker (restores cooling windows)
	// 多用户 RBAC：首启迁移旧单用户密码为内置 admin + 播种角色/权限（幂等）。
	s.bootstrapRBAC()
	// 内置 skill 库：把 embed 进二进制的默认 skill 物化到 skillDir（仅缺失时写）。
	// 单二进制自包含，云/客户现场部署首启即有全套 skill，不依赖 dev 机文件。
	materializeEmbeddedSkills(skillDir)
	// 报告生成 skill：把内置骨架/prompt 落成可编辑文件（仅缺失时写，不覆盖用户编辑）。
	if err := report.SeedSkillFiles(skillDir); err != nil {
		log.Printf("[report] seed skill files: %v", err)
	}
	s.seedDemoReportTemplate() // 首启预置一个演示模版（marker 文件保证仅一次）
	// per-task LLM: a task pinned to a specific profile runs on that profile's
	// dedicated planner/worker; unpinned tasks fall back to the global active pair.
	s.engine.SetAgentResolver(func(t *Task) (*agent.Planner, *agent.Worker) {
		if t.LLMProfileID == nil {
			return nil, nil
		}
		return s.agentsForProfile(*t.LLMProfileID)
	})
	// Wire DB-stored prompt templates into the agents (新版方案 §3.3 / §5a). With no
	// override row, agents keep their built-in defaults — behavior is unchanged.
	if m.pg != nil {
		agent.PromptOverride = func(key string) (string, bool) {
			a, err := m.pg.GetAgentByKey(key)
			if err != nil || a == nil {
				return "", false
			}
			t, err := m.pg.CurrentPrompt(a.ID)
			if err != nil || t == "" {
				return "", false
			}
			return t, true
		}
		// Wire DB-stored wrap-up (settlement) prompts. Empty column → built-in default.
		agent.WrapupOverride = func(key string) (string, bool) {
			a, err := m.pg.GetAgentByKey(key)
			if err != nil || a == nil || a.WrapupPrompt == "" {
				return "", false
			}
			return a.WrapupPrompt, true
		}
		// Wire DB-stored wrap-up turn budgets. 0 / missing → built-in per-agent default.
		agent.WrapupMaxTurnsOverride = func(key string) (int, bool) {
			a, err := m.pg.GetAgentByKey(key)
			if err != nil || a == nil || a.WrapupMaxTurns <= 0 {
				return 0, false
			}
			return a.WrapupMaxTurns, true
		}
		// Wire DB-stored TASK-TIMEOUT wrap-up prompt/turns (worker/planner). Empty/0 → default.
		agent.WrapupTaskTimeoutOverride = func(key string) (string, bool) {
			a, err := m.pg.GetAgentByKey(key)
			if err != nil || a == nil || a.TaskTimeoutWrapupPrompt == "" {
				return "", false
			}
			return a.TaskTimeoutWrapupPrompt, true
		}
		agent.WrapupTaskTimeoutTurnsOverride = func(key string) (int, bool) {
			a, err := m.pg.GetAgentByKey(key)
			if err != nil || a == nil || a.TaskTimeoutWrapupMaxTurns <= 0 {
				return 0, false
			}
			return a.TaskTimeoutWrapupMaxTurns, true
		}
		wireAgentAugment(m.pg, s.skillDir, s.hostTools) // 可见 skills/MCP + 流量/编排 host 工具装配进 agent 工具集
		domainReg := buildDomainReg(m.Assets())
		wireTools(m.pg, domainReg)                      // 内置工具表：按 agent 过滤 + 覆盖描述/schema + 注入默认值
		seedPrompts(m.pg)                               // 内置 agent 默认提示词正文播种进 agent_prompts(仅空时)
		s.seedOrchestrationTools()                      // P2 跨任务编排工具 seed 进 tools 表(可按 agent 绑定)
		s.seedPythonInterpreter()                       // 自定义脚本工具:开机检测 python 解释器入库(仅空时)
		go newScheduler(s).Run(s.ctx)                   // P3 触发器调度(定时/finding/目标事件),仅自定义 agent
		// Fill the tool cache for any enabled MCP that has none yet (notably the
		// seeded browser MCP on first run). Async so it never blocks startup.
		go s.discoverEmptyMCPsOnStartup()
		logSink.SetDB(ctx, m.pg) // restore last 100 log rows and enable async persistence
	}
	// precedence: persisted DB config > env.
	if cfg, ok := s.loadLLMConfig(); ok {
		if err := s.applyLLM(cfg); err != nil {
			log.Printf("[engine] saved LLM config init failed — engine idle: %v", err)
		} else {
			log.Printf("[engine] LLM configured from DB: %s / %s", cfg.Provider(), cfg.Model)
		}
	} else if cfg, ok := agent.FromEnv(); ok {
		if err := s.applyLLM(cfg); err != nil {
			log.Printf("[engine] env provider init failed — engine idle: %v", err)
		} else {
			log.Printf("[engine] LLM configured from env: %s / %s", cfg.Provider(), cfg.Model)
		}
	} else {
		log.Printf("[engine] no LLM provider configured — engine idle until set via /api/llm or env")
	}
	// reload tasks persisted on disk so the task list survives a restart, and
	// restore persisted paused state (so a task paused before restart stays paused).
	for _, t := range m.LoadExisting() {
		// clear stale 'running' intents from a prior crash/restart (no live worker
		// owns them) so they re-claim instead of spinning forever in the UI.
		if n, _ := t.Store.ResetRunningIntents(); n > 0 {
			log.Printf("[engine] task %s 重置 %d 个残留 running 意图为 open", t.ID, n)
		}
		if t.Paused {
			s.engine.Pause(t.ID)
		}
		// 任务级超时:为每个未终态、带 timeout 的任务起 deadline 协调器,独立于 planner/worker
		// loop——非活跃任务重启后也能在到点后被收尾(deadline 已过则立即走收尾时序)。
		if !isTerminalStatus(t.Status) {
			s.engine.startDeadlineCoordinator(ctx, t)
		}
	}
	// resume the active task's engine; other tasks resume when opened (setActive).
	// (a restored-paused task's loops still start but idle until resumed.)
	if t := m.ActiveTask(); t != nil {
		s.engine.Run(ctx, t)
	}
	return s
}

// agentMaxTurns returns the configured max_turns for an agent key (0 = unlimited,
// also the fallback when no DB or no row).
func (s *Server) agentMaxTurns(key string) int {
	if s.m.pg == nil {
		return 0
	}
	a, err := s.m.pg.GetAgentByKey(key)
	if err != nil || a == nil {
		return 0
	}
	return a.MaxTurns
}

// agentRunSeconds returns the configured wall-clock run budget (seconds) for an
// agent key (0 = unlimited; 600 fallback when no DB or no row, matching schema).
func (s *Server) agentRunSeconds(key string) int {
	if s.m.pg == nil {
		return 600
	}
	a, err := s.m.pg.GetAgentByKey(key)
	if err != nil || a == nil {
		return 600
	}
	return a.RunSecs
}

// loadLLMConfig reads the active LLM profile from PG (llm_profiles).
func (s *Server) loadLLMConfig() (agent.Config, bool) {
	p, err := s.m.pg.ActiveProfile()
	if err != nil || p == nil {
		return agent.Config{}, false
	}
	cfg := agent.ConfigFrom(p.Format, p.Model, p.BaseURL, p.APIKey, p.Proxy)
	cfg.RatePerSecond, cfg.RatePerMinute = p.RatePerSecond, p.RatePerMinute
	cfg.ContextWindowK = p.ContextWindowK
	cfg.ReasoningEffort = p.ReasoningEffort
	cfg.SessionHeaderKey = p.SessionHeaderKey
	if cfg.APIKey == "" {
		return cfg, false
	}
	return cfg, true
}

// saveLLMConfig persists the LLM config as the active "default" profile in PG.
func (s *Server) saveLLMConfig(cfg agent.Config) {
	format := cfg.Provider()
	if format != "anthropic" {
		format = "openai"
	}
	var id int64
	if profs, _ := s.m.pg.ListProfiles(); profs != nil {
		for _, p := range profs {
			if p.Name == "default" {
				id = p.ID
				break
			}
		}
	}
	newID, err := s.m.pg.SaveProfile(&db.LLMProfile{
		ID: id, Name: "default", Format: format, Model: cfg.Model, BaseURL: cfg.BaseURL, Proxy: cfg.Proxy,
		APIKey: cfg.APIKey, RatePerSecond: cfg.RatePerSecond, RatePerMinute: cfg.RatePerMinute,
		ContextWindowK: cfg.ContextWindowK, ReasoningEffort: cfg.ReasoningEffort, IsDefault: true,
		SessionHeaderKey: cfg.SessionHeaderKey,
	})
	if err == nil {
		_ = s.m.pg.SetActiveProfile(newID)
	}
}

// reapplyActiveProfile hot-reloads the engine from the active DB profile so that
// saving or activating a profile takes effect without a restart. Best-effort:
// logs on failure and leaves the running engine untouched.
func (s *Server) reapplyActiveProfile() {
	cfg, ok := s.loadLLMConfig()
	if !ok {
		return
	}
	if err := s.applyLLM(cfg); err != nil {
		log.Printf("[engine] reapply active profile failed: %v", err)
		return
	}
	log.Printf("[engine] LLM reapplied from active profile: %s / %s", cfg.Provider(), cfg.Model)
}

// webSearchFor gates the global web-search opts (backend/key) by an agent's own
// web_search flag: the backend/key come from the global config, each agent decides on/off.
func (s *Server) webSearchFor(key string) agent.WebSearchOpts {
	o := s.m.WebSearchOpts()
	if a, err := s.m.pg.GetAgentByKey(key); err != nil || a == nil || !a.WebSearch {
		o.Enabled = false
	}
	return o
}

// buildPlannerWorker builds a planner+worker pair on an already-constructed provider
// + cfg, with all engine callbacks / proxy / web-search / memory wiring. Shared by the
// global apply path (applyLLM) and the per-profile path (agentsForProfile), so a task
// pinned to a specific profile behaves identically to the active one — just a different LLM.
// roleProvider resolves the provider + config a role runs on: its bound LLM profile
// (agents.llm_profile_id) if set — enabling planner-strong / worker-weak 分级 — else the
// passed global fallback (already pool-wrapped). A bound profile ALSO fails over via
// poolForBinding, so binding a role never removes its failover safety net.
func (s *Server) roleProvider(role string, fbProv llm.Provider, fbCfg agent.Config) (llm.Provider, agent.Config) {
	if s.m == nil || s.m.pg == nil {
		return fbProv, fbCfg
	}
	a, err := s.m.pg.GetAgentByKey(role)
	if err != nil || a == nil || a.LLMProfileID <= 0 {
		return fbProv, fbCfg
	}
	prov, cfg, ok := s.providerForProfile(a.LLMProfileID)
	if !ok {
		return fbProv, fbCfg // bound profile invalid/keyless → fall back rather than break
	}
	return s.poolForBinding(a.LLMProfileID, prov, cfg), cfg
}

func (s *Server) buildPlannerWorker(prov llm.Provider, cfg agent.Config) (*agent.Planner, *agent.Worker) {
	tx := transcript.NewStore(filepath.Join(s.m.dir, "transcripts")) // raw LLM conversation logs
	// per-role LLM 分级: planner/worker each run on their bound profile if set (planner
	// 强 / worker 弱, for cost control), else the passed global active provider. Unbound
	// roles inherit prov/cfg exactly, so the default (no bindings) is byte-for-byte the
	// old single-provider behavior.
	wkProv, wkCfg := s.roleProvider("worker", prov, cfg)
	plProv, plCfg := s.roleProvider("planner", prov, cfg)
	// traffic host tools flow through ToolAugment for every agent and are filtered by
	// the tools-table binding (default = worker), so worker behavior is unchanged.
	wk := agent.NewWorker(wkProv, wkCfg.Model, s.m.dir, tx, wkCfg.CompactionWindow(), s.agentMaxTurns("worker"))
	wk.SetRunTimeout(time.Duration(s.agentRunSeconds("worker")) * time.Second)
	wk.SetProxy(s.m.ProxyAddr(), s.m.ProxyCACert())
	wk.SetTrafficResolver(s.resolveFindingTraffic) // record-time: resolve finding steps → traffic exchange ids
	wk.SetMemory(memory.NewStore(filepath.Join(s.m.dir, "memory")))
	wk.SetWebSearch(s.webSearchFor("worker"))
	pl := agent.NewPlanner(plProv, plCfg.Model, s.m.dir, tx, plCfg.CompactionWindow(), s.agentMaxTurns("planner"))
	pl.SetKillWork(s.engine.KillWork)               // planner kill_work → terminate a running work
	pl.SetSteerWork(s.engine.SteerWork)             // planner steer_work → inject mid-run course-correction
	pl.SetProxy(s.m.ProxyAddr(), s.m.ProxyCACert()) // WebFetch through the recording proxy
	pl.SetWebSearch(s.webSearchFor("planner"))
	return pl, wk
}

// applyLLM (re)builds the planner/worker/main-agent from cfg and installs them on
// the running engine as the GLOBAL active pair. Safe to call at runtime (UI configures LLM).
func (s *Server) applyLLM(cfg agent.Config) error {
	prov, err := cfg.NewProvider()
	if err != nil {
		return err
	}
	// Wrap the globally-active provider in the failover chain (no-op when the pool is
	// off or has <2 usable members), so a 402/额度耗尽/坏网络 on the active profile
	// fails over to the next configured profile instead of stalling every agent.
	// planner/worker/mainAgent/chatAgent all get the pooled provider below.
	if s.m != nil && s.m.pg != nil {
		if ap, _ := s.m.pg.ActiveProfile(); ap != nil {
			prov = s.poolForActive(ap.ID, prov, cfg)
		}
	}
	pl, wk := s.buildPlannerWorker(prov, cfg)
	s.engine.UseLLM(pl, wk)

	tx := transcript.NewStore(filepath.Join(s.m.dir, "transcripts"))
	win := cfg.CompactionWindow()
	maProv, maCfg := s.roleProvider("mainagent", prov, cfg) // 主 Agent 可绑独立模型(角色分工)
	s.cfgMu.Lock()
	s.mainAgent = agent.NewMainAgent(maProv, maCfg.Model, s.m.dir, tx, maCfg.CompactionWindow(), s.agentMaxTurns("mainagent"))
	s.mainAgent.SetProxy(s.m.ProxyAddr(), s.m.ProxyCACert()) // WebFetch through the recording proxy
	s.mainAgent.SetWebSearch(s.webSearchFor("mainagent"))
	// chat agent serves MANY custom agents by key → it holds the GLOBAL opts
	// (backend/key) and gates Enabled per-conversation-agent at Chat time. 对话始终用激活配置。
	s.chatAgent = agent.NewChatAgent(prov, cfg.Model, s.m.dir, tx, win) // chat page runner
	s.chatAgent.SetProxy(s.m.ProxyAddr(), s.m.ProxyCACert())
	s.chatAgent.SetWebSearch(s.m.WebSearchOpts())
	s.chatAgent.SetGuard(s.chatGuard())
	s.llmCfg = cfg
	s.llmOn = true
	s.cfgMu.Unlock()

	// wake the active task so a task created while idle starts exploring.
	if t := s.m.ActiveTask(); t != nil {
		t.Notify()
	}
	return nil
}

// loadProfileConfig builds an agent.Config from a specific profile id (with its key).
// ok=false when the profile is missing or has no api key.
func (s *Server) loadProfileConfig(id int64) (agent.Config, bool) {
	p, err := s.m.pg.ProfileByID(id)
	if err != nil || p == nil {
		return agent.Config{}, false
	}
	cfg := agent.ConfigFrom(p.Format, p.Model, p.BaseURL, p.APIKey, p.Proxy)
	cfg.RatePerSecond, cfg.RatePerMinute = p.RatePerSecond, p.RatePerMinute
	cfg.ContextWindowK = p.ContextWindowK
	cfg.ReasoningEffort = p.ReasoningEffort
	cfg.SessionHeaderKey = p.SessionHeaderKey
	if cfg.APIKey == "" {
		return cfg, false
	}
	return cfg, true
}

// agentsForProfile returns the dedicated planner/worker for a specific LLM profile,
// built + cached on first use (tasks on the same profile share one provider + limiter).
// nil,nil when the profile is invalid → the caller falls back to the global active pair.
func (s *Server) agentsForProfile(id int64) (*agent.Planner, *agent.Worker) {
	s.profMu.Lock()
	defer s.profMu.Unlock()
	if b := s.profAgents[id]; b != nil {
		return b.pl, b.wk
	}
	cfg, ok := s.loadProfileConfig(id)
	if !ok {
		return nil, nil
	}
	prov, err := cfg.NewProvider()
	if err != nil {
		log.Printf("[engine] build provider for LLM profile %d failed: %v", id, err)
		return nil, nil
	}
	prov = s.poolForBinding(id, prov, cfg) // a pinned task also fails over when the pool is on
	pl, wk := s.buildPlannerWorker(prov, cfg)
	s.profAgents[id] = &profBundle{pl: pl, wk: wk}
	log.Printf("[engine] built dedicated planner/worker for LLM profile %d (%s / %s)", id, cfg.Provider(), cfg.Model)
	return pl, wk
}

// chatAgentForProfile returns a ChatAgent built from a specific LLM profile, cached
// per profile id. Returns nil if the profile is missing or has no API key.
func (s *Server) chatAgentForProfile(id int64) *agent.ChatAgent {
	s.profMu.Lock()
	defer s.profMu.Unlock()
	if ca := s.profChatAgents[id]; ca != nil {
		return ca
	}
	cfg, ok := s.loadProfileConfig(id)
	if !ok {
		return nil
	}
	prov, err := cfg.NewProvider()
	if err != nil {
		log.Printf("[chat] build provider for LLM profile %d failed: %v", id, err)
		return nil
	}
	tx := transcript.NewStore(filepath.Join(s.m.dir, "transcripts"))
	win := cfg.CompactionWindow()
	ca := agent.NewChatAgent(prov, cfg.Model, s.m.dir, tx, win)
	ca.SetProxy(s.m.ProxyAddr(), s.m.ProxyCACert())
	ca.SetWebSearch(s.m.WebSearchOpts())
	ca.SetGuard(s.chatGuard())
	s.profChatAgents[id] = ca
	return ca
}

// invalidateProfileAgents drops the per-profile agent cache so a profile save/activate/
// delete rebuilds pinned tasks' planner/worker on their next round.
func (s *Server) invalidateProfileAgents() {
	s.profMu.Lock()
	s.profAgents = map[int64]*profBundle{}
	s.profChatAgents = map[int64]*agent.ChatAgent{}
	s.profMu.Unlock()
	s.provMu.Lock()
	s.provCache = map[int64]llm.Provider{} // bare providers too — a re-keyed/edited profile must rebuild
	s.provMu.Unlock()
}

// providerForProfile returns a bare llm.Provider for a profile id, built + cached on
// first use (so every agent + failover-member on the same profile shares one provider
// and rate limiter). Returns the resolved config too. ok=false when the profile is
// missing / keyless / can't build. Guarded by provMu (see the field comment) so it is
// safe to call while holding profMu (agentsForProfile → poolForBinding does exactly that).
func (s *Server) providerForProfile(id int64) (llm.Provider, agent.Config, bool) {
	cfg, ok := s.loadProfileConfig(id)
	if !ok {
		return nil, agent.Config{}, false
	}
	s.provMu.Lock()
	defer s.provMu.Unlock()
	if p := s.provCache[id]; p != nil {
		return p, cfg, true
	}
	prov, err := cfg.NewProvider()
	if err != nil {
		log.Printf("[llmpool] build provider for profile %d failed: %v", id, err)
		return nil, agent.Config{}, false
	}
	s.provCache[id] = prov
	return prov, cfg, true
}

func (s *Server) mainAgentRef() *agent.MainAgent {
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	return s.mainAgent
}

func (s *Server) chatAgentRef() *agent.ChatAgent {
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	return s.chatAgent
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Auth routes — exempt from JWT check (handled in requireAuth)
	mux.HandleFunc("GET /api/auth/status", s.authStatus)
	mux.HandleFunc("POST /api/auth/init", s.authInit)
	mux.HandleFunc("POST /api/auth/login", s.authLogin)
	mux.HandleFunc("POST /api/auth/change-password", s.authChangePassword)

	// 平台权限（多用户 RBAC）
	mux.HandleFunc("GET /api/rbac/me", s.rbacMe)
	mux.HandleFunc("GET /api/rbac/metadata", s.rbacMetadata)
	mux.HandleFunc("GET /api/rbac/users", s.rbacListUsers)
	mux.HandleFunc("POST /api/rbac/users", s.rbacCreateUser)
	mux.HandleFunc("PUT /api/rbac/users/{id}", s.rbacUpdateUser)
	mux.HandleFunc("DELETE /api/rbac/users/{id}", s.rbacDeleteUser)
	mux.HandleFunc("GET /api/rbac/roles", s.rbacListRoles)
	mux.HandleFunc("POST /api/rbac/roles", s.rbacCreateRole)
	mux.HandleFunc("PUT /api/rbac/roles/{id}", s.rbacUpdateRole)
	mux.HandleFunc("DELETE /api/rbac/roles/{id}", s.rbacDeleteRole)

	// 审计日志
	mux.HandleFunc("GET /api/audit/logs", s.auditLogs)

	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/stats", s.stats)
	mux.HandleFunc("GET /api/logs", s.getLogs)
	mux.HandleFunc("GET /api/logs/history", s.getLogsHistory)
	mux.HandleFunc("GET /api/logs/stream", s.streamLogs)

	// 一键更新（从 GitHub Release 拉新版、校验、暂存，重启交给守护脚本/systemd 完成换装）。
	// apply/rollback 是高危操作，RBAC 收归 admin（见 rbac_enforce.go 的管理员专属前缀表）。
	mux.HandleFunc("GET /api/update/check", s.updateCheck)
	mux.HandleFunc("POST /api/update/apply", s.updateApply)
	mux.HandleFunc("POST /api/update/rollback", s.updateRollback)
	mux.HandleFunc("GET /api/update/stream", s.updateStream)

	mux.HandleFunc("GET /api/tasks", s.listTasks)
	mux.HandleFunc("POST /api/tasks", s.createTask)
	mux.HandleFunc("GET /api/tasks/{id}", s.getTask)
	mux.HandleFunc("POST /api/tasks/{id}/control", s.control)
	mux.HandleFunc("PATCH /api/tasks/{id}", s.editTask)
	mux.HandleFunc("POST /api/active", s.setActive)

	mux.HandleFunc("GET /api/llm", s.getLLM)
	mux.HandleFunc("POST /api/llm", s.setLLM)
	mux.HandleFunc("POST /api/llm/test", s.testLLM)

	// asset system
	mux.HandleFunc("GET /api/assets", s.listAssets)
	mux.HandleFunc("GET /api/assets/counts", s.assetCounts)
	mux.HandleFunc("POST /api/assets", s.insertAssets)
	mux.HandleFunc("DELETE /api/assets", s.deleteAssets)

	// company system
	mux.HandleFunc("GET /api/companies", s.listCompanies)
	mux.HandleFunc("POST /api/companies", s.createCompany)
	mux.HandleFunc("GET /api/companies/{id}", s.getCompany)
	mux.HandleFunc("DELETE /api/companies/{id}", s.deleteCompany)
	mux.HandleFunc("POST /api/companies/{id}/scope", s.addCompanyScope)
	mux.HandleFunc("POST /api/companies/reattribute", s.reattribute)

	mux.HandleFunc("GET /api/exploration/frontier", s.frontier)
	mux.HandleFunc("GET /api/exploration/findings", s.findings)
	mux.HandleFunc("GET /api/exploration/intents", s.intents)
	mux.HandleFunc("GET /api/exploration/graph", s.explorationGraph)
	mux.HandleFunc("GET /api/exploration/activity", s.activity)
	mux.HandleFunc("GET /api/exploration/activity/stream", s.streamActivity)
	mux.HandleFunc("GET /api/exploration/activity/{seq}", s.activityDetail)
	mux.HandleFunc("GET /api/exploration/tokens", s.tokenStats)
	mux.HandleFunc("GET /api/tokens/daily", s.tokenDailyStats)
	mux.HandleFunc("GET /api/tokens/conversations", s.conversationTokens)

	mux.HandleFunc("GET /api/audit", s.getAudit)
	mux.HandleFunc("POST /api/gc", s.gc)
	mux.HandleFunc("GET /api/traffic", s.getTraffic)
	mux.HandleFunc("GET /api/traffic/exchange", s.getTrafficExchange)
	mux.HandleFunc("GET /api/traffic/meta", s.getTrafficMeta)
	mux.HandleFunc("GET /api/settings", s.getSettings)
	mux.HandleFunc("PUT /api/settings", s.putSettings)
	mux.HandleFunc("POST /api/settings/web-search/test", s.testWebSearch)
	mux.HandleFunc("POST /api/settings/global-proxy/test", s.testGlobalProxy)
	mux.HandleFunc("GET /api/report", s.getReport)
	mux.HandleFunc("POST /api/report/generate", s.generateReport)
	mux.HandleFunc("GET /api/report/status", s.reportStatus)
	mux.HandleFunc("GET /api/report/download", s.downloadReport)
	// 报告管理：设置(公司/logo/测试人员/CVSS) + logo 上传/预览 + 已生成报告清单
	mux.HandleFunc("GET /api/report-settings", s.getReportSettings)
	mux.HandleFunc("PUT /api/report-settings", s.putReportSettings)
	mux.HandleFunc("POST /api/report-assets/logo", s.uploadReportLogo)
	mux.HandleFunc("GET /api/report-assets/{file}", s.serveReportAsset)
	mux.HandleFunc("GET /api/reports", s.listReports)
	mux.HandleFunc("GET /api/reports/{id}/download", s.downloadReportByID)
	mux.HandleFunc("DELETE /api/reports/{id}", s.deleteReportByID)
	mux.HandleFunc("GET /api/report-templates", s.listReportTemplates)
	mux.HandleFunc("POST /api/report-templates", s.createReportTemplate)
	mux.HandleFunc("PUT /api/report-templates/{id}", s.updateReportTemplate)
	mux.HandleFunc("DELETE /api/report-templates/{id}", s.deleteReportTemplate)
	// 知识库（两层 RAG：全局 + 任务）。字面段路由比 /{id} 通配更具体，Go 1.22 mux 按具体度择优，不冲突。
	mux.HandleFunc("GET /api/knowledge", s.listKnowledge)
	mux.HandleFunc("POST /api/knowledge", s.createKnowledge)
	mux.HandleFunc("POST /api/knowledge/upload", s.uploadKnowledge)
	mux.HandleFunc("GET /api/knowledge/categories", s.knowledgeCategories)
	mux.HandleFunc("POST /api/knowledge/search", s.searchKnowledge)
	mux.HandleFunc("GET /api/knowledge/logs", s.knowledgeLogs)
	mux.HandleFunc("GET /api/knowledge/config", s.getKnowledgeConfig)
	mux.HandleFunc("PUT /api/knowledge/config", s.saveKnowledgeConfig)
	mux.HandleFunc("POST /api/knowledge/config/test", s.testKnowledgeEmbedder)
	mux.HandleFunc("POST /api/knowledge/reindex", s.reindexKnowledge)
	mux.HandleFunc("GET /api/knowledge/{id}", s.getKnowledge)
	mux.HandleFunc("PUT /api/knowledge/{id}", s.updateKnowledge)
	mux.HandleFunc("DELETE /api/knowledge/{id}", s.deleteKnowledge)
	// 漏洞补录：从任务会话转录提取漏洞，补建 finding 节点（探索图/发现页/报告同时补齐）
	mux.HandleFunc("POST /api/tasks/{id}/extract-findings", s.extractFindings)
	// 漏洞富化（管理层覆盖，键为探索节点 id）
	mux.HandleFunc("GET /api/findings/{id}", s.findingDetail)
	mux.HandleFunc("POST /api/findings/{id}/enrich", s.findingEnrich)
	mux.HandleFunc("GET /api/findings/{id}/enrich/status", s.findingEnrichStatus)
	mux.HandleFunc("PUT /api/findings/{id}", s.findingUpdate)
	// 漏洞证据截图（发现页/报告/MD 共用）
	mux.HandleFunc("POST /api/findings/{id}/evidence", s.uploadFindingEvidence)
	mux.HandleFunc("GET /api/findings/{id}/evidence", s.listFindingEvidence)
	mux.HandleFunc("GET /api/findings/{id}/evidence/{file}", s.serveFindingEvidence)
	mux.HandleFunc("PUT /api/findings/{id}/evidence/{eid}", s.updateFindingEvidence)
	mux.HandleFunc("DELETE /api/findings/{id}/evidence/{eid}", s.deleteFindingEvidence)
	// 漏洞↔流量关联（手动；引擎自动记录复用 db.LinkFindingTraffic）
	mux.HandleFunc("POST /api/findings/{id}/traffic", s.linkFindingTraffic)
	mux.HandleFunc("GET /api/findings/{id}/traffic", s.listFindingTraffic)
	mux.HandleFunc("DELETE /api/findings/{id}/traffic/{eid}", s.unlinkFindingTraffic)
	mux.HandleFunc("POST /api/chat", s.chat)
	mux.HandleFunc("POST /api/tasks/{id}/chat/stop", s.stopChat)

	// --- 管理后台 API (PostgreSQL 数据源; 新版数据库与管理后台方案) ---
	mux.HandleFunc("DELETE /api/tasks/{id}", s.pgDeleteTask)
	// Agents
	// conversations (chat page)
	mux.HandleFunc("GET /api/conversations", s.pgListConversations)
	mux.HandleFunc("POST /api/conversations", s.pgCreateConversation)
	mux.HandleFunc("PATCH /api/conversations/{id}", s.pgRenameConversation)
	mux.HandleFunc("PATCH /api/conversations/{id}/profile", s.pgUpdateConversation)
	mux.HandleFunc("DELETE /api/conversations/{id}", s.pgDeleteConversation)
	mux.HandleFunc("GET /api/conversations/{id}/messages", s.pgConversationMessages)
	mux.HandleFunc("POST /api/conversations/{id}/messages", s.pgSendConversationMessage)
	mux.HandleFunc("POST /api/conversations/{id}/stop", s.pgStopConversation)
	mux.HandleFunc("GET /api/conversations/{id}/messages/{seq}", s.pgConversationMsgDetail)

	mux.HandleFunc("GET /api/agents", s.pgListAgents)
	mux.HandleFunc("POST /api/agents", s.pgCreateAgent)
	mux.HandleFunc("GET /api/agents/{key}", s.pgGetAgent)
	mux.HandleFunc("PATCH /api/agents/{key}", s.pgUpdateAgent)
	mux.HandleFunc("DELETE /api/agents/{key}", s.pgDeleteAgent)
	mux.HandleFunc("PUT /api/agents/{key}/config", s.pgSaveAgentConfig)
	mux.HandleFunc("PUT /api/agents/{key}/prompt", s.pgSavePrompt)
	mux.HandleFunc("POST /api/agents/{key}/prompt/reset", s.pgResetPrompt)
	mux.HandleFunc("PUT /api/agents/{key}/wrapup", s.pgSaveWrapup)
	mux.HandleFunc("POST /api/agents/{key}/wrapup/reset", s.pgResetWrapup)
	mux.HandleFunc("PUT /api/agents/{key}/wrapup/task-timeout", s.pgSaveTaskTimeoutWrapup)
	mux.HandleFunc("POST /api/agents/{key}/wrapup/task-timeout/reset", s.pgResetTaskTimeoutWrapup)
	mux.HandleFunc("GET /api/agents/{key}/triggers", s.pgListTriggers)
	mux.HandleFunc("POST /api/agents/{key}/triggers", s.pgCreateTrigger)
	mux.HandleFunc("PATCH /api/triggers/{id}", s.pgUpdateTrigger)
	mux.HandleFunc("DELETE /api/triggers/{id}", s.pgDeleteTrigger)
	mux.HandleFunc("GET /api/agents/{key}/prompts", s.pgListPromptVersions)
	mux.HandleFunc("GET /api/agents/{key}/variables", s.pgPromptVars)
	mux.HandleFunc("POST /api/agents/{key}/prompt/preview", s.pgPreviewPrompt)
	mux.HandleFunc("GET /api/agents/{key}/visibility", s.pgGetAgentVisibility)
	mux.HandleFunc("PUT /api/agents/{key}/visibility", s.pgSetAgentVisibility)
	// 内置工具目录（描述/参数默认值可改、按 agent 绑定；key 与 handler 在代码层）
	mux.HandleFunc("GET /api/tools", s.pgListTools)
	mux.HandleFunc("PUT /api/tools/{key}", s.pgUpdateTool)
	mux.HandleFunc("POST /api/tools/custom", s.pgCreateCustomTool)
	mux.HandleFunc("POST /api/tools/custom/test", s.pgTestCustomTool)
	mux.HandleFunc("PUT /api/tools/custom/{key}", s.pgUpdateCustomTool)
	mux.HandleFunc("DELETE /api/tools/custom/{key}", s.pgDeleteCustomTool)
	mux.HandleFunc("POST /api/settings/python/detect", s.pgDetectPython)
	mux.HandleFunc("POST /api/tools/{key}/reset", s.pgResetTool)
	// MCP CRUD
	mux.HandleFunc("GET /api/mcp", s.pgListMCP)
	mux.HandleFunc("POST /api/mcp", s.pgSaveMCP)
	mux.HandleFunc("GET /api/mcp/stats", s.mcpStats)
	mux.HandleFunc("DELETE /api/mcp/{id}", s.pgDeleteMCP)
	mux.HandleFunc("GET /api/mcp/{id}/tools", s.pgMCPTools)
	mux.HandleFunc("POST /api/mcp/{id}/health", s.healthCheckMCP)
	mux.HandleFunc("POST /api/mcp/{id}/refresh", s.pgRefreshMCP)
	// 资产同步 — ScopeSentry 数据源
	mux.HandleFunc("GET /api/sync/scopesentry/status", s.syncSSStatus)
	mux.HandleFunc("POST /api/sync/scopesentry/datasource", s.syncSSDatasource)
	mux.HandleFunc("GET /api/sync/scopesentry/projects", s.syncSSProjects)
	mux.HandleFunc("GET /api/sync/scopesentry/tasks", s.syncSSTasks)
	mux.HandleFunc("POST /api/sync/scopesentry/sync", s.syncSSRun)
	// Skill CRUD (文件系统)
	mux.HandleFunc("GET /api/skills", s.fsListSkills)
	mux.HandleFunc("GET /api/skills/stats", s.fsSkillStats)
	mux.HandleFunc("POST /api/skills", s.fsCreateSkill)
	mux.HandleFunc("POST /api/skills/upload", s.fsUploadSkill)
	mux.HandleFunc("DELETE /api/skills/{name}", s.fsDeleteSkill)
	mux.HandleFunc("PUT /api/skills/{name}/meta", s.fsUpdateSkillMeta)
	mux.HandleFunc("POST /api/skills/{name}/dirs", s.fsCreateDir)
	mux.HandleFunc("GET /api/skills/{name}/files", s.fsListFiles)
	// {file...} captures path segments including slashes (e.g. scripts/extract.py)
	mux.HandleFunc("GET /api/skills/{name}/files/{file...}", s.fsReadFile)
	mux.HandleFunc("PUT /api/skills/{name}/files/{file...}", s.fsWriteFile)
	mux.HandleFunc("DELETE /api/skills/{name}/files/{file...}", s.fsDeletePath)
	// MCP 资源侧可见性（更具体的 skill 路由会优先匹配）
	mux.HandleFunc("GET /api/visibility/{kind}/{id}", s.pgResourceVisibility)
	mux.HandleFunc("POST /api/visibility/toggle", s.pgToggleVisibility)
	// Skill 可见性（按名称，更具体，优先于上面的通配路由）
	mux.HandleFunc("GET /api/visibility/skill/{name}", s.pgSkillVisibility)
	mux.HandleFunc("POST /api/visibility/skill/toggle", s.pgToggleSkillVisibility)
	// LLM 多 profile
	mux.HandleFunc("GET /api/llm/profiles", s.pgListProfiles)
	mux.HandleFunc("POST /api/llm/profiles", s.pgSaveProfile)
	mux.HandleFunc("DELETE /api/llm/profiles/{id}", s.pgDeleteProfile)
	mux.HandleFunc("POST /api/llm/profiles/active", s.pgActivateProfile)
	// LLM 轮询(故障转移)
	mux.HandleFunc("GET /api/llm/pool", s.pgLLMPoolStatus)
	mux.HandleFunc("POST /api/llm/pool", s.pgSetLLMPool)
	mux.HandleFunc("POST /api/llm/pool/reset", s.pgResetLLMPool)
	mux.HandleFunc("POST /api/llm/profiles/{id}/pool", s.pgSetProfilePool)
	// LLM 角色分工（各角色映射到某配置）
	mux.HandleFunc("GET /api/llm/roles", s.pgLLMRoles)
	mux.HandleFunc("POST /api/llm/roles", s.pgSetLLMRole)

	// 拦截规则管理
	mux.HandleFunc("GET /api/intercept/rules", s.interceptListRules)
	mux.HandleFunc("POST /api/intercept/rules", s.interceptCreateRule)
	mux.HandleFunc("PUT /api/intercept/rules/{id}", s.interceptUpdateRule)
	mux.HandleFunc("DELETE /api/intercept/rules/{id}", s.interceptDeleteRule)
	mux.HandleFunc("POST /api/intercept/rules/{id}/toggle", s.interceptToggleRule)
	mux.HandleFunc("GET /api/intercept/pending", s.interceptListPending)
	mux.HandleFunc("GET /api/intercept/pending/{id}", s.interceptGetOne)
	mux.HandleFunc("POST /api/intercept/pending/{id}/decide", s.interceptDecide)
	mux.HandleFunc("GET /api/intercept/history", s.interceptHistory)
	mux.HandleFunc("GET /api/intercept/task/{taskID}", s.interceptListTaskItems)
	mux.HandleFunc("GET /api/intercept/tool-config", s.interceptGetToolConfig)
	mux.HandleFunc("PUT /api/intercept/tool-config", s.interceptSetToolConfig)

	// /api/* goes through CORS + JWT; everything else is served by the embedded
	// frontend (public — auth is enforced client-side and on the API). With the
	// no-embed build the webui handler just 404s (run `next dev` separately).
	api := cors(s.requireAuth(mux))
	root := http.NewServeMux()
	root.Handle("/api/", api)
	root.Handle("/", s.webuiHandler())
	return root
}

// --- handlers ---

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	// version lets the frontend detect the swap after a one-click update completes
	// (it polls /api/health until the reported version changes).
	writeJSON(w, 200, map[string]any{"ok": true, "service": "antifox", "version": BuildVersion})
}

func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{}
	out["engine_mode"] = "idle"              // spec enum; overridden below when a task is active
	out["llm_configured"] = s.engine.Ready() // is an LLM provider installed at all
	if tr := s.m.Traffic(); tr != nil {
		c, _ := tr.Count()
		out["traffic"] = c
		out["traffic_enabled"] = true
	}
	if counts, err := s.m.Assets().CountsByType(); err == nil {
		total := 0
		for _, n := range counts {
			total += n
		}
		out["assets"] = total
		out["asset_counts"] = counts
	}

	// resolve the task: explicit ?task=<id> binds to that task (so a detail view
	// never silently follows a globally-changed active task); empty = active.
	taskParam := r.URL.Query().Get("task")
	t := s.m.ResolveTask(taskParam)
	if t == nil {
		if taskParam != "" && taskParam != "active" {
			writeErr(w, 404, "task not found")
			return
		}
		writeJSON(w, 200, out) // no task selected: only global fields
		return
	}

	st, _ := t.Store.Stats()
	out["exploration"] = st

	// per-task running state + heartbeat (distinct from "LLM configured").
	intents, _ := t.Store.ListByKind(db.KindIntent, 100000)
	inFlight := 0
	for _, in := range intents {
		if in.State == "running" {
			inFlight++
		}
	}
	goals, _ := t.Store.ListByKind(db.KindGoal, 10000)
	goalsMet := 0
	for _, g := range goals {
		if g.State == "met" {
			goalsMet++
		}
	}
	last := s.engine.LastActivity(t.ID)
	paused := s.engine.IsPaused(t.ID)
	running := s.engine.Ready() && s.engine.Started(t.ID) && !paused
	// stalled: running but no activity for a while and nothing in flight.
	stalled := running && inFlight == 0 && last > 0 && time.Now().Unix()-last > 60

	// engine_mode follows the spec enum (exploring|paused|stalled|idle).
	switch {
	case paused:
		out["engine_mode"] = "paused"
	case stalled:
		out["engine_mode"] = "stalled"
	case running:
		out["engine_mode"] = "exploring"
	default:
		out["engine_mode"] = "idle"
	}

	out["active_task"] = map[string]any{
		"id": t.ID, "description": t.Description, "goal": t.Goal,
		"running":       running,
		"paused":        paused,
		"in_flight":     inFlight,
		"last_activity": last,
		"stalled":       stalled,
		"goals_total":   len(goals),
		"goals_met":     goalsMet,
	}
	writeJSON(w, 200, out)
}

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	active := ""
	if t := s.m.ActiveTask(); t != nil {
		active = t.ID
	}
	list := s.m.List()
	toks, _ := s.m.PG().TokenTotalsAll()     // whole-task token totals, one query for all tasks
	lastAct, _ := s.m.PG().LastActivityAll() // persisted last-activity per task, one query
	goalCounts, _ := s.m.PG().GoalCountsAll() // goal progress per exploration, one query
	dtos := make([]TaskDTO, 0, len(list))
	for _, t := range list {
		status := "created"
		switch {
		case isTerminalStatus(t.Status): // 持久化终态优先（done/failed/timeout）
			status = t.Status
		case t.Paused || s.engine.IsPaused(t.ID):
			status = "paused"
		case s.engine.Ready() && s.engine.Started(t.ID):
			status = "running"
		}
		dto := taskDTO(t, status)
		dto.Tokens = tokenTotalDTO(toks[t.ExpID])
		// prefer the live in-memory heartbeat (fresher) and fall back to the
		// persisted max activity time (survives restarts) for run-duration display.
		dto.LastActivity = lastAct[t.ExpID]
		if live := s.engine.LastActivity(t.ID); live > dto.LastActivity {
			dto.LastActivity = live
		}
		gc := goalCounts[t.ExpID]
		dto.GoalsTotal = gc.Total
		dto.GoalsMet = gc.Met
		dtos = append(dtos, dto)
	}
	writeJSON(w, 200, map[string]any{"tasks": dtos, "active": active})
}

func (s *Server) setActive(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if !s.m.SetActive(req.ID) {
		writeErr(w, 404, "task not found")
		return
	}
	// resume the engine for the opened task (idempotent — no-op if already running).
	if t, ok := s.m.Task(req.ID); ok {
		s.engine.Run(s.ctx, t)
	}
	writeJSON(w, 200, map[string]any{"active": req.ID})
}

// control pauses/resumes a task's autonomous execution (planner + workers).
type editTaskReq struct {
	Name           string `json:"name"`
	Description    string `json:"description"`
	Goal           string `json:"goal"`
	TimeoutSeconds int    `json:"timeout_seconds"`
	LLMProfileID   *int64 `json:"llm_profile_id,omitempty"`
	Egress         string `json:"egress"`
}

// editTask edits a task's fields in place (免删重建). name/timeout/LLM take effect
// immediately; a changed goal/description steers subsequent planning (no auto
// re-decompose — pair with 继续运行 to act on a new goal).
func (s *Server) editTask(w http.ResponseWriter, r *http.Request) {
	t, ok := s.m.Task(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "task not found")
		return
	}
	var req editTaskReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad json: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Description) == "" {
		writeErr(w, 400, "描述不能为空")
		return
	}
	if req.LLMProfileID != nil {
		if _, ok := s.loadProfileConfig(*req.LLMProfileID); !ok {
			writeErr(w, 400, "所选 LLM 配置不存在或未设置 API Key")
			return
		}
	}
	if err := s.m.UpdateTask(t.ID, strings.TrimSpace(req.Name), req.Description, req.Goal, strings.TrimSpace(req.Egress), req.TimeoutSeconds, req.LLMProfileID); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	log.Printf("[task] #%s 已编辑", t.ID)
	writeJSON(w, 200, map[string]any{"id": t.ID, "ok": true})
}

func (s *Server) control(w http.ResponseWriter, r *http.Request) {
	t, ok := s.m.Task(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "task not found")
		return
	}
	var req struct {
		Action string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	switch req.Action {
	case "pause":
		s.engine.Pause(t.ID)
	case "resume":
		s.engine.Run(s.ctx, t) // ensure loops are alive, then un-pause + nudge
		s.engine.Resume(t)
	case "rerun":
		// 继续运行：把停下/结束的任务重激活(重置非终态+清运行时钟)，保留探索图，续跑。
		if err := s.m.ReactivateTask(t.ID); err != nil {
			writeErr(w, 500, "reactivate: "+err.Error())
			return
		}
		s.engine.Rerun(s.ctx, t)
		log.Printf("[task] #%s 继续运行(重跑)", t.ID)
		writeJSON(w, 200, map[string]any{"id": t.ID, "paused": false, "status": "running"})
		return
	default:
		writeErr(w, 400, "action must be pause|resume|rerun")
		return
	}
	paused := s.engine.IsPaused(t.ID)
	t.Paused = paused                                       // keep the in-memory task (shown in /api/tasks) in sync
	if err := s.m.SetTaskPaused(t.ID, paused); err != nil { // persist (survives restart)
		log.Printf("[control] persist paused %s: %v", t.ID, err)
	}
	log.Printf("[task] #%s %s", t.ID, map[bool]string{true: "已暂停", false: "已恢复"}[paused])
	writeJSON(w, 200, map[string]any{"id": t.ID, "paused": paused})
}

// getLLM returns the current LLM config (key never exposed).
func (s *Server) getLLM(w http.ResponseWriter, r *http.Request) {
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	writeJSON(w, 200, map[string]any{
		"configured":       s.llmOn,
		"provider":         s.llmCfg.Provider(),
		"model":            s.llmCfg.Model,
		"base_url":         s.llmCfg.BaseURL,
		"proxy":            s.llmCfg.Proxy,
		"key_set":          s.llmCfg.APIKey != "",
		"rate_per_second":  s.llmCfg.RatePerSecond,
		"rate_per_minute":  s.llmCfg.RatePerMinute,
		"context_window_k": s.llmCfg.ContextWindowK,
		"reasoning_effort": s.llmCfg.ReasoningEffort,
	})
}

// setLLM configures the LLM at runtime. A blank api_key keeps the existing key.
func (s *Server) setLLM(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider        string  `json:"provider"`
		Model           string  `json:"model"`
		BaseURL         string  `json:"base_url"`
		Proxy           string  `json:"proxy"`
		APIKey          string  `json:"api_key"`
		RatePerSecond   float64 `json:"rate_per_second"`
		RatePerMinute   float64 `json:"rate_per_minute"`
		ContextWindowK  int     `json:"context_window_k"`
		ReasoningEffort string  `json:"reasoning_effort"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	cfg := agent.ConfigFrom(req.Provider, req.Model, req.BaseURL, req.APIKey, req.Proxy)
	cfg.RatePerSecond, cfg.RatePerMinute = req.RatePerSecond, req.RatePerMinute
	cfg.ReasoningEffort = req.ReasoningEffort
	if k := req.ContextWindowK; k > 0 { // 0 = keep default (200K); cap at 1M
		if k > 1000 {
			k = 1000
		}
		cfg.ContextWindowK = k
	}
	if cfg.APIKey == "" {
		s.cfgMu.Lock()
		cfg.APIKey = s.llmCfg.APIKey // keep existing key if not re-entered
		s.cfgMu.Unlock()
	}
	if cfg.APIKey == "" {
		writeErr(w, 400, "api_key required")
		return
	}
	if err := s.applyLLM(cfg); err != nil {
		writeErr(w, 400, "provider init failed: "+err.Error())
		return
	}
	s.saveLLMConfig(cfg) // persist to DB
	log.Printf("[engine] LLM configured via UI: %s / %s", cfg.Provider(), cfg.Model)
	s.getLLM(w, r)
}

// testLLM makes a real minimal completion to verify the config works.
func (s *Server) testLLM(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider        string `json:"provider"`
		Model           string `json:"model"`
		BaseURL         string `json:"base_url"`
		Proxy           string `json:"proxy"`
		APIKey          string `json:"api_key"`
		ReasoningEffort string `json:"reasoning_effort"`
		ProfileID       *int64 `json:"profile_id"` // 测已存 profile 时传入：api_key 为空则用它存的 key
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	cfg := agent.ConfigFrom(req.Provider, req.Model, req.BaseURL, req.APIKey, req.Proxy)
	// mirror production: send the SAME thinking params so a provider that rejects the
	// reasoning_effort/thinking field fails the test too (no false "test ok, run 400").
	cfg.ReasoningEffort = req.ReasoningEffort
	// API Key 解析优先级：表单输入 > 指定 profile 存的 key > 全局配置的 key。
	// 已存 profile 的 key 不回传浏览器，所以测试已存配置时表单为空，需从 DB 取。
	if cfg.APIKey == "" && req.ProfileID != nil {
		if p, err := s.m.pg.ProfileByID(*req.ProfileID); err == nil && p != nil {
			cfg.APIKey = p.APIKey
		}
	}
	if cfg.APIKey == "" {
		s.cfgMu.Lock()
		cfg.APIKey = s.llmCfg.APIKey
		s.cfgMu.Unlock()
	}
	if cfg.APIKey == "" {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "未提供 API Key"})
		return
	}
	lat, err := agent.TestConnection(r.Context(), cfg)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "latency_ms": lat.Milliseconds(), "model": cfg.Model})
}

type createTaskReq struct {
	Name           string `json:"name"` // 简短任务名/目标(可选)
	Description    string `json:"description"`
	Goal           string `json:"goal"`
	LLMProfileID   *int64 `json:"llm_profile_id,omitempty"` // 指定运行本任务的 LLM 配置;省略/null=用激活配置
	TimeoutSeconds int    `json:"timeout_seconds"`          // 任务级超时(秒);0/省略=不限时
	Egress         string `json:"egress"`                   // 出口代理:''=跟随全局|'direct'=直连|'proxy'=走全局代理
}

func (s *Server) createTask(w http.ResponseWriter, r *http.Request) {
	var req createTaskReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad json: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Description) == "" {
		req.Description = "未命名任务"
	}
	// validate the pinned profile up front (must exist + be usable), so a bad id fails
	// task creation instead of silently falling back to the active profile at run time.
	if req.LLMProfileID != nil {
		if _, ok := s.loadProfileConfig(*req.LLMProfileID); !ok {
			writeErr(w, 400, "所选 LLM 配置不存在或未设置 API Key")
			return
		}
	}
	if req.TimeoutSeconds < 0 {
		req.TimeoutSeconds = 0
	}
	t, err := s.m.CreateTask(strings.TrimSpace(req.Name), req.Description, req.Goal, strings.TrimSpace(req.Egress), req.LLMProfileID, req.TimeoutSeconds)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	log.Printf("[task] 新建任务 #%s «%s» 目标: %s", t.ID, req.Description, req.Goal)
	// seed initial asset(s) from goal/description so the event-driven loop has a root.
	s.seed(t, req.Description+" "+req.Goal)
	// Return immediately — goal decomposition is async so the UI isn't blocked.
	writeJSON(w, 201, t)
	// Background: emit round-0 marker, decompose goals via LLM, then start engine.
	// Engine starts only after goals are seeded to avoid a race where the planner
	// fires before any goal nodes exist.
	go func() {
		s.engine.emitActivity(t, db.Activity{Worker: "planner", Kind: "round",
			Summary: "第 0 轮目标拆解"})
		goals := s.createGoals(s.ctx, t, func(r db.Activity) {
			s.engine.emitActivity(t, r)
		})
		for _, g := range goals {
			summary := g.Text
			if g.VulnClass != "" {
				summary = fmt.Sprintf("[%s] %s", g.VulnClass, g.Text)
			}
			s.engine.emitActivity(t, db.Activity{Worker: "planner", Kind: "text", Summary: summary})
		}
		s.engine.Run(s.ctx, t)
	}()
}

var (
	reURL    = regexp.MustCompile(`https?://[^\s'"]+`)
	reIPPort = regexp.MustCompile(`\b((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?`)
	reDomain = regexp.MustCompile(`\b((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(?::(\d{1,5}))?`)
)

// parseTarget extracts a target (scheme, host, port) from free text, supporting
// full URLs, IP[:port] and domain[:port]. ok=false when nothing parseable.
func parseTarget(text string) (scheme, host string, port int, ok bool) {
	text = strings.TrimSpace(text)
	if m := reURL.FindString(text); m != "" {
		if u, err := url.Parse(m); err == nil && u.Hostname() != "" {
			scheme = strings.ToLower(u.Scheme)
			host = strings.ToLower(u.Hostname())
			port = portOr(u.Port(), defaultPort(scheme))
			return scheme, host, port, true
		}
	}
	if m := reIPPort.FindStringSubmatch(text); m != nil {
		host = m[1]
		port = portOr(m[2], 80)
		return schemeForPort(port), host, port, true
	}
	if m := reDomain.FindStringSubmatch(text); m != nil {
		host = strings.ToLower(m[1])
		if m[2] == "" {
			return "https", host, 443, true
		}
		port = portOr(m[2], 443)
		return schemeForPort(port), host, port, true
	}
	return "", "", 0, false
}

func portOr(s string, d int) int {
	if n, err := strconv.Atoi(s); err == nil && n > 0 {
		return n
	}
	return d
}
func defaultPort(scheme string) int {
	if scheme == "http" {
		return 80
	}
	return 443
}
func schemeForPort(p int) string {
	if p == 443 || p == 8443 {
		return "https"
	}
	return "http"
}

// llmHost returns the host of the configured LLM endpoint (to keep it out of scope).
func (s *Server) llmHost() string {
	s.cfgMu.Lock()
	base := s.llmCfg.BaseURL
	s.cfgMu.Unlock()
	if base == "" {
		return ""
	}
	if u, err := url.Parse(base); err == nil {
		return strings.ToLower(u.Hostname())
	}
	return ""
}

func (s *Server) seed(t *Task, text string) {
	scheme, host, port, ok := parseTarget(text)
	if !ok {
		log.Printf("[seed] task %s: 未能从 %q 解析出目标 host/IP，不创建站点（请手动配置 scope）", t.ID, text)
		t.Notify()
		return
	}
	// P0-1 guard: never treat the configured LLM gateway as a target.
	if gw := s.llmHost(); gw != "" && host == gw {
		log.Printf("[seed] task %s: 目标 %q 是 LLM 网关，拒绝作为渗透目标", t.ID, host)
		t.Notify()
		return
	}

	u := scheme + "://" + host
	if !(scheme == "https" && port == 443) && !(scheme == "http" && port == 80) {
		u += ":" + strconv.Itoa(port)
	}
	var rootID int64
	if as := s.m.Assets(); as != nil {
		if net.ParseIP(host) != nil {
			rootID, _ = as.UpsertIP(db.UpsertIPReq{IP: host})
		} else if scheme == "https" || scheme == "http" {
			rootID, _ = as.UpsertHTTPService(db.UpsertHTTPServiceReq{URL: u})
		} else {
			rootID, _ = as.UpsertRootDomain(db.UpsertRootDomainReq{Domain: host})
		}
	}
	// anchor the seeded assets to this task's begin root as lineage/provenance
	// (the asset graph is global and shared; anchoring no longer gates reads).
	if rootID > 0 {
		if begin, _ := t.Store.OriginFactID(); begin > 0 {
			_ = t.Store.Anchor(begin, rootID)
		}
	}
	log.Printf("[seed] task %s: 目标站点 %s", t.ID, u)
	t.Notify()
}

func (s *Server) getTask(w http.ResponseWriter, r *http.Request) {
	t, ok := s.m.Task(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "task not found")
		return
	}
	writeJSON(w, 200, t)
}



func (s *Server) frontier(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeJSON(w, 200, []any{})
		return
	}
	fr, _ := t.Store.Frontier(atoiDefault(r.URL.Query().Get("limit"), 100))
	writeJSON(w, 200, taskNodeDTOs(fr))
}

func (s *Server) findings(w http.ResponseWriter, r *http.Request) {
	// 无 task 参数 → 全局「发现」页：从独立 findings 表读取（任务删除后 finding 依然保留）。
	// 带 task 参数 → 仅该任务（任务概览/发现 Tab 用），从 exploration_nodes 读（任务在则节点在）。
	taskParam := r.URL.Query().Get("task")
	if taskParam == "" {
		fs, _ := s.m.pg.ListFindings(500)
		out := make([]FindingDTO, 0, len(fs))
		for _, f := range fs {
			out = append(out, findingFromDB(f))
		}
		writeJSON(w, 200, s.mergeEnrichmentSummary(out))
		return
	}
	t := s.m.ResolveTask(taskParam)
	if t == nil {
		writeJSON(w, 200, []any{})
		return
	}
	f, _ := t.Store.ListByKind(db.KindFinding, 200)
	writeJSON(w, 200, s.mergeEnrichmentSummary(findingDTOsForTask(t, f)))
}

// mergeEnrichmentSummary overlays the enrichment name/target/status onto each
// finding DTO (keyed by node_id) so the list shows the polished name + status at
// a glance without a per-row fetch.
func (s *Server) mergeEnrichmentSummary(dtos []FindingDTO) []FindingDTO {
	ids := make([]int64, 0, len(dtos))
	for _, d := range dtos {
		if n, err := strconv.ParseInt(d.NodeID, 10, 64); err == nil && n > 0 {
			ids = append(ids, n)
		}
	}
	enr, _ := s.m.pg.GetFindingEnrichments(ids)
	evCount := s.m.pg.CountFindingEvidence(ids)
	trCount := s.m.pg.CountFindingTraffic(ids)
	for i := range dtos {
		n, _ := strconv.ParseInt(dtos[i].NodeID, 10, 64)
		if e, ok := enr[n]; ok {
			dtos[i].Enriched = true
			dtos[i].EnrName, dtos[i].EnrTarget, dtos[i].Status = e.Name, e.Target, e.Status
			dtos[i].CVSSScore = e.CVSSScore
			if e.Severity != "" {
				dtos[i].Severity = e.Severity // human severity override
			}
		}
		dtos[i].EvidenceCount = evCount[n]
		dtos[i].TrafficCount = trCount[n]
	}
	return dtos
}

func (s *Server) intents(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeJSON(w, 200, []any{})
		return
	}
	in, _ := t.Store.ListByKind(db.KindIntent, 300)
	writeJSON(w, 200, taskNodeDTOs(in))
}

// explorationGraph returns the whole exploration chain (task graph) as nodes+edges.
func (s *Server) explorationGraph(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeJSON(w, 200, map[string]any{"nodes": []any{}, "edges": []any{}})
		return
	}
	nodes, _ := t.Store.Nodes(2000)
	edges, _ := t.Store.Edges(5000)
	writeJSON(w, 200, map[string]any{"nodes": taskNodeDTOs(nodes), "edges": edgeDTOs(edges)})
}

// activity returns the worker execution step log (incremental via ?since=seq).
func (s *Server) activity(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeJSON(w, 200, map[string]any{"items": []any{}, "cursor": 0})
		return
	}
	since := int64(atoiDefault(r.URL.Query().Get("since"), 0))
	limit := atoiDefault(r.URL.Query().Get("limit"), 300)
	var intentPtr *int64
	if iv := r.URL.Query().Get("intent"); iv != "" {
		if n, err := strconv.ParseInt(iv, 10, 64); err == nil {
			intentPtr = &n
		}
	}
	items, cursor, err := t.Store.ActivityList(intentPtr, since, limit)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"items": activityDTOs(items), "cursor": cursor})
}

// tokenStats returns per-worker token usage (input/output/cache read/write) for a
// task — main agent, planner, and each work#N.
func (s *Server) tokenStats(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeJSON(w, 200, map[string]any{"workers": []any{}})
		return
	}
	stats, err := t.Store.TokenStatsByWorker()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	total, _ := t.Store.TokenTotal() // whole-task total (all agents)
	writeJSON(w, 200, map[string]any{"workers": stats, "total": tokenTotalDTO(total)})
}

// tokenDailyStats returns global token consumption aggregated by calendar day
// (UTC) across all tasks for the past ?days=N days (default 30).
func (s *Server) tokenDailyStats(w http.ResponseWriter, r *http.Request) {
	days := atoiDefault(r.URL.Query().Get("days"), 30)
	if s.m.pg == nil {
		writeJSON(w, 200, []any{})
		return
	}
	buckets, err := s.m.pg.TokenDailyAll(days)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if buckets == nil {
		buckets = []db.DailyTokenBucket{}
	}
	writeJSON(w, 200, buckets)
}

// conversationTokens returns per-conversation token summaries so the dashboard can
// merge chat (conversation) usage into its per-profile / daily token stats — which
// otherwise count only task (exploration) usage.
func (s *Server) conversationTokens(w http.ResponseWriter, r *http.Request) {
	if s.m.pg == nil {
		writeJSON(w, 200, []any{})
		return
	}
	rows, err := s.m.pg.ConversationTokenSummaries()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, rows)
}

// streamActivity is the live SSE tail: it replays history after ?since=<seq>, then
// pushes each newly appended activity for the task. The seq cursor makes history +
// live join gap-free; on reconnect the client passes its last seq to catch any
// dropped events. Optional ?intent=<id> scopes the stream to one worker session.
// getLogs returns recent backend log lines (Seq > since), newest-last.
func (s *Server) getLogs(w http.ResponseWriter, r *http.Request) {
	since := int64(atoiDefault(r.URL.Query().Get("since"), 0))
	limit := atoiDefault(r.URL.Query().Get("limit"), 500)
	lines, cursor := logSink.recent(since, limit)
	writeJSON(w, 200, map[string]any{"items": lines, "cursor": cursor})
}

// getLogsHistory returns older log lines from the DB (before a given db_id).
// GET /api/logs/history?before=<db_id>&limit=200
// Returns {items:[LogLine], has_more: bool}.
func (s *Server) getLogsHistory(w http.ResponseWriter, r *http.Request) {
	if s.m.pg == nil {
		writeJSON(w, 200, map[string]any{"items": []any{}, "has_more": false})
		return
	}
	before := int64(atoiDefault(r.URL.Query().Get("before"), 0))
	limit := atoiDefault(r.URL.Query().Get("limit"), 200)
	if limit > 500 {
		limit = 500
	}
	// If no before given, return the most recent DB rows (mirrors ring restore).
	var (
		rows []*db.DBLog
		err  error
	)
	if before <= 0 {
		rows, err = s.m.pg.RecentLogs(limit)
	} else {
		rows, err = s.m.pg.ListLogsBefore(before, limit)
	}
	if err != nil {
		writeErr(w, 500, "db: "+err.Error())
		return
	}
	items := make([]LogLine, 0, len(rows))
	for _, r := range rows {
		items = append(items, LogLine{
			DBID:  r.ID,
			TS:    r.CreatedAt.Format(time.RFC3339),
			Level: r.Level,
			Tag:   r.Tag,
			Text:  r.Text,
		})
	}
	writeJSON(w, 200, map[string]any{"items": items, "has_more": len(rows) == limit})
}

// streamLogs is the live SSE tail of the backend log: replays history after
// ?since=<seq>, then pushes each new line.
func (s *Server) streamLogs(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "streaming unsupported")
		return
	}
	since := int64(atoiDefault(r.URL.Query().Get("since"), 0))
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch, unsub := logSink.subscribe()
	defer unsub()
	send := func(l LogLine) {
		b, _ := json.Marshal(l)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}
	lines, cursor := logSink.recent(since, 1000)
	for _, l := range lines {
		send(l)
	}
	if cursor > since {
		since = cursor
	}
	flusher.Flush()

	ctx := r.Context()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case l, ok := <-ch:
			if !ok {
				return
			}
			if l.Seq <= since {
				continue
			}
			since = l.Seq
			send(l)
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) streamActivity(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeErr(w, 404, "task not found")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "streaming unsupported")
		return
	}
	var intentPtr *int64
	if iv := r.URL.Query().Get("intent"); iv != "" {
		if n, err := strconv.ParseInt(iv, 10, 64); err == nil {
			intentPtr = &n
		}
	}
	since := int64(atoiDefault(r.URL.Query().Get("since"), 0))

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable proxy buffering

	// Subscribe BEFORE replaying history so events in between aren't lost; dedup the
	// overlap by skipping channel events whose id was already replayed.
	ch, unsub := s.engine.Broadcaster().Subscribe(t.ID)
	defer unsub()

	sendSSE := func(a db.Activity) {
		b, _ := json.Marshal(activityDTO(a))
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}

	// Whole-task view (intentPtr==nil): replay the RECENT window + the full main-agent
	// conversation, so a long task (>2000 steps) still shows 编排会话 instead of the
	// first 2000 recon steps (which buried the conversation off-window → empty 会话).
	// Intent-scoped view: the intent's own steps, chronological.
	var items []db.Activity
	var cursor int64
	if intentPtr != nil {
		items, cursor, _ = t.Store.ActivityList(intentPtr, since, 2000)
	} else {
		items, cursor, _ = t.Store.ActivityReplay(since, 2000)
	}
	for _, a := range items {
		sendSSE(a)
	}
	if cursor > since {
		since = cursor
	}
	flusher.Flush()

	ctx := r.Context()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case a, ok := <-ch:
			if !ok {
				return
			}
			if a.ID <= since {
				continue // already replayed
			}
			if intentPtr != nil && (a.NodeID == nil || *a.NodeID != *intentPtr) {
				continue // scoped session: only this intent's steps
			}
			since = a.ID
			sendSSE(a)
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// activityDetail lazily returns the full detail blob for one step.
func (s *Server) activityDetail(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeErr(w, 404, "no task")
		return
	}
	seq, _ := strconv.ParseInt(r.PathValue("seq"), 10, 64)
	d, err := t.Store.ActivityDetail(seq)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"detail": d})
}


// parseTrafficFilter 从查询串解析高级筛选（路径 / 状态码桶 2xx..5xx / 响应长度区间）。
func parseTrafficFilter(q url.Values) traffic.TrafficFilter {
	f := traffic.TrafficFilter{
		Path:    strings.TrimSpace(q.Get("path")),
		RespMin: atoiDefault(q.Get("resp_min"), 0),
		RespMax: atoiDefault(q.Get("resp_max"), 0),
		Body:    strings.TrimSpace(q.Get("body")),
	}
	switch strings.TrimSpace(q.Get("status")) {
	case "2xx":
		f.StatusMin, f.StatusMax = 200, 299
	case "3xx":
		f.StatusMin, f.StatusMax = 300, 399
	case "4xx":
		f.StatusMin, f.StatusMax = 400, 499
	case "5xx":
		f.StatusMin, f.StatusMax = 500, 599
	}
	return f
}

// taskTrafficWindow returns the [start, end] Unix-second window of a task's activity,
// used to scope its recorded traffic (which has no task_id). start = first run (or
// creation if never run); end = completion time, or now if still running/paused — so a
// finished task never swallows a later task that reused the same target host.
// (0,0) when the task row is missing → window unbounded (host-only scoping, old behavior).
func (s *Server) taskTrafficWindow(taskID int64) (int64, int64) {
	tk, err := s.m.pg.GetTask(taskID)
	if err != nil || tk == nil {
		return 0, 0
	}
	start := tk.CreatedAt
	if tk.FirstRunAt != nil {
		start = *tk.FirstRunAt
	}
	end := time.Now()
	if tk.CompletedAt != nil {
		end = *tk.CompletedAt
	}
	return start.Unix(), end.Unix()
}

func (s *Server) getTraffic(w http.ResponseWriter, r *http.Request) {
	tr := s.m.Traffic()
	if tr == nil {
		writeJSON(w, 200, map[string]any{"enabled": false, "exchanges": []any{}})
		return
	}
	q := r.URL.Query()
	page := atoiDefault(q.Get("page"), 0)
	size := atoiDefault(q.Get("size"), 100)
	filter := parseTrafficFilter(q) // 高级筛选：路径 / 状态码桶 / 响应长度区间 / 正文关键词
	var ex []traffic.ExchangeMeta
	var matched, count int
	buckets := map[int]int{} // 状态码分布(2/3/4/5=2xx…)，按全量聚合(非 50 行样本)
	// task 过滤：流量按 host 存储、无任务字段，故用「该任务的资产主机集」+【任务活动时间窗】
	// 双重圈定。只按 host 圈会把同 host 的其它测试（如首次测试）也带进来；叠加时间窗后，
	// 同一 host 上不同时间跑的两次测试就能干净分开（与复现步骤↔流量关联用的是同一套窗口）。
	if taskID, _ := strconv.ParseInt(q.Get("task"), 10, 64); taskID > 0 {
		hosts, _ := s.m.Assets().HostsForTask(taskID)
		tmin, tmax := s.taskTrafficWindow(taskID)
		filter.TsMin, filter.TsMax = tmin, tmax
		ex, matched, _ = tr.PageHosts(hosts, q.Get("method"), q.Get("q"), filter, page, size)
		count = matched // task-scoped total (for the stat card)
		if len(hosts) > 0 {
			buckets, _ = tr.StatusCounts(hosts, tmin, tmax)
		}
	} else {
		ex, matched, _ = tr.Page(q.Get("host"), q.Get("method"), q.Get("q"), filter, page, size)
		count, _ = tr.Count() // global total, for the stat card
		buckets, _ = tr.StatusCounts(nil, 0, 0)
	}
	dtos := trafficDTOs(ex)
	// Body keyword → attach a highlighted snippet per row showing where it matched
	// (beats a bare match: you see the hit in context without opening each exchange).
	if filter.Body != "" {
		ids := make([]string, len(ex))
		for i, e := range ex {
			ids[i] = e.ID
		}
		snips := tr.BodyMatchSnippets(ids, filter.Body)
		for i := range dtos {
			dtos[i].MatchSnippet = snips[dtos[i].ID]
		}
	}
	writeJSON(w, 200, map[string]any{
		"enabled":       s.m.TrafficEnabled(), // reflect the capture toggle
		"proxy":         s.m.ProxyAddr(),
		"count":         count,   // total recorded (unfiltered)
		"total":         matched, // rows matching the current filter (for pagination)
		"page":          page,
		"size":          size,
		"exchanges":     dtos,
		"status_buckets": buckets, // {2:N,3:N,4:N,5:N} — true distribution for the dashboard
	})
}

// getTrafficExchange returns the full raw request/response of one exchange,
// read on demand from the traffic tree (bodies are not in the paged list).
func (s *Server) getTrafficExchange(w http.ResponseWriter, r *http.Request) {
	tr := s.m.Traffic()
	if tr == nil {
		writeErr(w, 404, "traffic disabled")
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		writeErr(w, 400, "missing id")
		return
	}
	req, resp, err := tr.Get(id)
	if err != nil {
		writeErr(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"req": req, "resp": resp})
}

// getTrafficMeta returns one exchange's metadata by id (method/status/url/host/…),
// so a deep-link from a finding can open that exact packet's detail even when it
// isn't on the current traffic page.
func (s *Server) getTrafficMeta(w http.ResponseWriter, r *http.Request) {
	tr := s.m.Traffic()
	if tr == nil {
		writeErr(w, 404, "traffic disabled")
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		writeErr(w, 400, "missing id")
		return
	}
	metas, err := tr.MetaByIDs([]string{id})
	if err != nil || len(metas) == 0 {
		writeErr(w, 404, "not found")
		return
	}
	writeJSON(w, 200, trafficDTOs(metas)[0])
}

// getSettings returns the runtime app settings the UI toggles. The Brave API key
// is returned as a boolean presence flag (brave_key_set), never the value itself,
// so the UI can show "configured" without echoing the secret back.
func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.settingsPayload())
}

func (s *Server) settingsPayload() map[string]any {
	on, backend, braveKey, tavilyKey, proxy := s.m.WebSearch()
	pyStored, _, _ := s.m.pg.GetSetting(settingPythonInterp)
	return map[string]any{
		"traffic_capture":     s.m.TrafficEnabled(),
		"web_search_enabled":  on,
		"web_search_backend":  backend,
		"brave_key_set":       strings.TrimSpace(braveKey) != "",
		"tavily_key_set":      strings.TrimSpace(tavilyKey) != "",
		"web_search_proxy":    proxy,                       // 独立出口代理(http/https/socks5)，空=直连
		"global_proxy":        s.m.GlobalProxy(),           // 全局出口代理：agent 目标流量经它出网(作 MITM 上游)，空=直连
		"python_interpreter":  strings.TrimSpace(pyStored), // 用户/自动设的值(空=用运行时检测)
		"workers":             s.m.Workers(),               // 并发工作 agent 数(默认3)；对之后启动的任务生效
	}
}

// pgDetectPython re-runs interpreter detection, stores + returns it.
func (s *Server) pgDetectPython(w http.ResponseWriter, r *http.Request) {
	p := detectPython()
	if p == "" {
		writeErr(w, 404, "未检测到 python(python3/python 均不在 PATH)")
		return
	}
	if err := s.m.pg.SetSetting(settingPythonInterp, p); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"python_interpreter": p})
}

// putSettings applies a settings change. Toggling traffic_capture rebuilds the
// agents (applyLLM) so the new proxy/traffic-tools/prompt state takes hold — when
// off, agents get no proxy config, no traffic tools, and no proxy prompt content.
func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TrafficCapture *bool `json:"traffic_capture"`
		// Web search. WebSearchEnabled/Backend toggle the tool + backend; BraveKey/TavilyKey
		// are optional — omit (null) to leave a stored key untouched, send "" to clear.
		WebSearchEnabled *bool   `json:"web_search_enabled"`
		WebSearchBackend *string `json:"web_search_backend"`
		BraveKey         *string `json:"brave_search_api_key"`
		TavilyKey        *string `json:"tavily_search_api_key"`
		WebSearchProxy   *string `json:"web_search_proxy"`   // 独立出口代理(http/https/socks5)；null=不改，""=清空
		GlobalProxy      *string `json:"global_proxy"`       // 全局出口代理(http/https/socks5)；null=不改，""=清空(直连)
		PythonInterp     *string `json:"python_interpreter"` // 自定义脚本工具的 python 解释器路径
		Workers          *int    `json:"workers"`            // 并发工作 agent 数(>0)；对之后启动的任务生效
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if req.Workers != nil {
		if err := s.m.SetWorkers(*req.Workers); err != nil {
			writeErr(w, 400, err.Error())
			return
		}
	}
	if req.GlobalProxy != nil {
		if err := s.m.SetGlobalProxy(*req.GlobalProxy); err != nil {
			writeErr(w, 400, err.Error()) // 代理 URL/scheme 非法
			return
		}
	}
	if req.PythonInterp != nil {
		if err := s.m.pg.SetSetting(settingPythonInterp, strings.TrimSpace(*req.PythonInterp)); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
	}
	changed := false
	if req.TrafficCapture != nil {
		if err := s.m.SetTrafficEnabled(*req.TrafficCapture); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		changed = true
	}
	if req.WebSearchEnabled != nil || req.WebSearchBackend != nil || req.BraveKey != nil || req.TavilyKey != nil || req.WebSearchProxy != nil {
		// Fill unspecified fields from current state so a partial PUT doesn't reset them.
		on, backend, _, _, _ := s.m.WebSearch()
		if req.WebSearchEnabled != nil {
			on = *req.WebSearchEnabled
		}
		if req.WebSearchBackend != nil {
			backend = *req.WebSearchBackend
		}
		if err := s.m.SetWebSearch(on, backend, req.BraveKey, req.TavilyKey, req.WebSearchProxy); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		changed = true
	}
	if changed {
		// rebuild agents so the new proxy/tools/prompt/web-search take hold (only if LLM configured).
		s.cfgMu.Lock()
		cfg, on := s.llmCfg, s.llmOn
		s.cfgMu.Unlock()
		if on {
			if err := s.applyLLM(cfg); err != nil {
				writeErr(w, 500, err.Error())
				return
			}
		}
	}
	writeJSON(w, 200, s.settingsPayload())
}

// testWebSearch runs a real "test" search with the given (or currently saved)
// backend/proxy/key to verify the config can actually reach a search backend —
// mirroring testLLM. Backend/proxy come from the request (so the form's unsaved
// edits are tested); empty API keys fall back to stored values so the user need
// not retype them. Always 200 with {ok, error?, count?, backend?}.
// egressProbes are plain-text IP-echo endpoints the proxy check tries in order
// until one answers with a valid IP. Relying on a single service is fragile — some
// are unreachable from restricted egress networks — so the check falls back across
// several rather than failing when the first one is unavailable.
var egressProbes = []string{
	"https://ifconfig.me/ip",
	"https://icanhazip.com",
	"https://api.ip.sb/ip",
	"https://api.ipify.org",
}

// testGlobalProxy verifies a global egress proxy works by fetching the egress IP through
// it (what a target would see — confirms the source IP is actually hidden). Tests the
// submitted proxy, or the saved one when blank; never persists.
func (s *Server) testGlobalProxy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Proxy string `json:"global_proxy"`
	}
	_ = decode(r, &body)
	raw := strings.TrimSpace(body.Proxy)
	if raw == "" {
		raw = s.m.GlobalProxy()
	}
	if raw == "" {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "未配置代理"})
		return
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5") {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "代理地址非法（需 http/https/socks5）"})
		return
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = http.ProxyURL(u)
	client := &http.Client{Transport: tr}
	var lastErr string
	for _, probe := range egressProbes {
		ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, probe, nil)
		start := time.Now()
		resp, err := client.Do(req)
		if err != nil {
			cancel()
			lastErr = err.Error()
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64))
		resp.Body.Close()
		cancel()
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Sprintf("HTTP %d", resp.StatusCode)
			continue
		}
		ip := strings.TrimSpace(string(raw))
		if net.ParseIP(ip) == nil {
			lastErr = "返回非 IP 响应"
			continue
		}
		writeJSON(w, 200, map[string]any{
			"ok":         true,
			"egress_ip":  ip,
			"latency_ms": time.Since(start).Milliseconds(),
		})
		return
	}
	if lastErr == "" {
		lastErr = "无可用检测节点"
	}
	writeJSON(w, 200, map[string]any{"ok": false, "error": lastErr})
}

func (s *Server) testWebSearch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Backend   string `json:"web_search_backend"`
		Proxy     string `json:"web_search_proxy"`
		BraveKey  string `json:"brave_search_api_key"`
		TavilyKey string `json:"tavily_search_api_key"`
	}
	// Empty body is fine — fall back entirely to the saved config below.
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		writeErr(w, 400, err.Error())
		return
	}
	_, backend, storedBraveKey, storedTavilyKey, _ := s.m.WebSearch()
	if strings.TrimSpace(req.Backend) != "" {
		backend = req.Backend
	}
	// Proxy is taken from the form as-is (empty = direct), so testing reflects exactly
	// what's shown — including an intentional "clear proxy to test direct" before saving.
	proxy := strings.TrimSpace(req.Proxy)
	// API keys are secrets the form omits when already saved, so fall back to stored.
	braveKey := storedBraveKey
	if strings.TrimSpace(req.BraveKey) != "" {
		braveKey = req.BraveKey
	}
	tavilyKey := storedTavilyKey
	if strings.TrimSpace(req.TavilyKey) != "" {
		tavilyKey = req.TavilyKey
	}
	// Hard cap so a slow/blocked proxy can't hang the request.
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	results, err := actool.WebSearchProbe(ctx, actool.WebSearchConfig{Backend: backend, BraveAPIKey: braveKey, TavilyAPIKey: tavilyKey, Proxy: proxy}, "test", 3)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error(), "backend": backend})
		return
	}
	if len(results) == 0 {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "搜索返回 0 条结果（可能被限流或代理不通）", "backend": backend})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "count": len(results), "backend": backend})
}

// chatTurnTimeout bounds a single main-agent steering turn so a network-stalled
// turn can't hang indefinitely (which would keep chatBusy set and block further
// human steering). On timeout the turn is cancelled and cleanly wound down.
const chatTurnTimeout = 5 * time.Minute

// chatLockFor returns the per-task serialization mutex, lazily created. Caller
// must hold s.chatMu.
func (s *Server) chatLockFor(id string) *sync.Mutex {
	m := s.chatLock[id]
	if m == nil {
		m = &sync.Mutex{}
		s.chatLock[id] = m
	}
	return m
}

func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeErr(w, 404, "no active task")
		return
	}
	var req struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	// Persist + broadcast the human turn so the 主 Agent 编排会话 survives page
	// reloads and updates live: the conversation lives in the activity stream as
	// worker="mainagent" (the per-task activity table, replayed via SSE).
	s.engine.emitActivity(t, db.Activity{Worker: "mainagent", Kind: "user", Summary: req.Message})
	if ma := s.mainAgentRef(); ma != nil {
		// 人工操舵优先：若有正在跑的一轮，先取消它（抢占），新消息接管——绝不因"忙"而拒收。
		// 旧行为在忙时返回 409，导致坏网络下卡住的一轮把用户的"暂停/梳理"指令挡在门外。
		// 用 per-task 互斥串行化：抢占后等旧轮次的清理走完再接管，避免与其 defer 竞态。
		s.chatMu.Lock()
		if c := s.chatCancel[t.ID]; c != nil {
			c()
		}
		lock := s.chatLockFor(t.ID)
		s.chatMu.Unlock()

		go func() {
			lock.Lock() // 等被抢占的旧轮次释放（其 defer 清 busy/cancel）后再接管
			defer lock.Unlock()

			// 单轮超时：坏网络/工具挂起时到点自动收尾，chatBusy 不再被无限占用而阻塞后续操舵。
			ctx, cancel := context.WithTimeout(s.ctx, chatTurnTimeout)
			s.chatMu.Lock()
			s.chatBusy[t.ID] = true
			s.chatCancel[t.ID] = cancel
			s.chatMu.Unlock()
			defer func() {
				cancel()
				s.chatMu.Lock()
				delete(s.chatBusy, t.ID)
				delete(s.chatCancel, t.ID)
				s.chatMu.Unlock()
			}()

			// emit every step (thinking/tool_use/tool_result/text/result) so the main
			// agent session shows its work live, like worker/planner.
			emit := func(rec db.Activity) { s.engine.emitActivity(t, rec) }
			maTaskID, _ := strconv.ParseInt(t.ID, 10, 64)
			if _, err := ma.Chat(ctx, maTaskID, s.m.Assets(), t.Store, t.Goal, req.Message, emit, t.Notify); err != nil && ctx.Err() == nil {
				s.engine.emitActivity(t, db.Activity{Worker: "mainagent", Kind: "text", IsError: true, Summary: "（主 Agent 出错：" + err.Error() + "）"})
			}
		}()
		writeJSON(w, 202, map[string]any{"status": "accepted", "mode": "llm"})
		return
	}
	reply := s.fallbackChat(t, req.Message)
	s.engine.emitActivity(t, db.Activity{Worker: "mainagent", Kind: "text", Summary: reply})
	writeJSON(w, 200, map[string]any{"reply": reply, "mode": "rule"})
}

// stopChat aborts the in-flight main-agent turn for a task (manual stop button).
// Mirrors pgStopConversation: cancels only the current turn; planner/workers are
// unaffected and continue running. The user can send a new message immediately.
func (s *Server) stopChat(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.PathValue("id"))
	if t == nil {
		writeErr(w, 404, "task not found")
		return
	}
	s.chatMu.Lock()
	cancel := s.chatCancel[t.ID]
	s.chatMu.Unlock()
	if cancel == nil {
		writeJSON(w, 200, map[string]any{"status": "idle"})
		return
	}
	cancel()
	writeJSON(w, 200, map[string]any{"status": "stopping"})
}

// fallbackChat is the no-LLM human-steering handler: simple命令 + 态势摘要.
func (s *Server) fallbackChat(t *Task, msg string) string {
	m := strings.TrimSpace(msg)
	lower := strings.ToLower(m)
	switch {
	case strings.HasPrefix(m, "意图") || strings.HasPrefix(lower, "intent"):
		text := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(m, "意图"), "intent"))
		_, _ = t.Store.AddIntent(map[string]any{"summary": text}, 9, nil, "human")
		return "已注入一条高优先级意图：" + text
	case strings.HasPrefix(m, "提示") || strings.HasPrefix(lower, "hint"):
		text := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(m, "提示"), "hint"))
		_, _ = t.Store.AddNode(db.KindHint, map[string]any{"text": text}, 0, "active", "human", nil)
		return "已记录提示，规划者下次会读到：" + text
	default:
		assetCounts, _ := s.m.Assets().CountsByType()
		assets := 0
		for _, c := range assetCounts {
			assets += c
		}
		fnd, _ := t.Store.ListByKind(db.KindFinding, 1000)
		fr, _ := t.Store.Frontier(1000)
		return fmt.Sprintf("（规则模式，未配置 LLM）当前态势：资产 %d，待领意图 %d，确认发现 %d。\n可用指令：以\"意图 ...\"注入意图，\"提示 ...\"给规划者提示。", assets, len(fr), len(fnd))
	}
}

func (s *Server) getReport(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeErr(w, 404, "no active task")
		return
	}
	findings, _ := t.Store.ListByKind(db.KindFinding, 1000) // 纯漏洞（事实是独立的 KindFact，不进报告）
	counts := map[string]int{}
	for _, ty := range []string{"root_domain", "ip", "subdomain", "app", "service", "endpoint"} {
		ns, _ := s.m.Assets().QueryByType(ty, 100000, 0)
		if len(ns) > 0 {
			counts[ty] = len(ns)
		}
	}
	md := report.Markdown(report.Input{
		Title: t.Description, Goal: t.Goal, GeneratedAt: time.Now(),
		AssetCounts: counts, Findings: findings,
	})
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write([]byte(md))
}

func (s *Server) getAudit(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeJSON(w, 200, []any{})
		return
	}
	writeJSON(w, 200, map[string]any{"entries": t.Guard.Audit(), "attributions": t.Guard.Attributions()})
}

// gc is a no-op stub (GC not yet implemented in the new asset store).
func (s *Server) gc(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"removed": 0})
}

// --- utils ---

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": msg})
}

func atoiDefault(s string, d int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return d
}
