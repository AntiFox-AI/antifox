package agent

import (
	"context"
	"fmt"

	"antifox/engine/agentcore"
	"antifox/engine/llm"
	"antifox/engine/permission"
	actool "antifox/engine/tool"
	"antifox/engine/transcript"
	"antifox/db"
)

// MainAgent is the thin human-interface orchestrator (docs §4.2 / §7). The human
// chats with it; it observes (read tools), and steers by injecting hints
// (→planner) or direct high-priority intents (→frontier). It does NOT run the
// autonomous intent-generation loop (that is the planner's job).
type MainAgent struct {
	prov        llm.Provider
	model       string
	tx          *transcript.Store // raw LLM conversation persistence (nil = off)
	window      int               // context window in tokens (for compaction)
	maxTurns    int               // max agent turns per run (0 = unlimited)
	proxyAddr   string            // recording proxy for WebFetch (empty = direct)
	proxyCACert string            // recording proxy's CA cert path (HTTPS verify)
	webSearch   WebSearchOpts     // web_search tool backend selection (off by default)
	workDir     string            // shared work dir (surfaced in prompt as artifact-output target)
}

func NewMainAgent(prov llm.Provider, model, workDir string, tx *transcript.Store, window, maxTurns int) *MainAgent {
	return &MainAgent{prov: prov, model: model, workDir: workDir, tx: tx, window: window, maxTurns: maxTurns}
}

// SetProxy points the main agent's WebFetch at the recording proxy plus the CA
// cert it trusts to verify HTTPS through it (empty addr = direct).
func (m *MainAgent) SetProxy(addr, caCert string) { m.proxyAddr, m.proxyCACert = addr, caCert }

// SetWebSearch selects the web_search backend for the main agent (off by default).
func (m *MainAgent) SetWebSearch(o WebSearchOpts) { m.webSearch = o }

// mainAgentDefaultTmpl is the built-in EDITABLE body (段 [A]) of the main agent
// prompt, seeded into agent_prompts. Goal is a {{.Goal}} template var; the 中间
// 产物输出规约 tail is code-owned (artifactSpec), appended after rendering.
const mainAgentDefaultTmpl = `你是一个授权渗透测试系统的"主 agent"，是人类操作员的接口。你不亲自探索、也不自主连续生成意图（那是规划者的工作）。你的职责：

1. 观察：用 graph_overview / list_findings / list_facts / list_assets / get_worker_output 回答人关于当前进展的问题。
2. 记录漏洞（重要，别漏）：凡是已由 worker 验证确认、或你复核确认的漏洞，**立即逐条调用 report_finding 落库**——每个漏洞一次调用，填 vulnclass（漏洞名/类型）、severity（critical|high|medium|low；critical=可直接导致系统/数据完全失陷，如 RCE、未授权任意文件读取拿到密钥/凭据、可接管账户的权限绕过等）、summary（含受影响目标）、evidence（可复现的请求/命令/响应等真实 PoC 原文），受影响资产有 id 就填 asset_ids；**并尽量填 reproduction 结构化复现过程**（entry_point 入口接口 / prerequisites 前置含测试账号如何注册 / steps 每步真实请求+预期+证明 / provenance 来源）——请求取自 worker 转录/真实执行的原文，别改写，这样报告能被人工从零复现。**确认即记录，不要征求许可、不要只在回复里罗列漏洞**——只有 report_finding 记下的漏洞才会进入发现页 / 探索图 / 报告；写在回复里但没记录=白做。先用 list_findings 看已记录的、避免重复。严禁把仅凭版本/CVE 匹配、"看起来可利用"的臆测当已确认漏洞上报。**暴露/信息泄露类也算发现**：worker 已证实的未授权可达敏感面（管理/调试接口、Swagger/API 文档、配置或备份/源码公开、敏感数据泄露端点等，有实际访问到的响应证据）同样逐条 report_finding（severity 按敏感度：一般信息泄露=low、未授权可达敏感/管理接口=medium、可直接接管或拿凭据=high），别只当资产/事实。**当用户让你"梳理当前发现"、或任务收尾/暂停时**：把图里 worker 已写回的、够格的漏洞与已证实暴露逐条落库（先 list_findings/list_facts 看已有、去重）——硬目标即使利用没打穿，也要把这些已证实的暴露/风险交出来，别只在回复里罗列。
3. 操舵（把人的意图落到系统）：
   - 人想"改方向/强调某类漏洞/重点某区域" → 用 add_hint 写提示（规划者下次会读到）。
   - 人想"立刻测某个具体目标" → 用 add_intent 直接注入一条高优先级意图（priority 8-10）。
4. 用人话简洁回复，说明你做了什么、记录了哪些漏洞。

当前任务目标：{{.Goal}}

不要编造发现；只根据工具返回的真实数据与已验证的证据来记录和回答。`

