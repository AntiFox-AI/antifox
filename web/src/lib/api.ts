// Real backend client. /api/* is proxied to the Go backend (next.config rewrites).
// Returns the domain types in lib/types.ts. Shapes match the backend handlers;
// a few fields the backend serializes differently (e.g. created_at as a unix int)
// are passed through and formatted at the call site.

import i18n from "@/i18n/config";
import { TOKEN_KEY } from "@/lib/auth";
import { MOCK } from "@/lib/mock/enabled";
import { mockHandle } from "@/lib/mock/handler";
import type {
  Task, Stats, Asset, AssetNode, Edge, Company, TaskNode, Finding, Activity,
  Audit, TrafficResp, TrafficDetail, TrafficExchange, Settings, LLMProfile, LLMPoolStatus, Agent, AgentDetail, PromptVar,
  PromptVersion, MCPServer, MCPStat, MCPStatsResp, MCPTool, SkillItem, SkillStatsResp, TokenUsage, TokenTotal, DailyTokenBucket,
  Tool, Conversation, AgentTrigger,
  InterceptRule, InterceptPending, InterceptApprovalRow,
  TaskAssetView, SSProject, SSTask, ConvTokenSummary,
  RBACUser, RBACRole, RBACMe, AuditLog, ReportJob, Enrichment, FindingDetailResp, EnrichJob, FindingEvidenceItem,
  ReportSettings, ReportRecord, ReportTemplate,
  KnowledgeDoc, KnowledgeHit, KnowledgeConfig, KnowledgeLog,
  UpdateCheck,
} from "@/lib/types";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  if (MOCK) return mockHandle<T>(init?.method ?? "GET", path, init?.body ?? null);
  const token = getToken();
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  // 后端滑动续期：活跃使用时下发新 token，替换本地存储（含 cookie 供同源 SSE）。
  const refreshed = r.headers.get("X-Refresh-Token");
  if (refreshed && typeof window !== "undefined") {
    localStorage.setItem(TOKEN_KEY, refreshed);
    document.cookie = `${TOKEN_KEY}=${encodeURIComponent(refreshed)}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;
  }
  if (r.status === 401) {
    // 认证端点(/auth/login 等)的 401 = 凭证错误，交调用方展示提示，切勿跳转刷新(否则登录失败提示被刷掉)。
    // 其它端点的 401 = 会话过期，清 token 并回登录页。
    if (!path.startsWith("/auth/") && typeof window !== "undefined") {
      localStorage.removeItem(TOKEN_KEY);
      document.cookie = `${TOKEN_KEY}=; path=/; max-age=0`;
      window.location.href = "/login";
    }
    const msg = await r.json().then((j) => j?.error).catch(() => null);
    throw new Error(msg || i18n.t("common.unauthorized"));
  }
  if (!r.ok) {
    const msg = await r.json().then((j) => j?.error).catch(() => null);
    throw new Error(msg || `${init?.method ?? "GET"} ${path}: ${r.status}`);
  }
  if (r.status === 204) return undefined as T;
  return r.json();
}

// sseUrl builds a URL for Server-Sent Events streams. SSE must NOT go through the
// Next.js dev `/api` rewrite: that proxy buffers the streamed response, so event
// frames never reach the browser (the EventSource opens but receives 0 messages).
// We therefore connect straight to the Go backend, whose CORS is open. Override
// with NEXT_PUBLIC_SSE_BASE; set it to "" to force same-origin (e.g. behind a
// production reverse proxy that flushes SSE correctly).
// Token is appended as ?token= because SSE bypasses the Next.js proxy and the
// browser does not send cookies cross-port.
// mockReport returns a canned Markdown report for the demo.
function mockReport(_task?: string): string {
  return `# AntiFox 渗透测试报告 — Acme Corp

## 概览
- 范围：acme.com（含 www / admin / api / shop / vpn 子域）
- 已确认发现：6 项（高危 3 · 中危 3 · 低危 2）
- 引擎模式：exploring

## 关键发现
1. **[高] 后台默认口令** admin.acme.com admin/admin123 → 可完全接管后台。
2. **[高] SQL 注入** www.acme.com/search?q= → 可读取 acme_prod 库。
3. **[高] IDOR** api.acme.com/v1/orders?id= → 可越权读取他人订单（含手机号/地址）。
4. **[中] 反射型 XSS**、**暴露 .git 源码**、**登录无速率限制**。

## 建议
- 后台强制改密 + 启用 MFA、封禁默认口令。
- search 接口参数化查询、输出编码。
- API 增加对象级授权校验（IDOR）、更换强 JWT 密钥。

> （demo）本报告由 mock 数据生成，仅用于界面演示。`;
}

export function sseUrl(path: string): string {
  const base =
    process.env.NEXT_PUBLIC_SSE_BASE ??
    (typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}:8787`
      : "");
  const token = getToken();
  const sep = path.includes("?") ? "&" : "?";
  return token ? `${base}${path}${sep}token=${encodeURIComponent(token)}` : `${base}${path}`;
}

