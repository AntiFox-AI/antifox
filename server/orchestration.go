package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"antifox/agent"
	"antifox/engine/permission"
	actool "antifox/engine/tool"
)

// jsonResult marshals v to a JSON tool result.
func jsonResult(v any) (actool.Result, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return actool.Errorf(err.Error()), nil
	}
	return actool.Text(string(b)), nil
}

// 本文件实现 P2「跨任务编排工具集」(docs/跑分编排 §2 P2)。这些是 host 工具——需要
// 访问 Manager(任意任务的 Store)、Engine(暂停)、以及建任务流程,所以住在 server 层。
// 读类工具把「现有 per-task 工具」重定向到目标任务的 store 上跑(建一个临时 ToolSet
// 并 Call 其对应工具),从而复用完全相同的逻辑;控制类(spawn/pause)直接调 Manager/Engine。
// 它们像流量工具一样 seed 进 tools 表、按 agent 绑定(只绑给编排 agent 才可见)。

// hostTools is the runtime host-tool provider fed to ToolAugment: traffic tools
// (gated by capture) + cross-task orchestration tools + user-defined custom tools.
// The second return is the names of custom tools flagged `deferred` (schema
// withheld, routed via SearchExtraTools/ExecuteExtraTool). Per-agent binding still
// decides who actually sees any of them.
//
//nolint:unused // used as the hostTools provider in wireAgentAugment
func (s *Server) hostTools() ([]actool.CoreTool, map[string][]string) {
	tools := append(s.m.HostTools(), s.orchestrationTools()...)
	tools = append(tools, s.platformTools()...) // 平台操作工具(建改 skill/工具/MCP，给 Auto 用)
	custom, err := s.customTools()
	if err != nil {
		log.Printf("[custom-tool] load failed: %v", err)
		return tools, nil
	}
	tools = append(tools, custom...)
	// deferred custom tools → name -> its bound agent keys. ToolAugment turns a
	// name into a deferred entry only for agents it's actually bound to (so we don't
	// advertise a tool the per-agent binding will drop from the callable set).
	deferred := map[string][]string{}
	rows, _ := s.m.pg.ListCustomTools()
	for _, t := range rows {
		if t.Deferred && t.Enabled {
			deferred[t.Key] = t.Agents
		}
	}
	return tools, deferred
}

// orchestrationTools returns the cross-task tool set. Bound per-agent via the
// tools table (default: no binding — opt-in for orchestration agents).
func (s *Server) orchestrationTools() []actool.CoreTool {
	return []actool.CoreTool{
		s.toolListTasks(),
		s.toolListLLMProfiles(),
		s.toolSpawnTask(),
		s.toolPauseTask(),
		s.toolGetTaskGraph(),
		s.toolListTaskFindings(),
		s.toolAddHint(),
		s.toolGetWorkerTrace(),
		s.toolListWorkerTraces(),
		s.toolSearchWorkerTraces(),
	}
}

// --- schema helpers ---

func strParam(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

// parseProfileID reads an LLM profile id from a tool arg that may arrive as a JSON
// number (5) or a numeric string ("5"); returns 0 when absent/unparseable.
func parseProfileID(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	var n int64
	if json.Unmarshal(raw, &n) == nil {
		return n
	}
	var str string
	if json.Unmarshal(raw, &str) == nil {
		v, _ := strconv.ParseInt(strings.TrimSpace(str), 10, 64)
		return v
	}
	return 0
}

func objSchema(props map[string]any, required ...string) map[string]any {
	m := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		req := make([]any, len(required))
		for i, r := range required {
			req[i] = r
		}
		m["required"] = req
	}
	return m
}

func roTool(name, desc string, schema map[string]any, run func(context.Context, json.RawMessage) (actool.Result, error)) actool.CoreTool {
	return actool.Build(actool.Spec{
		Name: name, Description: desc, Schema: schema,
		ReadOnly:   func(json.RawMessage) bool { return true },
		Concurrent: func(json.RawMessage) bool { return true },
		Permissions: func(context.Context, json.RawMessage, permission.Context) permission.Decision {
			return permission.Allowed()
		},
		Run: func(ctx context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			return run(ctx, in)
		},
	})
}