func mainAgentSystem(goal, workDir string) string {
	body := renderSystem("mainagent", mainAgentDefaultTmpl, MainVars{Goal: goal})
	return body + artifactSpec(workDir)
}

// Chat handles one human message and returns the assistant reply. emit, if
// non-nil, receives each execution step (thinking / tool_use / tool_result /
// text / result) so the main-agent session shows its work — exactly like the
// worker/planner sessions — not just the final answer.
func (m *MainAgent) Chat(ctx context.Context, taskID int64, as *db.AssetStore, ts *db.ExplorationStore, goal, message string, emit func(db.Activity), notify func()) (string, error) {
	tsx := NewToolSet(ts, "human")
	if as != nil {
		tsx.SetAssetStore(as, as.Companies())
	}
	tsx.SetTaskID(taskID)
	tsx.SetNotify(notify) // add_hint wakes this task's planner (debounced)
	// 领域工具 + 基础默认工具集（Read/Write/Edit/MultiEdit/LS/Glob/Grep/Bash）
	base := append(tsx.MainAgentTools(), actool.DefaultTools()...)
	tools, def, cleanup := AugmentTools(ctx, "mainagent", base)
	defer cleanup()
	system, boundary := deferredSystem(mainAgentSystem(goal, m.workDir), def)
	opts := agentcore.Options{
		Provider:        m.prov,
		SystemPrompt:    system,
		DynamicBoundary: boundary,
		Tools:           tools,
		DeferredTools:   def.Deferred,
		UnlockSet:       def.Unlock,
		PermissionMode:  permission.ModeBypass,
		EnableWebFetch:  true, // 走记录代理留痕；载入代理 CA 验证 MITM 重签的 HTTPS 证书
		WebFetchProxy:   m.proxyAddr,
		WebFetchCACert:  m.proxyCACert,
		// 联网搜索(可选)。ddgs 无需 key；brave-free 需 BraveKey；tavily 需 TavilyKey。
		// WebSearchProxy 是独立出口代理(http/https/socks5)，与记录流量的 MITM 代理无关；空则直连。
		EnableWebSearch:    m.webSearch.Enabled,
		WebSearchBackend:   m.webSearch.Backend,
		BraveSearchAPIKey:  m.webSearch.BraveKey,
		TavilySearchAPIKey: m.webSearch.TavilyKey,
		WebSearchProxy:     m.webSearch.Proxy,
		BashEnv:           proxyEnv(m.proxyAddr, m.proxyCACert), // Bash 子命令默认走代理+信任 CA
		MaxTurns:          m.maxTurns,                           // 0 = unlimited (configurable in agent management)
		Compaction:        compactionConfig(m.window),           // long chats stay within the window
		Todos:             actool.NewTodoStore(),                // 会话级临时待办（TodoWrite），纯规划用，退出即丢
		// 命中预算(步数)→ SDK 跑收尾:向用户输出一句进展总结。Prompt 与收尾轮数可后台编辑(默认 5 轮)。
		Settlement: wrapupSettlement("mainagent", nil),
	}
	if m.tx != nil { // persist raw human↔AI conversation; one accumulating file per task
		opts.Transcript = m.tx
		opts.SessionID = fmt.Sprintf("exp%d-main", ts.ID())
	}
	s := agentcore.NewSession(opts)
	defer s.Close()
	// reload the prior conversation from the transcript so the agent has context
	// across turns (each Chat is a fresh session; without this it can't see earlier
	// messages). First turn: no file yet → Resume loads nothing and proceeds.
	if m.tx != nil {
		_ = s.Resume(opts.SessionID)
	}
	// C2: this session is fresh each turn; re-unlock skill-gated MCPs from prior
	// Skill() calls in the reloaded history so revealed tools stay callable.
	seedUnlockFromHistory(s.Messages(), def.UnlockSkill)
	text, _, err := captureRunSession(ctx, s, message, func(r db.Activity) {
		if emit != nil {
			r.Worker = "mainagent"
			emit(r)
		}
	})
	return text, err
}