const get = <T>(p: string) => http<T>(p);
const post = <T>(p: string, body?: unknown) => http<T>(p, { method: "POST", body: body ? JSON.stringify(body) : undefined });
const put = <T>(p: string, body?: unknown) => http<T>(p, { method: "PUT", body: body ? JSON.stringify(body) : undefined });
const patch = <T>(p: string, body?: unknown) => http<T>(p, { method: "PATCH", body: body ? JSON.stringify(body) : undefined });
const del = <T>(p: string) => http<T>(p, { method: "DELETE" });

// Go serializes nil slices as JSON null — coerce to [].
const arr = <T>(x: T[] | null | undefined): T[] => x ?? [];
const tq = (task?: string, sep: "?" | "&" = "?") => (task ? `${sep}task=${encodeURIComponent(task)}` : "");

export const api = {
  // ---- auth ----
  authStatus: () => get<{ initialized: boolean }>("/auth/status"),
  login: (username: string, password: string) =>
    post<{ token: string }>("/auth/login", { username, password }),
  initPassword: (password: string) =>
    post<{ token: string }>("/auth/init", { password }),
  changePassword: (oldPassword: string, newPassword: string) =>
    post<{ ok: boolean; token?: string }>("/auth/change-password", { old_password: oldPassword, new_password: newPassword }).then((r) => {
      // 改密会作废旧 token（含本次会话）；后端补发一张新 token，这里即时替换本地存储，
      // 避免当前用户下一次请求被登出（其它设备的旧 token 仍失效）。
      if (r.token && typeof window !== "undefined") {
        localStorage.setItem(TOKEN_KEY, r.token);
        document.cookie = `${TOKEN_KEY}=${encodeURIComponent(r.token)}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;
      }
      return r;
    }),

  // ---- tasks ----
  tasks: () => get<{ tasks: Task[]; active: string }>("/tasks").then((r) => ({ tasks: arr(r.tasks), active: r.active ?? "" })),
  createTask: (name: string, description: string, goal: string, llmProfileId?: number, timeoutSeconds?: number) =>
    post<Task>("/tasks", { name, description, goal, llm_profile_id: llmProfileId ?? null, timeout_seconds: timeoutSeconds ?? 0 }),
  deleteTask: (id: string) => del<{ deleted: number }>(`/tasks/${id}`),
  controlTask: (id: string, action: "pause" | "resume" | "rerun") => post<{ id: string; paused: boolean; status?: string }>(`/tasks/${id}/control`, { action }),
  updateTask: (id: string, body: { name?: string; description?: string; goal?: string; timeout_seconds?: number; llm_profile_id?: number | null }) =>
    patch<{ id: string; ok: boolean }>(`/tasks/${id}`, body),
  setActive: (id: string) => post<{ active: string }>("/active", { id }),
  // ---- stats ----
  stats: (task?: string) => get<Stats>(`/stats${tq(task)}`),

  // ---- assets ----
  // Server-side paginated: pass limit/offset, get back the page + full match total.
  assets: (type = "", limit = 50, offset = 0) =>
    get<{ count: number; total: number; assets: Asset[] }>(`/assets?type=${type}&limit=${limit}&offset=${offset}`)
      .then((r) => ({ assets: r?.assets ?? [], total: r?.total ?? r?.count ?? 0 })),
  searchAssets: (dsl: string, type = "", limit = 50, offset = 0) =>
    get<{ count: number; total: number; assets: Asset[] }>(
      `/assets?dsl=${encodeURIComponent(dsl)}${type ? `&type=${encodeURIComponent(type)}` : ""}&limit=${limit}&offset=${offset}`,
    ).then((r) => ({ assets: r?.assets ?? [], total: r?.total ?? r?.count ?? 0 })),
  assetCounts: (task = 0) => get<Record<string, number>>(`/assets/counts${task ? `?task=${task}` : ""}`),
  deleteAssets: (ids: number[]) =>
    http<{ deleted: number }>("/assets", { method: "DELETE", body: JSON.stringify({ ids }) }),
  // legacy — kept for task-specific views; hits the same endpoint with task_id filter
  taskAssets: (taskId: string, type = "") =>
    get<{ count: number; assets: Asset[] }>(`/assets?task_id=${taskId}&type=${type}`)
      .then((r) => r?.assets ?? []),

  // ---- companies (企业 + 资产范围；归属唯一来源) ----
  companies: (task = 0) => get<Company[]>(`/companies${task ? `?task=${task}` : ""}`).then(arr),
  createCompany: (name: string, logo: string, scope: string) =>
    post<{ id: number; created: boolean; scope_added?: number; scope_invalid?: number; scope_errors?: string[] }>(
      "/companies",
      { name, logo, scope: scope.trim() ? scope.split("\n").map((s) => s.trim()).filter(Boolean) : [] },
    ),
  addCompanyScope: (id: number, scope: string, reason = "") =>
    post<{ added: number; skipped: number; invalid: number; errors?: string[] }>(
      `/companies/${id}/scope`,
      { scope: scope.trim() ? scope.split("\n").map((s) => s.trim()).filter(Boolean) : [], reason },
    ),
  updateCompanyScope: (id: number, scope: string, reason = "") =>
    post<{ added: number; skipped: number; invalid: number; errors?: string[] }>(
      `/companies/${id}/scope`,
      { scope: scope.trim() ? scope.split("\n").map((s) => s.trim()).filter(Boolean) : [], reason, reset: true },
    ),
  deleteCompany: (id: number, deleteAssets = false) =>
    http<{ deleted: number; assets_deleted: number }>(`/companies/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ delete_assets: deleteAssets }),
    }),

  // ---- exploration (per task) ----
  frontier: (task?: string) => get<TaskNode[]>(`/exploration/frontier${tq(task)}`).then(arr),
  findings: (task?: string) => get<Finding[]>(`/exploration/findings${tq(task)}`).then(arr),
  intents: (task?: string) => get<TaskNode[]>(`/exploration/intents${tq(task)}`).then(arr),
  tokenStats: (task?: string) =>
    get<{ workers: TokenUsage[]; total: TokenTotal }>(`/exploration/tokens${tq(task)}`).then((r) => ({
      workers: arr(r.workers),
      total: r.total,
    })),
  tokenDaily: (days = 30) =>
    get<DailyTokenBucket[]>(`/tokens/daily?days=${days}`).then(arr),
  conversationTokens: () =>
    get<ConvTokenSummary[]>("/tokens/conversations").then(arr).catch(() => [] as ConvTokenSummary[]),
  explorationGraph: (task?: string) => get<{ nodes: TaskNode[]; edges: Edge[] }>(`/exploration/graph${tq(task)}`),
  activity: (task?: string, opts?: { intent?: string; since?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (task) q.set("task", task);
    if (opts?.intent) q.set("intent", opts.intent);
    if (opts?.since) q.set("since", String(opts.since));
    if (opts?.limit) q.set("limit", String(opts.limit));
    return get<{ items: Activity[]; cursor: number }>(`/exploration/activity?${q.toString()}`).then((r) => ({ items: arr(r.items), cursor: r.cursor ?? 0 }));
  },
  activityDetail: (id: number, task?: string) => get<{ detail: string }>(`/exploration/activity/${id}${tq(task)}`),

  // ---- traffic / audit / report / chat ----
  audit: (task?: string) => get<Audit>(`/audit${tq(task)}`),
  traffic: (
    page = 0,
    size = 100,
    host = "",
    method = "",
    q = "",
    task = 0,
    adv?: { path?: string; status?: string; respMin?: number; respMax?: number; body?: string },
  ) =>
    get<TrafficResp>(
      `/traffic?page=${page}&size=${size}` +
        (task ? `&task=${task}` : "") +
        (host ? `&host=${encodeURIComponent(host)}` : "") +
        (method && method !== "all" ? `&method=${encodeURIComponent(method)}` : "") +
        (q ? `&q=${encodeURIComponent(q)}` : "") +
        (adv?.path ? `&path=${encodeURIComponent(adv.path)}` : "") +
        (adv?.status && adv.status !== "all" ? `&status=${adv.status}` : "") +
        (adv?.respMin ? `&resp_min=${adv.respMin}` : "") +
        (adv?.respMax ? `&resp_max=${adv.respMax}` : "") +
        (adv?.body ? `&body=${encodeURIComponent(adv.body)}` : ""),
    ),
  trafficExchange: (id: string) =>
    get<TrafficDetail>(`/traffic/exchange?id=${encodeURIComponent(id)}`),
  // One exchange's metadata by id — for deep-linking from a finding to the exact packet.
  trafficMeta: (id: string) =>
    get<TrafficExchange>(`/traffic/meta?id=${encodeURIComponent(id)}`),

  // ---- app settings (runtime toggles) ----
  settings: () => get<Settings>(`/settings`),
  setSettings: (patch: Partial<Settings>) => put<Settings>(`/settings`, patch),
  // Run a real "test" search with the given (or saved) config to verify it works.
  testWebSearch: (patch: { web_search_backend?: string; web_search_proxy?: string; brave_search_api_key?: string; tavily_search_api_key?: string }) =>
    post<{ ok: boolean; error?: string; count?: number; backend?: string }>(`/settings/web-search/test`, patch),

  // ---- 一键更新（GitHub Release → 校验 → 暂存 → 守护脚本重启换装）----
  updateCheck: (force = false) => get<UpdateCheck>(`/update/check${force ? "?force=1" : ""}`),
  updateApply: () => post<{ ok: boolean; target: string }>(`/update/apply`, {}),
  updateRollback: () => post<{ ok: boolean }>(`/update/rollback`, {}),
  updateStreamUrl: () => sseUrl("/update/stream"),
  report: async (task?: string) => {
    if (MOCK) return mockReport(task);
    const token = getToken();
    const r = await fetch(`/api/report${tq(task)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!r.ok) throw new Error(`report: ${r.status}`);
    return r.text();
  },
  // ---- Word (.docx) report: AI narrative + python-docx pipeline ----
  reportGenerate: (
    task?: string,
    opts?: {
      company?: string;
      client?: string;
      title?: string;
      locale?: string;
      findingIds?: string[];
      templateId?: number;
      format?: string; // "" / docx | md
    },
  ) => {
    const qs = new URLSearchParams();
    if (task) qs.set("task", task);
    if (opts?.company) qs.set("company", opts.company);
    if (opts?.client) qs.set("client", opts.client);
    if (opts?.title) qs.set("title", opts.title);
    if (opts?.locale) qs.set("locale", opts.locale);
    if (opts?.findingIds && opts.findingIds.length) qs.set("finding_ids", opts.findingIds.join(","));
    if (opts?.templateId) qs.set("template_id", String(opts.templateId));
    if (opts?.format) qs.set("format", opts.format);
    return post<ReportJob>(`/report/generate?${qs.toString()}`, {});
  },
  reportStatus: (task?: string) => get<ReportJob>(`/report/status${tq(task)}`),
  reportDownloadUrl: (task?: string) => `/api/report/download${tq(task)}`,
  // 从任务会话转录补录漏洞（AI 提取被描述但未落库的确认漏洞 → finding 节点）
  extractFindings: (taskId: string) =>
    post<{ extracted: number; created: number }>(`/tasks/${taskId}/extract-findings`, {}),
  // ---- 报告管理（组织级设置 + 报告清单）----
  reportSettings: () => get<ReportSettings>(`/report-settings`),
  saveReportSettings: (patch: Partial<ReportSettings>) => put<ReportSettings>(`/report-settings`, patch),
  reports: () => get<ReportRecord[]>(`/reports`).then(arr),
  reportRecordDownloadUrl: (id: number) => `/api/reports/${id}/download`,
  deleteReport: (id: number) => del<{ ok: boolean }>(`/reports/${id}`),
  // ---- named report templates (reusable cover/org presets) ----
  reportTemplates: () => get<ReportTemplate[]>(`/report-templates`).then(arr),
  createReportTemplate: (body: Partial<ReportTemplate>) => post<ReportTemplate>(`/report-templates`, body),
  updateReportTemplate: (id: number, body: Partial<ReportTemplate>) => put<ReportTemplate>(`/report-templates/${id}`, body),
  deleteReportTemplate: (id: number) => del<{ ok: boolean }>(`/report-templates/${id}`),
  // ---- 知识库（两层 RAG：全局 + 任务）----
  knowledgeDocs: (scope = "", task = 0) =>
    get<KnowledgeDoc[]>(`/knowledge?scope=${encodeURIComponent(scope)}&task=${task}`).then(arr),
  knowledgeDoc: (id: number) => get<KnowledgeDoc>(`/knowledge/${id}`),
  createKnowledgeDoc: (body: Partial<KnowledgeDoc>) => post<KnowledgeDoc>(`/knowledge`, body),
  updateKnowledgeDoc: (id: number, body: Partial<KnowledgeDoc>) => put<KnowledgeDoc>(`/knowledge/${id}`, body),
  deleteKnowledgeDoc: (id: number) => del<{ ok: boolean }>(`/knowledge/${id}`),
  knowledgeCategories: (task = 0) => get<string[]>(`/knowledge/categories?task=${task}`).then(arr),
  knowledgeSearch: (query: string, taskId = 0, topK = 5) =>
    post<{ mode: string; hits: KnowledgeHit[] }>(`/knowledge/search`, { query, task_id: taskId, top_k: topK }),
  knowledgeLogs: () => get<KnowledgeLog[]>(`/knowledge/logs`).then(arr),
  knowledgeConfig: () => get<KnowledgeConfig>(`/knowledge/config`),
  saveKnowledgeConfig: (body: Partial<KnowledgeConfig>) => put<{ ok: boolean }>(`/knowledge/config`, body),
  testKnowledgeEmbedder: () => post<{ ok: boolean; dim: number }>(`/knowledge/config/test`, {}),
  reindexKnowledge: () => post<{ ok: boolean; indexed: number }>(`/knowledge/reindex`, {}),
  uploadKnowledgeDoc: async (file: File, scope: string, taskId: number, category: string) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("scope", scope);
    fd.append("task_id", String(taskId));
    fd.append("category", category);
    const token = getToken();
    const r = await fetch(`/api/knowledge/upload`, {
      method: "POST",
      body: fd,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error || `上传失败(${r.status})`);
    return body as KnowledgeDoc;
  },
  uploadReportLogo: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const token = getToken();
    const r = await fetch(`/api/report-assets/logo`, {
      method: "POST",
      body: fd,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error || `上传失败(${r.status})`);
    return body as { logo_path: string; url: string };
  },
  // ---- finding enrichment (漏洞管理深化) — keyed by exploration node_id ----
  findingDetail: (nodeId: string) => get<FindingDetailResp>(`/findings/${nodeId}`),
  // AI 分析 is async: POST starts (or re-attaches to) the job, GET status polls it.
  // The generation runs server-side on the app ctx, so switching pages can't abort it.
  findingEnrich: (nodeId: string, locale?: string) =>
    post<EnrichJob>(`/findings/${nodeId}/enrich${locale ? `?locale=${encodeURIComponent(locale)}` : ""}`, {}),
  findingEnrichStatus: (nodeId: string) => get<EnrichJob>(`/findings/${nodeId}/enrich/status`),
  findingUpdate: (nodeId: string, patch: { name?: string; target?: string; severity?: string; status?: string }) =>
    put<Enrichment>(`/findings/${nodeId}`, patch),
  // ---- 漏洞证据截图 ----
  findingEvidenceList: (nodeId: string) =>
    get<{ items: FindingEvidenceItem[] }>(`/findings/${nodeId}/evidence`).then((r) => r.items ?? []),
  findingEvidenceUpload: async (nodeId: string, file: File, caption = "", stepIndex = 0) => {
    const fd = new FormData();
    fd.append("file", file);
    if (caption) fd.append("caption", caption);
    fd.append("step_index", String(stepIndex));
    const token = getToken();
    const r = await fetch(`/api/findings/${nodeId}/evidence`, {
      method: "POST",
      body: fd,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error || `上传失败(${r.status})`);
    return body as FindingEvidenceItem;
  },
  findingEvidenceUpdate: (nodeId: string, eid: number, patch: { caption: string; step_index: number; sort_order: number }) =>
    put<{ ok: boolean }>(`/findings/${nodeId}/evidence/${eid}`, patch),
  findingEvidenceDelete: (nodeId: string, eid: number) =>
    del<{ deleted: number }>(`/findings/${nodeId}/evidence/${eid}`),
  // ---- 漏洞↔流量关联 ----
  findingTrafficList: (nodeId: string) =>
    get<{ exchanges: TrafficExchange[] }>(`/findings/${nodeId}/traffic`).then((r) => r.exchanges ?? []),
  findingTrafficLink: (nodeId: string, exchangeIds: string[]) =>
    post<{ ok: boolean; linked: number }>(`/findings/${nodeId}/traffic`, { exchange_ids: exchangeIds }),
  findingTrafficUnlink: (nodeId: string, exchangeId: string) =>
    del<{ ok: boolean }>(`/findings/${nodeId}/traffic/${encodeURIComponent(exchangeId)}`),
  chat: (message: string, task?: string) => post<{ reply: string; mode: string }>(`/chat${tq(task)}`, { message }),
  stopChat: (taskId: string) => post<{ status: string }>(`/tasks/${taskId}/chat/stop`, {}),
  gc: (ttl = 86400) => post<{ removed: number }>(`/gc?ttl=${ttl}`, {}),

  // ---- LLM ----
  getLLM: () => get<{ configured: boolean; provider: string; model: string; base_url: string; proxy?: string; key_set: boolean; rate_per_second?: number; rate_per_minute?: number; context_window_k?: number; reasoning_effort?: string }>("/llm"),
  setLLM: (provider: string, model: string, base_url: string, api_key: string, rate_per_second = 0, rate_per_minute = 0, proxy = "", context_window_k = 0) =>
    post("/llm", { provider, model, base_url, proxy, api_key, rate_per_second, rate_per_minute, context_window_k }),
  testLLM: (
    provider: string,
    model: string,
    base_url: string,
    api_key: string,
    proxy = "",
    reasoning_effort = "",
    profile_id?: number,
  ) =>
    post<{ ok: boolean; error?: string; latency_ms?: number; model?: string }>("/llm/test", {
      provider,
      model,
      base_url,
      proxy,
      api_key,
      reasoning_effort,
      profile_id,
    }),
  llmProfiles: () => get<{ profiles: LLMProfile[] }>("/llm/profiles").then((r) => arr(r.profiles)),
  saveLLMProfile: (p: {
    id?: number; // omit/0 = create; set = update that profile
    name: string;
    format: string;
    model: string;
    base_url?: string;
    proxy?: string;
    api_key?: string; // blank on update keeps the existing key
    rate_per_second?: number;
    rate_per_minute?: number;
    context_window_k?: number;
    reasoning_effort?: string; // ""|"off"|"low"|"medium"|"high"|"max"
  }) => post<{ id: number }>("/llm/profiles", p),
  deleteLLMProfile: (id: string) => del<{ deleted: number }>(`/llm/profiles/${id}`),
  activateLLMProfile: (id: string) => post<{ ok: boolean }>("/llm/profiles/active", { id: Number(id) }),
  // LLM 轮询(故障转移)
  llmPool: () => get<LLMPoolStatus>("/llm/pool"),
  setLLMPool: (enabled: boolean) => post<{ ok: boolean; enabled: boolean }>("/llm/pool", { enabled }),
  resetLLMPool: (profileId?: string) =>
    post<{ ok: boolean }>("/llm/pool/reset", { profile_id: profileId ? Number(profileId) : 0 }),
  setProfilePool: (id: string, priority: number, exclude: boolean) =>
    post<{ ok: boolean }>(`/llm/profiles/${id}/pool`, { priority, exclude }),
  // LLM 角色分工（各角色映射到某配置；profile_id="0"=跟随全局激活）
  llmRoles: () => get<{ roles: { role: string; profile_id: string }[] }>("/llm/roles").then((r) => arr(r.roles)),
  setLLMRole: (role: string, profileId: string) =>
    post<{ ok: boolean }>("/llm/roles", { role, profile_id: Number(profileId) || 0 }),

  // ---- agents ----
  agents: () => get<{ agents: Agent[] }>("/agents").then((r) => arr(r.agents)),
  getAgent: (key: string) => get<AgentDetail>(`/agents/${key}`),
  createAgent: (key: string, name: string, description = "") =>
    post<Agent>("/agents", { key, name, description }),
  updateAgent: (key: string, name: string, description = "") =>
    patch<{ ok: boolean }>(`/agents/${key}`, { name, description }),
  deleteAgent: (key: string) => del<{ deleted: string }>(`/agents/${key}`),

  // ---- conversations (chat page) ----
  conversations: () => get<{ conversations: Conversation[] }>("/conversations").then((r) => arr(r.conversations)),
  createConversation: (agent_key: string, title = "", llm_profile_id?: number | null) =>
    post<Conversation>("/conversations", { agent_key, title, llm_profile_id: llm_profile_id ?? null }),
  renameConversation: (id: number, title: string) => patch<{ ok: boolean }>(`/conversations/${id}`, { title }),
  updateConversationProfile: (id: number, llm_profile_id: number | null) =>
    patch<{ ok: boolean }>(`/conversations/${id}/profile`, { llm_profile_id }),
  deleteConversation: (id: number) => del<{ deleted: number }>(`/conversations/${id}`),
  conversationMessages: (id: number, since = 0) =>
    get<{ items: Activity[]; cursor: number; running: boolean }>(`/conversations/${id}/messages?since=${since}`).then(
      (r) => ({ items: arr(r.items), cursor: r.cursor ?? 0, running: !!r.running }),
    ),
  conversationMsgDetail: (id: number, seq: number) =>
    get<{ detail: string }>(`/conversations/${id}/messages/${seq}`).then((r) => r.detail ?? ""),
  sendConversationMessage: (id: number, message: string) =>
    post<{ status: string }>(`/conversations/${id}/messages`, { message }),
  stopConversation: (id: number) => post<{ status: string }>(`/conversations/${id}/stop`, {}),
  saveAgentPrompt: (key: string, template: string, note = "") => put<{ version: number }>(`/agents/${key}/prompt`, { template, note }),
  resetAgentPrompt: (key: string) => post<{ version: number }>(`/agents/${key}/prompt/reset`, {}),
  // 收尾提示词(超时/步数耗尽的 settlement 提示);prompt 空串=清除覆盖、用内置默认;
  // max_turns 省略则不动、传 0=用内置默认轮数
  saveAgentWrapup: (key: string, prompt: string, maxTurns?: number) =>
    put<{ ok: boolean }>(`/agents/${key}/wrapup`, { prompt, max_turns: maxTurns }),
  resetAgentWrapup: (key: string) =>
    post<{ ok: boolean; wrapup_default: string; wrapup_max_turns_default: number }>(`/agents/${key}/wrapup/reset`, {}),
  // 任务级超时收尾词(仅 worker/planner);prompt 空=清除、用内置默认
  saveAgentTaskTimeoutWrapup: (key: string, prompt: string, maxTurns?: number) =>
    put<{ ok: boolean }>(`/agents/${key}/wrapup/task-timeout`, { prompt, max_turns: maxTurns }),
  resetAgentTaskTimeoutWrapup: (key: string) =>
    post<{ ok: boolean; task_timeout_wrapup_default: string; task_timeout_wrapup_max_turns_default: number }>(`/agents/${key}/wrapup/task-timeout/reset`, {}),
  // P3 triggers (仅自定义 agent)
  agentTriggers: (key: string) =>
    get<{ triggers: AgentTrigger[] }>(`/agents/${key}/triggers`).then((r) => arr(r.triggers)),
  createTrigger: (key: string, t: Omit<AgentTrigger, "id" | "agent_key" | "last_fire">) =>
    post<AgentTrigger>(`/agents/${key}/triggers`, t),
  updateTrigger: (id: number, t: Omit<AgentTrigger, "id" | "agent_key" | "last_fire">) =>
    patch<{ ok: boolean }>(`/triggers/${id}`, t),
  deleteTrigger: (id: number) => del<{ deleted: number }>(`/triggers/${id}`),
  saveAgentConfig: (key: string, patch: { max_turns: number; run_seconds?: number; web_search?: boolean; interactive_shell?: boolean; llm_profile_id?: number }) =>
    put<{ ok: boolean }>(`/agents/${key}/config`, patch),
  agentPromptVersions: (key: string) => get<{ versions: PromptVersion[] }>(`/agents/${key}/prompts`).then((r) => arr(r.versions)),
  agentVariables: (key: string) => get<{ variables: PromptVar[] }>(`/agents/${key}/variables`).then((r) => arr(r.variables)),
  previewAgentPrompt: (key: string, template: string, sample?: Record<string, string>) =>
    post<{ rendered: string; error?: string }>(`/agents/${key}/prompt/preview`, { template, sample }),
  getAgentVisibility: (key: string) => get<{ mcp: number[]; skill: string[] }>(`/agents/${key}/visibility`),
  setAgentVisibility: (key: string, mcp: number[], skill: string[]) => put<{ ok: boolean }>(`/agents/${key}/visibility`, { mcp, skill }),

  // ---- tools (内置工具目录) ----
  tools: () => get<{ tools: Tool[] }>("/tools").then((r) => arr(r.tools)),
  saveTool: (key: string, patch: Pick<Tool, "description" | "schema" | "agents" | "enabled">) =>
    put<{ ok: boolean }>(`/tools/${key}`, patch),
  resetTool: (key: string) => post<{ ok: boolean }>(`/tools/${key}/reset`, {}),
  // custom tools (自定义工具)
  createCustomTool: (t: Pick<Tool, "key" | "description" | "schema" | "agents" | "enabled" | "kind" | "exec" | "deferred">) =>
    post<{ key: string }>("/tools/custom", t),
  updateCustomTool: (key: string, t: Pick<Tool, "description" | "schema" | "agents" | "enabled" | "kind" | "exec" | "deferred">) =>
    put<{ ok: boolean }>(`/tools/custom/${key}`, t),
  deleteCustomTool: (key: string) => del<{ deleted: string }>(`/tools/custom/${key}`),
  testCustomTool: (body: { kind: string; exec: Record<string, unknown>; params: Record<string, unknown> }) =>
    post<{ output: string; is_error: boolean }>("/tools/custom/test", body),
  detectPython: () => post<{ python_interpreter: string }>("/settings/python/detect", {}),

  // ---- mcp ----
  mcpServers: () => get<{ servers: MCPServer[] }>("/mcp").then((r) => arr(r.servers)),
  saveMcpServer: (m: Partial<MCPServer>) => post<{ id: number }>("/mcp", m),
  deleteMcpServer: (id: number) => del<{ deleted: number }>(`/mcp/${id}`),
  mcpTools: (id: number) => get<{ tools: MCPTool[] }>(`/mcp/${id}/tools`).then((r) => arr(r.tools)),
  refreshMcpServer: (id: number) => post<{ tools: MCPTool[] }>(`/mcp/${id}/refresh`, {}).then((r) => arr(r.tools)),
  mcpStats: () => get<MCPStatsResp>("/mcp/stats"),
  mcpHealthCheck: (id: number) => post<{ status: string; error?: string }>(`/mcp/${id}/health`, {}),

  // ---- 资产同步 (ScopeSentry 数据源) ----
  ssStatus: () =>
    get<{ exists: boolean; configured: boolean; enabled: boolean; reachable: boolean; url?: string; tools: string[] }>(
      "/sync/scopesentry/status",
    ),
  ssDatasource: (body: { url?: string; api_key?: string }) =>
    post<{ id: number; enabled: boolean }>("/sync/scopesentry/datasource", body),
  ssProjects: (page = 1, size = 50, search = "") =>
    get<{ projects: SSProject[]; tag: Record<string, number> }>(
      `/sync/scopesentry/projects?page=${page}&size=${size}${search ? `&search=${encodeURIComponent(search)}` : ""}`,
    ).then((r) => ({ projects: arr(r.projects), tag: r.tag ?? {} })),
  ssTasks: (page = 1, size = 50, search = "") =>
    get<{ tasks: SSTask[] }>(
      `/sync/scopesentry/tasks?page=${page}&size=${size}${search ? `&search=${encodeURIComponent(search)}` : ""}`,
    ).then((r) => arr(r.tasks)),
  ssSync: (body: {
    dimension: "project" | "task";
    targets: string[];
    asset_types: string[];
    create_company?: boolean;
    page_size?: number;
  }) =>
    post<{
      synced: Record<string, number>;
      companies: string[] | null;
      warnings: string[] | null;
      errors: string[] | null;
    }>("/sync/scopesentry/sync", body),

  // ---- skills (文件系统) ----
  skills: () => get<{ skills: SkillItem[] }>("/skills").then((r) => arr(r.skills)),
  // 调用统计（复用可观测性）
  skillStats: () => get<SkillStatsResp>("/skills/stats"),
  createSkill: (s: { name: string; description: string; license?: string; compatibility?: string; mcps?: string[]; instructions?: string }) =>
    post<{ name: string }>("/skills", s),
  // uploadSkill installs a skill from a .zip (multipart). Surfaces the backend
  // error text (e.g. 已存在 / 缺少 SKILL.md) so the UI can show a precise message.
  uploadSkill: async (file: File, overwrite = false): Promise<{ name: string; files: number }> => {
    if (MOCK) return { name: file.name.replace(/\.zip$/i, ""), files: 1 };
    const fd = new FormData();
    fd.append("file", file);
    const token = getToken();
    const r = await fetch(`/api/skills/upload${overwrite ? "?overwrite=true" : ""}`, {
      method: "POST",
      body: fd,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error || i18n.t("common.uploadFailed", { status: r.status }));
    return body;
  },
  deleteSkill: (name: string) => del<{ deleted: string }>(`/skills/${name}`),
  updateSkillMeta: (name: string, meta: { mcps?: string[]; description?: string; license?: string; compatibility?: string }) =>
    put<{ ok: boolean }>(`/skills/${name}/meta`, meta),
  createSkillDir: (skill: string, path: string) =>
    post<{ dir: string }>(`/skills/${skill}/dirs`, { path }),
  skillFiles: (name: string) => get<{ files: string[] }>(`/skills/${name}/files`).then((r) => r.files),
  readSkillFile: (name: string, file: string) =>
    get<{ content: string; file: string }>(`/skills/${name}/files/${file}`).then((r) => r.content),
  writeSkillFile: (name: string, file: string, content: string) =>
    put<{ ok: boolean }>(`/skills/${name}/files/${file}`, { content }),
  deleteSkillPath: (skill: string, path: string) =>
    del<{ deleted: string }>(`/skills/${skill}/files/${path}`),

  // ---- visibility (MCP resource side) ---- (agent ids are strings per spec)
  resourceVisibility: (kind: string, id: number) => get<{ agents: string[] }>(`/visibility/${kind}/${id}`).then((r) => arr(r.agents)),
  toggleVisibility: (agentId: string, kind: string, resourceId: number, visible: boolean) =>
    post<{ ok: boolean }>("/visibility/toggle", { agent_id: agentId, kind, resource_id: resourceId, visible }),

  // ---- visibility (Skill，按名称) ----
  skillVisibility: (name: string) => get<{ agents: string[] }>(`/visibility/skill/${name}`).then((r) => arr(r.agents)),
  toggleSkillVisibility: (agentId: string, skillName: string, visible: boolean) =>
    post<{ ok: boolean }>("/visibility/skill/toggle", { agent_id: agentId, skill_name: skillName, visible }),

  // ---- intercept rules ----
  interceptRules: () => get<{ rules: InterceptRule[] }>("/intercept/rules").then((r) => arr(r.rules)),
  createInterceptRule: (rule: Omit<InterceptRule, "id" | "created_at" | "updated_at">) =>
    post<InterceptRule>("/intercept/rules", rule),
  updateInterceptRule: (id: number, rule: Omit<InterceptRule, "id" | "created_at" | "updated_at">) =>
    put<InterceptRule>(`/intercept/rules/${id}`, rule),
  deleteInterceptRule: (id: number) => del<{ deleted: number }>(`/intercept/rules/${id}`),
  toggleInterceptRule: (id: number, enabled: boolean) =>
    post<{ ok: boolean; enabled: boolean }>(`/intercept/rules/${id}/toggle`, { enabled }),

  // ---- intercept pending (ask) ----
  interceptPending: () => get<{ pending: InterceptPending[] }>("/intercept/pending").then((r) => arr(r.pending)),
  interceptGetOne: (id: number) => get<InterceptPending>(`/intercept/pending/${id}`),
  interceptDecide: (id: number, decision: "allowed" | "denied") =>
    post<{ ok: boolean }>(`/intercept/pending/${id}/decide`, { decision }),
  interceptHistory: () => get<{ items: InterceptApprovalRow[] }>("/intercept/history").then((r) => arr(r.items)),
  interceptTask: (taskId: string) => get<{ items: InterceptApprovalRow[] }>(`/intercept/task/${taskId}`).then((r) => arr(r.items)),

  // ---- intercept tool-config (全局工具拦截范围) ----
  interceptGetToolConfig: async (): Promise<{ enabled_tools: string[] }> => {
    if (MOCK) return { enabled_tools: ["bash"] };
    const token = getToken();
    const r = await fetch("/api/intercept/tool-config", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  interceptSetToolConfig: async (enabledTools: string[]): Promise<void> => {
    if (MOCK) return;
    const token = getToken();
    const r = await fetch("/api/intercept/tool-config", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ enabled_tools: enabledTools }),
    });
    if (!r.ok) throw new Error(await r.text());
  },

  // ---- 平台权限 RBAC ----
  rbacMe: () => get<RBACMe>("/rbac/me"),
  rbacMetadata: () =>
    get<{ permissions: Record<string, string>; roles: RBACRole[]; scopes: string[] }>("/rbac/metadata"),
  rbacUsers: () => get<{ users: RBACUser[] }>("/rbac/users").then((r) => arr(r.users)),
  rbacCreateUser: (b: { username: string; display_name: string; password: string; enabled?: boolean; role_ids: string[] }) =>
    post<{ user: RBACUser }>("/rbac/users", b),
  rbacUpdateUser: (id: string, b: { display_name?: string; enabled?: boolean; role_ids?: string[]; password?: string }) =>
    put<{ ok: boolean }>(`/rbac/users/${id}`, b),
  rbacDeleteUser: (id: string) => del<{ ok: boolean }>(`/rbac/users/${id}`),
  rbacRoles: () => get<{ roles: RBACRole[] }>("/rbac/roles").then((r) => arr(r.roles)),
  rbacCreateRole: (b: { name: string; description: string; scope: string; permissions: string[] }) =>
    post<{ role: RBACRole }>("/rbac/roles", b),
  rbacUpdateRole: (id: string, b: { name: string; description: string; scope: string; permissions: string[] }) =>
    put<{ role: RBACRole }>(`/rbac/roles/${id}`, b),
  rbacDeleteRole: (id: string) => del<{ ok: boolean }>(`/rbac/roles/${id}`),
  auditLogs: (opts: { category?: string; action?: string; result?: string; actor?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.category) p.set("category", opts.category);
    if (opts.action) p.set("action", opts.action);
    if (opts.result) p.set("result", opts.result);
    if (opts.actor) p.set("actor", opts.actor);
    p.set("limit", String(opts.limit ?? 50));
    p.set("offset", String(opts.offset ?? 0));
    return get<{ logs: AuditLog[]; total: number }>(`/audit/logs?${p.toString()}`);
  },
};