func wrTool(name, desc string, schema map[string]any, run func(context.Context, json.RawMessage) (actool.Result, error)) actool.CoreTool {
	return actool.Build(actool.Spec{
		Name: name, Description: desc, Schema: schema,
		Permissions: func(context.Context, json.RawMessage, permission.Context) permission.Decision {
			return permission.Allowed()
		},
		Run: func(ctx context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			return run(ctx, in)
		},
	})
}

// delegateToTask resolves the `task_id` in the input, builds a ToolSet bound to
// that task's store, strips task_id, and calls the chosen per-task tool — so the
// cross-task read reuses the exact in-task logic against another task.
func (s *Server) delegateToTask(ctx context.Context, in json.RawMessage, pick func(*agent.ToolSet) actool.CoreTool) (actool.Result, error) {
	var head struct {
		TaskID string `json:"task_id"`
	}
	_ = json.Unmarshal(in, &head)
	if strings.TrimSpace(head.TaskID) == "" {
		return actool.Errorf("task_id is required"), nil
	}
	t, ok := s.m.Task(head.TaskID)
	if !ok {
		return actool.Errorf("task not found: " + head.TaskID), nil
	}
	var m map[string]json.RawMessage
	_ = json.Unmarshal(in, &m)
	delete(m, "task_id")
	inner, _ := json.Marshal(m)
	tsx := agent.NewToolSet(t.Store, "orchestrator")
	if s.m.Assets() != nil {
		tsx.SetAssetStore(s.m.Assets(), s.m.Assets().Companies())
	}
	tsx.SetNotify(t.Notify) // hint writes wake this task's planner (no-op for read tools)
	return pick(tsx).Call(ctx, inner, nil)
}

// --- tools ---

func (s *Server) toolListTasks() actool.CoreTool {
	return roTool("list_tasks",
		"List all tasks (id/description/goal/status/runtime/parent task/LLM config); the orchestration agent uses it for global awareness, spotting long-stuck tasks, and seeing which LLM each uses. Runtime: running=creation→now, terminal=creation→last activity (seconds). llm_profile: the config name the task's planner/worker uses; (active config) = follow the global active config.",
		objSchema(map[string]any{}),
		func(context.Context, json.RawMessage) (actool.Result, error) {
			lastAct, _ := s.m.PG().LastActivityAll()
			// id -> name to resolve each task's pinned LLM profile.
			profName := map[int64]string{}
			if profs, err := s.m.pg.ListProfiles(); err == nil {
				for _, p := range profs {
					profName[p.ID] = p.Name
				}
			}
			out := make([]map[string]any, 0)
			for _, t := range s.m.List() {
				status := s.deriveTaskStatus(t)
				end := lastAct[t.ExpID]
				if live := s.engine.LastActivity(t.ID); live > end {
					end = live
				}
				dur := int64(0)
				if status == "running" {
					dur = time.Now().Unix() - t.CreatedAt
				} else if end > t.CreatedAt {
					dur = end - t.CreatedAt
				}
				row := map[string]any{"id": t.ID, "description": t.Description, "goal": t.Goal, "status": status, "run_seconds": dur}
				if t.ParentRef != "" {
					row["parent_ref"] = t.ParentRef
				}
				if t.LLMProfileID == nil {
					row["llm_profile"] = "(active config)"
				} else if n, ok := profName[*t.LLMProfileID]; ok {
					row["llm_profile"] = n
				} else {
					row["llm_profile"] = fmt.Sprintf("#%d(deleted)", *t.LLMProfileID)
				}
				out = append(out, row)
			}
			return jsonResult(out)
		})
}

// toolListLLMProfiles lists the available LLM profiles (name/model/active) so an
// orchestration agent can pick one for spawn_task's llm_profile. Never leaks keys.
func (s *Server) toolListLLMProfiles() actool.CoreTool {
	return roTool("list_llm_profiles",
		"List available LLM profiles: id, name, model, format, and whether it is the currently active config. Use the id for spawn_task's llm_profile_id to give a subtask a dedicated LLM (e.g. cheap model for recon, strong model for exploitation). Does not include API keys.",
		objSchema(map[string]any{}),
		func(context.Context, json.RawMessage) (actool.Result, error) {
			profs, err := s.m.pg.ListProfiles()
			if err != nil {
				return actool.Errorf(err.Error()), nil
			}
			out := make([]map[string]any, 0, len(profs))
			for _, p := range profs {
				out = append(out, map[string]any{
					"id": p.ID, "name": p.Name, "model": p.Model, "format": p.Format, "is_active": p.IsDefault,
				})
			}
			return jsonResult(map[string]any{"profiles": out})
		})
}

func (s *Server) toolSpawnTask() actool.CoreTool {
	return wrTool("spawn_task",
		"Create a new subtask and start its exploration engine; returns a task_id. Use it to spin one item (e.g. a challenge/a target) into an independent task. parent_ref optional: the parent task id of the current orchestration, to link parent and child.",
		objSchema(map[string]any{
			"description":     strParam("task description (short title)"),
			"goal":            strParam("task goal (what to achieve)"),
			"parent_ref":      strParam("optional: parent task id (links parent and child)"),
			"llm_profile_id":  map[string]any{"type": "integer", "description": "optional: LLM profile id for this subtask's planner/worker (see list_llm_profiles); if empty, inherit from the parent task, then fall back to the global active config"},
			"timeout_seconds": map[string]any{"type": "integer", "description": "optional: task-level timeout in seconds. When it fires, a graceful wrap-up runs and the task enters the timeout terminal state; empty or 0 = no limit"},
		}, "description", "goal"),
		func(_ context.Context, in json.RawMessage) (actool.Result, error) {
			var a struct {
				Description, Goal, ParentRef string
				LLMProfileID                 json.RawMessage `json:"llm_profile_id"`
				TimeoutSeconds               int             `json:"timeout_seconds"`
			}
			_ = json.Unmarshal(in, &a)
			if strings.TrimSpace(a.Description) == "" {
				a.Description = "Unnamed task"
			}
			if strings.TrimSpace(a.Goal) == "" {
				return actool.Errorf("goal is required"), nil
			}
			if a.TimeoutSeconds < 0 {
				a.TimeoutSeconds = 0
			}
			// LLM profile resolution: explicit id > inherit parent's pin > active(nil).
			var pin *int64
			if id := parseProfileID(a.LLMProfileID); id > 0 {
				if _, ok := s.loadProfileConfig(id); !ok {
					return actool.Errorf(fmt.Sprintf("LLM profile #%d does not exist or has no API key set", id)), nil
				}
				pin = &id
			} else if a.ParentRef != "" {
				if pt, ok := s.m.Task(a.ParentRef); ok {
					pin = pt.LLMProfileID
				}
			}
			t, err := s.m.CreateTask("", a.Description, a.Goal, "", pin, a.TimeoutSeconds)
			if err != nil {
				return actool.Errorf(err.Error()), nil
			}
			if a.ParentRef != "" {
				t.ParentRef = a.ParentRef
				if id, e := strconv.ParseInt(t.ID, 10, 64); e == nil {
					_ = s.m.PG().SetParentRef(id, a.ParentRef)
				}
			}
			s.seed(t, a.Description+" "+a.Goal) // seed 初始资产，喂给事件驱动 loop
			s.createGoals(s.ctx, t, nil)        // 目标分解(LLM;规则兜底)
			s.engine.Run(s.ctx, t)              // 启动该任务的探索引擎
			return actool.Text(fmt.Sprintf("task created: %s", t.ID)), nil
		})
}

func (s *Server) toolPauseTask() actool.CoreTool {
	return wrTool("pause_task", "Pause the given task (stops its planner/worker loops).",
		objSchema(map[string]any{"task_id": strParam("id of the task to pause")}, "task_id"),
		func(_ context.Context, in json.RawMessage) (actool.Result, error) {
			var a struct {
				TaskID string `json:"task_id"`
			}
			_ = json.Unmarshal(in, &a)
			if _, ok := s.m.Task(a.TaskID); !ok {
				return actool.Errorf("task not found: " + a.TaskID), nil
			}
			s.engine.Pause(a.TaskID)
			return actool.Text("task paused: " + a.TaskID), nil
		})
}

func (s *Server) toolGetTaskGraph() actool.CoreTool {
	return roTool("get_task_graph", "Read the exploration-graph overview of the given task (same as graph_overview: asset counts/frontier/findings/coverage etc.), selected via task_id.",
		objSchema(map[string]any{"task_id": strParam("task id")}, "task_id"),
		func(ctx context.Context, in json.RawMessage) (actool.Result, error) {
			return s.delegateToTask(ctx, in, (*agent.ToolSet).GraphOverviewTool)
		})
}

func (s *Server) toolListTaskFindings() actool.CoreTool {
	return roTool("list_task_findings", "Read the confirmed vulnerabilities of the given task (with flag/PoC; each entry has id/task_id/intent_id/vulnclass/severity/summary/status), selected via task_id.",
		objSchema(map[string]any{"task_id": strParam("task id")}, "task_id"),
		func(ctx context.Context, in json.RawMessage) (actool.Result, error) {
			return s.delegateToTask(ctx, in, (*agent.ToolSet).ListFindingsTool)
		})
}

func (s *Server) toolAddHint() actool.CoreTool {
	return wrTool("add_task_hint", "Inject a strategic hint into the given task (its planner reads it when generating intents next round).\n"+
		"Prefer batching: put multiple hints into the hints array and submit once (returns an ids array, same length and order as hints; failed entries get id=0); for a single hint, omit hints and pass a top-level text.",
		objSchema(map[string]any{
			"task_id":   strParam("task id"),
			"hints":     map[string]any{"type": "array", "description": "Prefer this: array of hints; each element has the same fields as the top level (text/asset_ids).", "items": map[string]any{"type": "object"}},
			"text":      strParam("[single hint] hint content"),
			"asset_ids": map[string]any{"type": "array", "items": map[string]any{"type": "integer"}, "description": "asset ids to anchor to (optional, 0/1/many; asset ids within that task)"},
		}, "task_id"),
		func(ctx context.Context, in json.RawMessage) (actool.Result, error) {
			return s.delegateToTask(ctx, in, (*agent.ToolSet).AddHintTool)
		})
}

func (s *Server) toolGetWorkerTrace() actool.CoreTool {
	return roTool("get_task_worker_trace",
		"View the execution trace of a work (intent) in the given task: get_task_worker_trace(task_id, intent_id) shows step summaries; then pass step_ids=[...] to fetch the full content of those steps (max 5 at a time).",
		objSchema(map[string]any{
			"task_id":   strParam("task id"),
			"intent_id": map[string]any{"type": "integer", "description": "intent id (a work in that task)"},
			"step_ids":  map[string]any{"type": "array", "items": map[string]any{"type": "integer"}, "description": "optional: step ids whose full content to fetch (max 5)"},
		}, "task_id", "intent_id"),
		func(ctx context.Context, in json.RawMessage) (actool.Result, error) {
			return s.delegateToTask(ctx, in, (*agent.ToolSet).GetWorkerTraceTool)
		})
}

func (s *Server) toolListWorkerTraces() actool.CoreTool {
	return roTool("list_task_worker_traces", "List which works (intents) have run in the given task plus their step counts, to find which works are worth inspecting (then use get_task_worker_trace).",
		objSchema(map[string]any{"task_id": strParam("task id")}, "task_id"),
		func(ctx context.Context, in json.RawMessage) (actool.Result, error) {
			return s.delegateToTask(ctx, in, (*agent.ToolSet).ListWorkerTracesTool)
		})
}

func (s *Server) toolSearchWorkerTraces() actool.CoreTool {
	return roTool("search_task_worker_traces", "Search the execution traces of all works in the given task by keyword (returns matching step summaries + intent_id).",
		objSchema(map[string]any{"task_id": strParam("task id"), "q": strParam("search keyword")}, "task_id", "q"),
		func(ctx context.Context, in json.RawMessage) (actool.Result, error) {
			return s.delegateToTask(ctx, in, (*agent.ToolSet).SearchWorkerTracesTool)
		})
}

// deriveTaskStatus mirrors listTasks' status derivation for the list_tasks tool.
func (s *Server) deriveTaskStatus(t *Task) string {
	switch {
	case isTerminalStatus(t.Status):
		return t.Status
	case t.Paused || s.engine.IsPaused(t.ID):
		return "paused"
	case s.engine.Ready() && s.engine.Started(t.ID):
		return "running"
	}
	return "created"
}

// orchestrationToolSeeds seeds the cross-task tools into the tools table so they
// are bindable per-agent (default: bound to nobody — opt-in for orchestration
// agents). First-insert only, like the traffic seeds.
func (s *Server) seedOrchestrationTools() {
	// task-op + platform tools default-bind to the built-in Auto agent (它天生用来
	// 操作平台)。SeedTool 首插入生效;老库已 seed 的行由 seedAutoDefaultBindings 补绑。
	autoAgents, _ := json.Marshal([]string{"auto"})
	for _, t := range s.orchestrationTools() {
		schema, _ := json.Marshal(t.InputSchema())
		_ = s.m.PG().SeedTool(t.Name(), t.Description(), schema, autoAgents)
	}
	for _, t := range s.platformTools() {
		schema, _ := json.Marshal(t.InputSchema())
		_ = s.m.PG().SeedTool(t.Name(), t.Description(), schema, autoAgents)
	}
	s.refreshBuiltinToolSchemas()
	s.refreshReportFindingSchema() // 新增 reproduction 结构化复现过程参数 → 推到旧库,否则 agent 看不到
	s.seedAutoDefaultBindings()
	s.seedPlannerDefaultBindings()
	s.seedAutoReportFindingBinding()
	s.seedMainagentReportFindingBinding()
	s.reseedAgentPrompt("mainagent", "prompt_exposure_findings_mainagent_v1", "Record exposure/information-disclosure findings + persist proven exposures during synthesis")
	s.reseedAgentPrompt("worker", "prompt_exposure_findings_worker_v1", "Record exposure/information-disclosure issues as findings too")
	s.reseedAgentPrompt("pentest", "prompt_exposure_findings_pentest_v1", "Record exposure/information-disclosure issues as findings too")
	// 参考 AntiFox 0.3.4–0.3.6 的自主性提示词改进（适配我们无 coverage 子系统的口径）：
	s.reseedAgentPrompt("planner", "prompt_zerointent_acceptance_v1", "Zero-intent criteria rewrite (two valid justifications) + quantitative acceptance checks (no early wrap-up until targets met)")
	s.reseedAgentPrompt("worker", "prompt_negfact_threshold_v1", "Negative-conclusion evidence bar: always mark inferred until avenues are exhausted; never seal a direction with a hasty observed")
	// 就地记录复现过程：确认漏洞时在 report_finding 填结构化 reproduction（入口/前置/有序真实步骤/来源）。
	s.reseedAgentPrompt("worker", "prompt_reproduction_recipe_v1", "Fill report_finding with a structured reproduction recipe (recorded in place, requests verbatim and real)")
	s.reseedAgentPrompt("pentest", "prompt_reproduction_recipe_pentest_v1", "Fill report_finding with a structured reproduction recipe")
	s.reseedAgentPrompt("mainagent", "prompt_reproduction_recipe_mainagent_v1", "Fill report_finding with a structured reproduction recipe")
	s.bumpWorkerRunSecondsTo1200() // worker 单轮墙钟 600→1200s（仅未被自定义的默认值；参考 AntiFox 0.3.3）
	// 注：pentest 的默认工具绑定无需迁移——BuiltinToolSeeds 在全新初始化时就把
	// list_assets/insert_assets/report_finding/list_findings/list_companies 连同
	// pentest 一起 seed 好了（项目尚无旧库，不做迁移）。
}

// refreshBuiltinToolSchemas propagates code schema/description changes on the
// orchestration + platform tools into already-seeded rows ONCE per version flag —
// SeedTool is first-insert-only, so a new param (e.g. spawn_task 的 llm_profile) never
// reaches an old DB otherwise. Preserves each tool's agent binding + enabled flag.
// Bump the flag whenever these tools' schemas/descriptions change in code.
func (s *Server) refreshBuiltinToolSchemas() {
	const flag = "tool_schema_refresh_v4_goal_met_desc"
	if v, _, _ := s.m.pg.GetSetting(flag); v == "true" {
		return
	}
	tools := append(s.orchestrationTools(), s.platformTools()...)
	for _, t := range tools {
		schema, _ := json.Marshal(t.InputSchema())
		if err := s.m.pg.RefreshToolDefaults(t.Name(), t.Description(), schema); err != nil {
			log.Printf("[tools] refresh %s schema failed: %v", t.Name(), err)
		}
	}
	// 同时把 planner 的 goal_met 描述刷成代码默认：旧库 seed 的描述带“结束本轮规划”的
	// 误导，会让 planner 把 goal_met 当成“结束空轮”的手段、刚开跑就误判整个任务完成。
	for _, sd := range agent.BuiltinToolSeeds() {
		if sd.Key != "goal_met" {
			continue
		}
		schema, _ := json.Marshal(sd.Schema)
		if err := s.m.pg.RefreshToolDefaults(sd.Key, sd.Desc, schema); err != nil {
			log.Printf("[tools] refresh %s desc failed: %v", sd.Key, err)
		}
	}
	_ = s.m.pg.SetSetting(flag, "true")
	log.Printf("[tools] refreshed orchestration/platform tool schemas to code defaults (one-time)")
}

// seedAutoReportFindingBinding adds "auto" to report_finding's binding ONCE so
// conversation-context agents can call it without requiring an intent_id.
func (s *Server) seedAutoReportFindingBinding() {
	const flag = "auto_report_finding_v1"
	if v, _, _ := s.m.pg.GetSetting(flag); v == "true" {
		return
	}
	if err := s.m.pg.AddAgentToToolBinding("auto", []string{"report_finding"}); err != nil {
		log.Printf("[auto] report_finding default binding failed: %v", err)
		return
	}
	_ = s.m.pg.SetSetting(flag, "true")
}

// seedPlannerDefaultBindings adds "planner" to report_finding's binding ONCE
// (guarded by a settings flag), so existing DBs — whose report_finding row was
// seeded as worker-only — also let the planner record findings. Fresh DBs already
// get it via PlannerTools(); this only backfills without overriding a user unbind.
func (s *Server) seedPlannerDefaultBindings() {
	const flag = "planner_report_finding_v1"
	if v, _, _ := s.m.pg.GetSetting(flag); v == "true" {
		return
	}
	if err := s.m.pg.AddAgentToToolBinding("planner", []string{"report_finding"}); err != nil {
		log.Printf("[planner] report_finding default binding failed: %v", err)
		return
	}
	_ = s.m.pg.SetSetting(flag, "true")
}

// seedMainagentReportFindingBinding binds report_finding to the 主 Agent
// (mainagent) ONCE. Root-cause fix: the main agent synthesizes/confirms vulns in
// its orchestration conversation but, without this tool, could only READ findings
// (list_findings) — never record them — so its conclusions never became finding
// nodes (missing from 发现页 / 探索图 / 报告). Guarded by a flag; won't re-add
// after a deliberate user unbind.
func (s *Server) seedMainagentReportFindingBinding() {
	const flag = "mainagent_report_finding_v1"
	if v, _, _ := s.m.pg.GetSetting(flag); v == "true" {
		return
	}
	if err := s.m.pg.AddAgentToToolBinding("mainagent", []string{"report_finding"}); err != nil {
		log.Printf("[mainagent] report_finding default binding failed: %v", err)
		return
	}
	_ = s.m.pg.SetSetting(flag, "true")
	log.Printf("[mainagent] report_finding bound by default (the main agent can now record vulnerabilities)")
}

// bumpWorkerRunSecondsTo1200 raises the worker single-run wall-clock from the old
// 600s default to 1200s ONCE (guarded), for existing DBs. Only touches the untouched
// 600 default so a user-customized value is preserved. Fresh DBs already seed 1200.
// Runs inside seedOrchestrationTools (before applyLLM builds the worker), so the live
// worker picks up the new SetRunTimeout without a restart-after-migration.
func (s *Server) bumpWorkerRunSecondsTo1200() {
	const flag = "worker_run_seconds_1200_v1"
	if v, _, _ := s.m.pg.GetSetting(flag); v == "true" {
		return
	}
	if a, err := s.m.pg.GetAgentByKey("worker"); err == nil && a != nil && a.RunSecs == 600 {
		if err := s.m.pg.SetAgentRunSeconds("worker", 1200); err != nil {
			log.Printf("[worker] run_seconds 1200 migration failed: %v", err)
			return
		}
		log.Printf("[worker] default per-run wall clock 600→1200s")
	}
	_ = s.m.pg.SetSetting(flag, "true")
}

// reseedAgentPrompt force-updates ONE agent's DB prompt to the current code default
// ONCE (guarded by a settings flag). DB prompt overrides the code default, so a code
// change alone won't reach existing DBs — this bumps it. Use a FRESH flag whenever the
// code default changes again. Runs before any user edit; won't clobber later user edits
// (the flag is set on first apply).
func (s *Server) reseedAgentPrompt(key, flag, note string) {
	if v, _, _ := s.m.pg.GetSetting(flag); v == "true" {
		return
	}
	a, err := s.m.pg.GetAgentByKey(key)
	if err != nil || a == nil {
		return
	}
	tmpl, ok := agent.BuiltinPromptSeeds()[key]
	if !ok {
		return
	}
	// Fresh DBs just seeded this exact template as v1; appending an identical v2 is a
	// cosmetic duplicate in the version history. Skip the write when already current.
	if cur, _ := s.m.pg.CurrentPrompt(a.ID); cur == tmpl {
		_ = s.m.pg.SetSetting(flag, "true")
		return
	}
	if _, err := s.m.pg.SavePrompt(a.ID, tmpl, "System update: "+note, "system"); err != nil {
		log.Printf("[%s] prompt re-seed failed: %v", key, err)
		return
	}
	_ = s.m.pg.SetSetting(flag, "true")
	log.Printf("[%s] prompt updated (%s)", key, note)
}

// refreshReportFindingSchema pushes report_finding's CODE schema to the DB tools table
// ONCE (guarded). The runtime offers the DB-stored schema to the agent, and SeedTool is
// first-insert-only — so the newly-added structured `reproduction` param wouldn't reach
// existing DBs' agents without this. Won't clobber user param-default edits after the flag.
func (s *Server) refreshReportFindingSchema() {
	const flag = "tool_schema_refresh_report_finding_repro_v3" // v3: 要求每步写标准 HTTP 报文(非 curl)、响应不用...省略
	if v, _, _ := s.m.pg.GetSetting(flag); v == "true" {
		return
	}
	for _, sd := range agent.BuiltinToolSeeds() {
		if sd.Key != "report_finding" {
			continue
		}
		schema, _ := json.Marshal(sd.Schema)
		if err := s.m.pg.RefreshToolDefaults(sd.Key, sd.Desc, schema); err != nil {
			log.Printf("[tools] refresh report_finding schema failed: %v", err)
			return
		}
	}
	_ = s.m.pg.SetSetting(flag, "true")
	log.Printf("[tools] refreshed report_finding schema (added reproduction structured repro-steps parameter)")
}

// seedAutoDefaultBindings adds "auto" to the task-op + platform tools' bindings
// ONCE (guarded by a settings flag), so existing DBs whose tool rows were seeded
// before Auto existed still give Auto its default toolset — without re-adding it
// after a user deliberately unbinds.
func (s *Server) seedAutoDefaultBindings() {
	const flag = "auto_default_bindings_v3" // v3: 替换旧资产工具名，加入 insert_assets/add_company_scope
	if v, _, _ := s.m.pg.GetSetting(flag); v == "true" {
		return
	}
	keys := make([]string, 0, len(platformToolKeys)+12)
	for _, t := range s.orchestrationTools() {
		keys = append(keys, t.Name())
	}
	keys = append(keys, platformToolKeys...)
	// 资产工具：Auto 操作平台常要看/登记资产、管理公司范围。
	keys = append(keys, "insert_assets", "add_company_scope", "list_assets")
	if err := s.m.pg.AddAgentToToolBinding("auto", keys); err != nil {
		log.Printf("[auto] default binding failed: %v", err)
		return
	}
	_ = s.m.pg.SetSetting(flag, "true")
}
