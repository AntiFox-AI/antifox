"use client";

import * as React from "react";
import Link from "next/link";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  BotIcon,
  BugIcon,
  ClockIcon,
  DownloadIcon,
  FileTextIcon,
  FilterIcon,
  KeyRoundIcon,
  LayersIcon,
  NetworkIcon,
  PlugIcon,
  PlusIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TargetIcon,
  ZapIcon,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
} from "recharts";
import { useTranslation } from "react-i18next";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/status-badge";
import { api } from "@/lib/api";
import { taskLabel } from "@/lib/task-label";
import type {
  Activity,
  Agent,
  Finding,
  InterceptPending,
  KnowledgeConfig,
  LLMProfile,
  MCPServer,
  MCPStatsResp,
  RBACRole,
  ReportRecord,
  Settings,
  SkillItem,
  SkillStatsResp,
  Stats,
  Task,
  TokenTotal,
  Tool,
  TrafficExchange,
  ConvTokenSummary,
} from "@/lib/types";

// ── chart constants ───────────────────────────────────────────────────────────

const dailyTrendConfig = {
  input:     { color: "hsl(217 91% 60%)" },
  output:    { color: "hsl(263 70% 60%)" },
  cacheRead: { color: "hsl(160 60% 45%)" },
} satisfies ChartConfig;

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

const ASSET_COLORS: Record<string, string> = {
  root_domain: "bg-blue-500",
  ip: "bg-indigo-400",
  subdomain: "bg-violet-500",
  app: "bg-orange-400",
  service: "bg-cyan-500",
  endpoint: "bg-emerald-500",
};

function statusColor(code: number): string {
  if (code < 300) return "text-emerald-500";
  if (code < 400) return "text-blue-400";
  if (code < 500) return "text-amber-400";
  return "text-red-400";
}

function statusBg(code: number): string {
  if (code < 300) return "bg-emerald-500";
  if (code < 400) return "bg-blue-400";
  if (code < 500) return "bg-amber-400";
  return "bg-red-400";
}

// ── sub-components ────────────────────────────────────────────────────────────

function LiveDot({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-blue-400",
        className,
      )}
    />
  );
}

function SectionTitle({
  icon: Icon,
  children,
  sub,
}: {
  icon: React.ElementType;
  children: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Icon className="size-3.5 text-muted-foreground" />
        {children}
      </div>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { t: tr } = useTranslation();

  const fmtRel = (ts?: string | number): string => {
    if (!ts) return "—";
    const ms =
      Date.now() -
      (typeof ts === "number" ? ts * 1000 : Date.parse(ts as string));
    const s = Math.floor(ms / 1000);
    if (s < 60) return tr("dashboard.time.secondsAgo", { count: s });
    const m = Math.floor(s / 60);
    if (m < 60) return tr("dashboard.time.minutesAgo", { count: m });
    const h = Math.floor(m / 60);
    if (h < 24) return tr("dashboard.time.hoursAgo", { count: h });
    return tr("dashboard.time.daysAgo", { count: Math.floor(h / 24) });
  };

  const assetTypeLabel = (type: string): string =>
    tr(`dashboard.assetType.${type}`, { defaultValue: type });

  const tokenTypeLabel = (k: string): string =>
    k === "input" || k === "output" || k === "cacheRead"
      ? tr(`dashboard.tokenType.${k}`)
      : k;

  // data state
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [findings, setFindings] = React.useState<Finding[]>([]);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [pending, setPending] = React.useState<InterceptPending[]>([]);
  const [activity, setActivity] = React.useState<Activity[]>([]);
  const [activeTaskId, setActiveTaskId] = React.useState(""); // manager's active task (for the "all" view)
  const [tokens, setTokens] = React.useState<TokenTotal | null>(null);
  const [convTokens, setConvTokens] = React.useState<ConvTokenSummary[]>([]);
  const [assetCounts, setAssetCounts] = React.useState<Record<string, number>>({});
  const [traffic, setTraffic] = React.useState<TrafficExchange[]>([]);
  // task-scoped copies (loaded only when a task is selected; null = not loaded)
  const [scopedAssetCounts, setScopedAssetCounts] = React.useState<Record<string, number> | null>(null);
  const [scopedTraffic, setScopedTraffic] = React.useState<TrafficExchange[] | null>(null);
  // true traffic totals (the exchanges arrays are capped at one page of 50, so use
  // these — not .length — for the count displays).
  const [trafficCount, setTrafficCount] = React.useState(0);
  const [scopedTrafficCount, setScopedTrafficCount] = React.useState<number | null>(null);
  // true status-code distribution (server-aggregated over ALL exchanges, not the 50-row page)
  const [trafficBuckets, setTrafficBuckets] = React.useState<Record<string, number>>({});
  const [scopedTrafficBuckets, setScopedTrafficBuckets] = React.useState<Record<string, number> | null>(null);
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [mcpServers, setMcpServers] = React.useState<MCPServer[]>([]);
  const [skills, setSkills] = React.useState<SkillItem[]>([]);
  const [tools, setTools] = React.useState<Tool[]>([]);
  const [llmProfiles, setLLMProfiles] = React.useState<LLMProfile[]>([]);
  // platform-capability overview (global)
  const [knowledgeConfig, setKnowledgeConfig] = React.useState<KnowledgeConfig | null>(null);
  const [skillStats, setSkillStats] = React.useState<SkillStatsResp | null>(null);
  const [mcpStats, setMcpStats] = React.useState<MCPStatsResp | null>(null);
  const [reports, setReports] = React.useState<ReportRecord[]>([]);
  const [roles, setRoles] = React.useState<RBACRole[]>([]);

  // task filter (client-side scoping of task-level widgets; "all" = 全部任务)
  const [selectedTask, setSelectedTask] = React.useState("all");

  // fast poll: tasks, findings, stats, pending, activity (every 5s)
  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        // Each call guarded individually: a single 403 (a lower-privilege role
        // lacking e.g. config:read for settings) must not blank the whole
        // dashboard. Non-permitted bits just fall back to empty/defaults.
        const [tr, fr, sr, sets, pr, tok, ctok] = await Promise.all([
          api.tasks().catch(() => ({ tasks: [], active: "" })),
          api.findings().catch(() => []),
          api.stats().catch(() => null),
          api.settings().catch(() => null),
          api.interceptPending().catch(() => []),
          api.tokenStats().catch(() => ({ total: null })),
          api.conversationTokens().catch(() => null),
        ]);
        if (!alive) return;
        setTasks(tr.tasks);
        setActiveTaskId(tr.active ?? ""); // 活动流/链接的"当前任务"来源(未选任务时)
        setFindings(fr);
        if (sr) setStats(sr);
        if (sets) setSettings(sets);
        setPending(pr);
        setTokens(tok.total ?? null);
        if (ctok) setConvTokens(ctok);
      } catch {
        /* transient errors — next poll retries */
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // slow poll: traffic, assets, system-static (every 15s)
  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [
          traf, counts, agentList, mcpList, skillList, toolList, profileList,
          kcfg, sstats, mstats, reportList, roleList,
        ] = await Promise.all([
            // each guarded so one 403 (a role lacking e.g. llm:read) never blanks the rest
            api.traffic(0, 50).catch(() => ({ exchanges: [], count: 0, total: 0, status_buckets: {} })),
            api.assetCounts().catch(() => ({})),
            api.agents().catch(() => []),
            api.mcpServers().catch(() => []),
            api.skills().catch(() => []),
            api.tools().catch(() => []),
            api.llmProfiles().catch(() => []),
            api.knowledgeConfig().catch(() => null),
            api.skillStats().catch(() => null),
            api.mcpStats().catch(() => null),
            api.reports().catch(() => [] as ReportRecord[]),
            api.rbacRoles().catch(() => [] as RBACRole[]),
          ]);
        if (!alive) return;
        setTraffic(traf.exchanges ?? []);
        setTrafficCount(traf.count ?? traf.total ?? 0);
        setTrafficBuckets(traf.status_buckets ?? {});
        setAssetCounts(counts ?? {});
        setAgents(agentList);
        setMcpServers(mcpList);
        setSkills(skillList);
        setTools(toolList);
        setLLMProfiles(profileList);
        setKnowledgeConfig(kcfg);
        setSkillStats(sstats);
        setMcpStats(mstats);
        setReports(reportList);
        setRoles(roleList);
      } catch {
        /* transient errors */
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // task-scoped poll: assets + traffic for the selected task (skipped when "all").
  // Clears scoped copies on return to "all" so the global path behaves exactly as before.
  React.useEffect(() => {
    if (selectedTask === "all") {
      setScopedAssetCounts(null);
      setScopedTraffic(null);
      setScopedTrafficCount(null);
      setScopedTrafficBuckets(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const [counts, traf] = await Promise.all([
          api.assetCounts(Number(selectedTask)),
          api.traffic(0, 50, "", "", "", Number(selectedTask)),
        ]);
        if (!alive) return;
        setScopedAssetCounts(counts ?? {});
        setScopedTraffic(traf.exchanges ?? []);
        setScopedTrafficCount(traf.count ?? traf.total ?? 0);
        setScopedTrafficBuckets(traf.status_buckets ?? {});
      } catch {
        /* transient errors — next poll retries */
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [selectedTask]);

  // ── derived ───────────────────────────────────────────────────────────────

  const tasksByStatus = React.useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of tasks) m[t.status] = (m[t.status] ?? 0) + 1;
    return m;
  }, [tasks]);

  // ── task filter scoping (client-side; capability/system stay global) ──
  const isTaskScoped = selectedTask !== "all";

  // effective assets/traffic: task-scoped copies when a task is picked, else global
  const effectiveAssetCounts = isTaskScoped ? (scopedAssetCounts ?? {}) : assetCounts;
  const effectiveTraffic = isTaskScoped ? (scopedTraffic ?? []) : traffic;
  const effectiveTrafficCount = isTaskScoped ? (scopedTrafficCount ?? 0) : trafficCount;
  const effectiveTrafficBuckets = isTaskScoped ? (scopedTrafficBuckets ?? {}) : trafficBuckets;
  // The activity feed is per-task (the endpoint requires a task); show the selected
  // task's activity, else the active task's. This id also drives the "查看任务" link.
  const activityTaskId = isTaskScoped ? selectedTask : activeTaskId;

  // activity feed follows the displayed task; re-fetch + poll when it changes.
  React.useEffect(() => {
    if (!activityTaskId) {
      setActivity([]);
      return;
    }
    let alive = true;
    const load = () =>
      api.activity(activityTaskId, { limit: 30 }).then((r) => { if (alive) setActivity(r.items); }).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [activityTaskId]);

  const scopedFindings = React.useMemo(
    () =>
      selectedTask === "all"
        ? findings
        : findings.filter((f) => f.task_id === selectedTask),
    [findings, selectedTask],
  );

  const selectedTaskObj = React.useMemo(
    () => (isTaskScoped ? tasks.find((x) => x.id === selectedTask) ?? null : null),
    [isTaskScoped, selectedTask, tasks],
  );

  const selectedTaskName = React.useMemo(
    () =>
      selectedTaskObj
        ? taskLabel(selectedTaskObj)
        : isTaskScoped
          ? `#${selectedTask}`
          : "",
    [selectedTaskObj, isTaskScoped, selectedTask],
  );

  const findingsBySev = React.useMemo(() => {
    const m = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of scopedFindings) {
      if (f.severity in m) m[f.severity as keyof typeof m]++;
    }
    return m;
  }, [scopedFindings]);

  const sortedTasks = React.useMemo(
    () =>
      [...(selectedTask === "all" ? tasks : tasks.filter((t) => t.id === selectedTask))]
        .sort(
          (a, b) =>
            (b.last_activity_unix ?? b.created_unix ?? 0) -
            (a.last_activity_unix ?? a.created_unix ?? 0),
        )
        .slice(0, 5),
    [tasks, selectedTask],
  );

  const recentFindings = React.useMemo(
    () => {
      const sevRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
      return [...scopedFindings]
        .sort((a, b) => {
          const d = (sevRank[b.severity] ?? 0) - (sevRank[a.severity] ?? 0);
          return d !== 0 ? d : Date.parse(b.ts) - Date.parse(a.ts); // 等级降序,同级按时间新→旧
        })
        .slice(0, 8);
    },
    [scopedFindings],
  );

  const recentActivity = React.useMemo(
    () =>
      [...activity]
        .filter((a) => a.kind !== "usage")
        .sort((a, b) => b.seq - a.seq)
        .slice(0, 6),
    [activity],
  );

  const totalAssets = React.useMemo(
    () => Object.values(effectiveAssetCounts).reduce((a, b) => a + b, 0),
    [effectiveAssetCounts],
  );

  // ── capability overview (global, platform-level) ──
  const knowledgeDocs =
    (knowledgeConfig?.docs_global ?? 0) + (knowledgeConfig?.docs_task ?? 0);
  const skillInstalled = skillStats?.installed_count ?? skills.length;
  const skillInvoked = skillStats?.invoked_count ?? 0;
  const mcpEnabled = mcpStats?.enabled_count ?? mcpServers.filter((m) => m.enabled).length;
  const mcpTotal = mcpStats?.total_count ?? mcpServers.length;
  const mcpCalls = mcpStats?.total_calls ?? 0;

  // recent reports — task-level, so scope to the selected task when one is picked
  // (reports carry task_id?: number; compare as string against selectedTask).
  const recentReports = React.useMemo(() => {
    const scoped = isTaskScoped
      ? reports.filter((r) => String(r.task_id) === selectedTask)
      : reports;
    return [...scoped]
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, 5);
  }, [reports, isTaskScoped, selectedTask]);

  // hot skills + MCP servers by call count (top 5, combined)
  const hotItems = React.useMemo(() => {
    const items: { name: string; calls: number; kind: "skill" | "mcp" }[] = [];
    for (const s of skillStats?.skills ?? []) {
      if (s.calls > 0) items.push({ name: s.skill_name, calls: s.calls, kind: "skill" });
    }
    for (const m of mcpStats?.servers ?? []) {
      if (m.calls > 0) items.push({ name: m.server_name, calls: m.calls, kind: "mcp" });
    }
    return items.sort((a, b) => b.calls - a.calls).slice(0, 5);
  }, [skillStats, mcpStats]);
  const hotMax = hotItems[0]?.calls ?? 1;

  // capability rows for the 平台能力总览 card
  const capRows: {
    icon: React.ElementType;
    label: string;
    detail: string;
    badge?: string;
    href: string;
  }[] = [
    {
      icon: BookOpenIcon,
      label: tr("dashboard.cap.knowledge"),
      detail: tr("dashboard.cap.docs", { count: knowledgeDocs }),
      badge: knowledgeConfig?.semantic_ready
        ? tr("dashboard.cap.semanticReady")
        : tr("dashboard.cap.keyword"),
      href: "/system/knowledge",
    },
    {
      icon: FileTextIcon,
      label: tr("dashboard.cap.reports"),
      detail: tr("dashboard.cap.generated", { count: reports.length }),
      href: "/system/reports",
    },
    {
      icon: SparklesIcon,
      label: tr("dashboard.cap.skills"),
      detail: `${tr("dashboard.cap.installed", { count: skillInstalled })} · ${tr("dashboard.cap.invoked", { count: skillInvoked })}`,
      href: "/system/skills",
    },
    {
      icon: PlugIcon,
      label: tr("dashboard.cap.mcp"),
      detail: `${tr("dashboard.cap.enabled", { enabled: mcpEnabled, total: mcpTotal })} · ${tr("dashboard.cap.calls", { count: mcpCalls })}`,
      href: "/system/mcp",
    },
    {
      icon: BotIcon,
      label: tr("dashboard.cap.agents"),
      detail: tr("dashboard.cap.agentsCount", { count: agents.length }),
      href: "/system/agents",
    },
    {
      icon: KeyRoundIcon,
      label: tr("dashboard.cap.roles"),
      detail: tr("dashboard.cap.rolesCount", { count: roles.length }),
      href: "/system/rbac",
    },
  ];

  // asset type breakdown
  const assetByType = React.useMemo(() => {
    return Object.entries(effectiveAssetCounts)
      .filter(([, n]) => n > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8);
  }, [effectiveAssetCounts]);

  const assetMax = assetByType[0]?.[1] ?? 1;

  // traffic status code breakdown — from the server-aggregated buckets (true totals
  // over ALL exchanges), not the 50-row page sample. Bucket "2" ⇒ code group 200.
  const trafficByCodes = React.useMemo(() => {
    return Object.entries(effectiveTrafficBuckets)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([b, n]) => ({ code: Number(b) * 100, n }));
  }, [effectiveTrafficBuckets]);

  const trafficMax = Math.max(...trafficByCodes.map((x) => x.n), 1);
  const recentTraffic = [...effectiveTraffic]
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, 5);

  // system
  const activeProfile = llmProfiles.find((p) => p.is_default);
  const enabledTools = tools.filter((t) => t.enabled);
  const pendingCount = pending.length;

  // ── token stats per LLM profile ──────────────────────────────────────────
  // tasks whose llm_profile_id is null/undefined used the active default profile
  const defaultProfileId = activeProfile ? Number(activeProfile.id) : null;

  const tokenByProfile = React.useMemo<
    Map<number | null, { input: number; output: number; cacheRead: number; cacheWrite: number; taskCount: number }>
  >(() => {
    const m = new Map<number | null, { input: number; output: number; cacheRead: number; cacheWrite: number; taskCount: number }>();
    for (const t of tasks) {
      // null means "used whatever was active" → bucket under defaultProfileId
      const key = t.llm_profile_id != null ? t.llm_profile_id : defaultProfileId;
      const prev = m.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, taskCount: 0 };
      m.set(key, {
        input: prev.input + (t.tokens?.input_tokens ?? 0),
        output: prev.output + (t.tokens?.output_tokens ?? 0),
        cacheRead: prev.cacheRead + (t.tokens?.cache_read_tokens ?? 0),
        cacheWrite: prev.cacheWrite + (t.tokens?.cache_write_tokens ?? 0),
        taskCount: prev.taskCount + 1,
      });
    }
    // merge conversation (chat) usage into the same per-profile buckets — token sums
    // only; taskCount stays a task count.
    for (const c of convTokens) {
      const key = c.llm_profile_id != null ? c.llm_profile_id : defaultProfileId;
      const prev = m.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, taskCount: 0 };
      m.set(key, {
        input: prev.input + c.input_tokens,
        output: prev.output + c.output_tokens,
        cacheRead: prev.cacheRead + c.cache_read_tokens,
        cacheWrite: prev.cacheWrite + c.cache_write_tokens,
        taskCount: prev.taskCount,
      });
    }
    return m;
  }, [tasks, convTokens, defaultProfileId]);

  // selected profile tab: "all" = 全部; number = specific profile id
  const [tokenTab, setTokenTab] = React.useState<number | null | "all">("all");
  // day range for the daily bar chart
  const [tokenDays, setTokenDays] = React.useState<7 | 30 | 90 | 180 | 365>(30);

  const displayedTokens = React.useMemo(() => {
    // task-scoped: show ONLY the selected task's own consumption. No other task's
    // numbers, no global chat convTokens, and profile tabs are ignored.
    if (isTaskScoped) {
      const tk = selectedTaskObj?.tokens;
      return {
        input: tk?.input_tokens ?? 0,
        output: tk?.output_tokens ?? 0,
        cacheRead: tk?.cache_read_tokens ?? 0,
        cacheWrite: tk?.cache_write_tokens ?? 0,
        taskCount: selectedTaskObj ? 1 : 0,
      };
    }
    if (tokenTab === "all") {
      // sum across all profiles
      let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, taskCount = 0;
      for (const v of tokenByProfile.values()) {
        input += v.input; output += v.output;
        cacheRead += v.cacheRead; cacheWrite += v.cacheWrite;
        taskCount += v.taskCount;
      }
      return { input, output, cacheRead, cacheWrite, taskCount };
    }
    const v = tokenByProfile.get(tokenTab as number | null);
    return v ? { input: v.input, output: v.output, cacheRead: v.cacheRead, cacheWrite: v.cacheWrite, taskCount: v.taskCount }
             : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, taskCount: 0 };
  }, [tokenTab, tokenByProfile, isTaskScoped, selectedTaskObj]);

  // daily token data: tasks grouped by date, filtered by day range and selected profile
  const dailyTokenData = React.useMemo(() => {
    const now = new Date();
    now.setDate(now.getDate() - tokenDays);
    const cutoff = now.toISOString().slice(0, 10);

    const m = new Map<string, { input: number; output: number; cacheRead: number }>();
    for (const t of tasks) {
      // filter by profile tab when not "all"
      if (tokenTab !== "all") {
        const taskKey = t.llm_profile_id ?? defaultProfileId;
        if (taskKey !== tokenTab) continue;
      }
      const date = t.created_at.slice(0, 10);
      if (date < cutoff) continue;
      const prev = m.get(date) ?? { input: 0, output: 0, cacheRead: 0 };
      m.set(date, {
        input:     prev.input     + (t.tokens?.input_tokens      ?? 0),
        output:    prev.output    + (t.tokens?.output_tokens     ?? 0),
        cacheRead: prev.cacheRead + (t.tokens?.cache_read_tokens ?? 0),
      });
    }
    // merge conversation usage by conversation created_at date, same profile filter.
    for (const c of convTokens) {
      if (tokenTab !== "all") {
        const convKey = c.llm_profile_id ?? defaultProfileId;
        if (convKey !== tokenTab) continue;
      }
      const date = c.created_at.slice(0, 10);
      if (date < cutoff) continue;
      const prev = m.get(date) ?? { input: 0, output: 0, cacheRead: 0 };
      m.set(date, {
        input:     prev.input     + c.input_tokens,
        output:    prev.output    + c.output_tokens,
        cacheRead: prev.cacheRead + c.cache_read_tokens,
      });
    }
    return [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date: date.slice(5), ...v }));
  }, [tasks, convTokens, tokenDays, tokenTab, defaultProfileId]);

  // activity kind label
  function kindLabel(a: Activity): string {
    if (a.kind === "tool_use") return a.tool ?? "tool_use";
    if (a.kind === "tool_result") return "tool_result";
    return a.kind;
  }

  function workerColor(w: string): string {
    if (w === "planner") return "text-violet-400";
    if (w === "mainagent") return "text-cyan-400";
    return "text-blue-400";
  }

  function workerBg(w: string): string {
    if (w === "planner") return "bg-violet-500/10 text-violet-400 border-violet-500/20";
    if (w === "mainagent") return "bg-cyan-500/10 text-cyan-400 border-cyan-500/20";
    return "bg-blue-500/10 text-blue-400 border-blue-500/20";
  }

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-1 flex-col gap-4 pb-6">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{tr("dashboard.title")}</h1>
          <p className="text-xs text-muted-foreground">{tr("dashboard.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* task filter — scopes findings + task table + assets + traffic; capability/system stay global */}
          <div className="flex items-center gap-1.5">
            <FilterIcon className="size-3.5 text-muted-foreground" />
            <Select value={selectedTask} onValueChange={setSelectedTask}>
              <SelectTrigger size="sm" className="w-[180px] text-xs">
                <SelectValue placeholder={tr("dashboard.filterTask")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tr("dashboard.allTasks")}</SelectItem>
                {tasks.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {taskLabel(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Link href="/function/tasks">
            <button className="flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90">
              <PlusIcon className="size-3.5" />
              {tr("dashboard.newTask")}
            </button>
          </Link>
        </div>
      </div>

      {selectedTask !== "all" && (
        <div className="-mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <FilterIcon className="size-3 text-blue-400" />
          <span>{tr("dashboard.filterScoped", { name: selectedTaskName })}</span>
          <button
            onClick={() => setSelectedTask("all")}
            className="text-blue-400 hover:underline"
          >
            {tr("dashboard.clearFilter")}
          </button>
        </div>
      )}

      {/* ── Row 1: 5 stat cards ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">

        {/* 活跃任务 */}
        <Card className="gap-1">
          <CardHeader className="pb-0">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <TargetIcon className="size-3" /> {tr("dashboard.stat.activeTasks")}
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold tabular-nums">
                {tasksByStatus.running ?? 0}
              </span>
              <span className="text-xs text-muted-foreground">/ {tasks.length}</span>
            </div>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px]">
            {(tasksByStatus.running ?? 0) > 0 && (
              <span className="text-blue-400">{tr("dashboard.stat.exploring", { count: tasksByStatus.running })}</span>
            )}
            {(tasksByStatus.paused ?? 0) > 0 && (
              <span className="text-amber-400">{tr("dashboard.stat.paused", { count: tasksByStatus.paused })}</span>
            )}
            {(tasksByStatus.done ?? 0) > 0 && (
              <span className="text-emerald-400">{tr("dashboard.stat.doneCount", { count: tasksByStatus.done })}</span>
            )}
            {tasks.length === 0 && (
              <span className="text-muted-foreground">{tr("dashboard.noTasks")}</span>
            )}
          </CardContent>
        </Card>

        {/* 确认发现 */}
        <Card className="gap-1">
          <CardHeader className="pb-0">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <BugIcon className="size-3" /> {tr("dashboard.stat.confirmedFindings")}
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {scopedFindings.length}
            </div>
          </CardHeader>
          <CardContent className="flex gap-2.5 text-[10px]">
            <span className="text-red-600">{tr("dashboard.stat.critical", { count: findingsBySev.critical })}</span>
            <span className="text-red-400">{tr("dashboard.stat.high", { count: findingsBySev.high })}</span>
            <span className="text-amber-400">{tr("dashboard.stat.medium", { count: findingsBySev.medium })}</span>
            <span className="text-slate-400">{tr("dashboard.stat.low", { count: findingsBySev.low })}</span>
          </CardContent>
        </Card>

        {/* 资产节点 */}
        <Card className="gap-1">
          <CardHeader className="pb-0">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <NetworkIcon className="size-3" /> {tr("dashboard.stat.assetNodes")}
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {totalAssets}
            </div>
          </CardHeader>
          <CardContent className="text-[10px] text-muted-foreground">
            {tr("dashboard.stat.sharedAcrossTasks")}
          </CardContent>
        </Card>

        {/* 流量交互 */}
        <Card className="gap-1">
          <CardHeader className="pb-0">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <ActivityIcon className="size-3" /> {tr("dashboard.stat.trafficInteractions")}
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {effectiveTrafficCount}
            </div>
          </CardHeader>
          <CardContent className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {settings?.traffic_capture ? (
              <>
                <LiveDot />
                <span>{tr("dashboard.stat.recording")}</span>
              </>
            ) : (
              <span>{tr("dashboard.stat.captureOff")}</span>
            )}
          </CardContent>
        </Card>

        {/* LLM 用量 */}
        <Card className="gap-1">
          <CardHeader className="pb-0">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <ZapIcon className="size-3" /> {tr("dashboard.stat.tokenUsage")}
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {fmtTokens(displayedTokens.input + displayedTokens.output) || "—"}
            </div>
          </CardHeader>
          <CardContent className="text-[10px] text-muted-foreground">
            {tr("dashboard.stat.tokenBreakdown", { input: fmtTokens(displayedTokens.input), cache: fmtTokens(displayedTokens.cacheRead), output: fmtTokens(displayedTokens.output) })}
          </CardContent>
        </Card>
      </div>

      {/* ── Row 1.5: 平台能力总览 | 最近报告 | 热门 Skill/MCP ──
          平台能力总览 / 热门 Skill·MCP 为平台级(不受任务筛选)；最近报告为任务级(随任务筛选) ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">

        {/* 平台能力总览 */}
        <Card className="p-4">
          <SectionTitle icon={LayersIcon}>{tr("dashboard.cap.title")}</SectionTitle>
          <div className="flex flex-col divide-y">
            {capRows.map((row) => {
              const RowIcon = row.icon;
              return (
                <Link
                  key={row.href}
                  href={row.href}
                  className="group -mx-1 flex items-center gap-2.5 rounded px-1 py-2 first:pt-0 last:pb-0 hover:bg-muted/30"
                >
                  <RowIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 text-[11px] font-medium">{row.label}</span>
                  {row.badge && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[9px] text-muted-foreground">
                      {row.badge}
                    </Badge>
                  )}
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {row.detail}
                  </span>
                  <ArrowUpRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              );
            })}
          </div>
        </Card>

        {/* 最近报告 */}
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              <FileTextIcon className="size-3.5 text-muted-foreground" />
              {tr("dashboard.recentReports.title")}
            </div>
            <Link
              href="/system/reports"
              className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              {tr("dashboard.all")} <ArrowUpRightIcon className="size-3" />
            </Link>
          </div>
          <div className="divide-y">
            {recentReports.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                {tr("dashboard.recentReports.empty")}
              </div>
            ) : (
              recentReports.map((r) => (
                <a
                  key={r.id}
                  href={api.reportRecordDownloadUrl(r.id)}
                  className="group flex items-center gap-2 py-2 first:pt-0 last:pb-0"
                >
                  <DownloadIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium group-hover:underline">
                      {r.filename}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {r.company || r.task_desc || "—"}
                    </div>
                  </div>
                  <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">
                    {fmtRel(r.created_at)}
                  </span>
                </a>
              ))
            )}
          </div>
        </Card>

        {/* 热门 Skill / MCP */}
        <Card className="p-4">
          <SectionTitle
            icon={SparklesIcon}
            sub={tr("dashboard.cap.calls", { count: (skillStats?.total_calls ?? 0) + mcpCalls })}
          >
            {tr("dashboard.hot.title")}
          </SectionTitle>
          {hotItems.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {tr("dashboard.hot.empty")}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {hotItems.map((it) => (
                <div key={`${it.kind}:${it.name}`} className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "shrink-0 rounded border px-1 py-0 font-mono text-[8px] uppercase",
                      it.kind === "skill"
                        ? "border-violet-500/30 bg-violet-500/10 text-violet-400"
                        : "border-cyan-500/30 bg-cyan-500/10 text-cyan-400",
                    )}
                  >
                    {it.kind === "skill" ? tr("dashboard.hot.skill") : tr("dashboard.hot.mcp")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[10px]">{it.name}</span>
                  <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        it.kind === "skill" ? "bg-violet-500" : "bg-cyan-500",
                      )}
                      style={{ width: `${(it.calls / hotMax) * 100}%` }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right tabular-nums text-[10px]">{it.calls}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── Row 2: LLM Token 消耗 ── */}
      <Card className="p-4">
        {/* Header */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <ZapIcon className="size-3.5 text-muted-foreground" />
            {tr("dashboard.tokenConsumption.title")}
            <span className="ml-1 text-[10px] font-normal text-muted-foreground">
              {isTaskScoped
                ? tr("dashboard.filterScoped", { name: selectedTaskName })
                : tr("dashboard.tokenConsumption.taskTotal", { count: tasks.length })}
            </span>
          </div>
          {/* Profile tabs — global-analysis only; hidden when a single task is scoped */}
          {!isTaskScoped && (
          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={() => setTokenTab("all")}
              className={cn(
                "rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors",
                tokenTab === "all"
                  ? "bg-foreground text-background"
                  : "bg-muted/30 text-muted-foreground hover:text-foreground",
              )}
            >
              {tr("dashboard.all")}
            </button>
            {llmProfiles.map((p) => {
              const key = Number(p.id);
              const hasData = tokenByProfile.has(key) || (p.is_default && tokenByProfile.has(defaultProfileId));
              const resolvedKey = tokenByProfile.has(key) ? key : (p.is_default ? defaultProfileId : key);
              return (
                <button
                  key={p.id}
                  onClick={() => setTokenTab(resolvedKey)}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors",
                    tokenTab === resolvedKey
                      ? "bg-foreground text-background"
                      : "bg-muted/30 text-muted-foreground hover:text-foreground",
                    !hasData && "opacity-40",
                  )}
                >
                  {p.name}
                  {p.is_default && (
                    <span className={cn(
                      "rounded px-1 py-0 text-[8px]",
                      tokenTab === resolvedKey
                        ? "bg-background/20 text-background"
                        : "bg-emerald-500/20 text-emerald-400",
                    )}>
                      {tr("dashboard.default")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          )}
        </div>

        {/* Body: metrics left + bar chart right (chart hidden when a task is scoped) */}
        <div className={cn("grid grid-cols-1 gap-6", !isTaskScoped && "lg:grid-cols-[220px_1fr]")}>

          {/* Left: key metrics */}
          <div className="flex flex-col gap-4">
            {/* Total */}
            <div>
              <div className="text-[10px] text-muted-foreground">{tr("dashboard.tokenConsumption.total")}</div>
              <div className="mt-0.5 text-3xl font-bold tabular-nums tracking-tight">
                {fmtTokens(displayedTokens.input + displayedTokens.output) || "—"}
              </div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {tr("dashboard.taskCount", { count: displayedTokens.taskCount })}
              </div>
            </div>

            {/* Per-type bars */}
            <div className="space-y-3">
              {(() => {
                // input 已含缓存；拆成不重叠三段：未命中输入 + 缓存命中 + 输出 = 总量。
                const total = displayedTokens.input + displayedTokens.output;
                return [
                  { label: tr("dashboard.tokenConsumption.inputMiss"), value: displayedTokens.input - displayedTokens.cacheRead, barColor: dailyTrendConfig.input.color!,     text: "text-blue-400" },
                  { label: tr("dashboard.tokenConsumption.cacheHit"),  value: displayedTokens.cacheRead,                          barColor: dailyTrendConfig.cacheRead.color!, text: "text-emerald-400" },
                  { label: tr("dashboard.tokenType.output"),           value: displayedTokens.output,                             barColor: dailyTrendConfig.output.color!,    text: "text-violet-400" },
                ].map(({ label, value, barColor, text }) => {
                  const pct = total > 0 ? (value / total) * 100 : 0;
                  return (
                    <div key={label}>
                      <div className="mb-1 flex items-center justify-between text-[10px]">
                        <span className="text-muted-foreground">{label}</span>
                        <span className={cn("font-mono font-semibold tabular-nums", text)}>
                          {fmtTokens(value)}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${pct}%`, background: barColor }}
                        />
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* Cache hit rate */}
            {(() => {
              // input 已含缓存 → 命中率 = 缓存命中 / 总输入。
              const denominator = displayedTokens.input;
              const hitPct = denominator > 0 ? Math.round((displayedTokens.cacheRead / denominator) * 100) : 0;
              return (
                <div className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-2 text-[10px]">
                  <span className="text-muted-foreground">{tr("dashboard.tokenConsumption.cacheHitRate")}</span>
                  <span className={cn("font-semibold tabular-nums", hitPct > 50 ? "text-emerald-400" : "text-amber-400")}>
                    {hitPct}%
                  </span>
                </div>
              );
            })()}
          </div>

          {/* Right: daily bar chart (global trend tool — hidden for a single scoped task) */}
          {!isTaskScoped && (
          <div className="flex min-h-0 flex-col">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex gap-3 text-[9px] text-muted-foreground">
                {(["input", "output", "cacheRead"] as const).map((k) => (
                  <span key={k} className="flex items-center gap-1">
                    <span
                      className="inline-block size-2 rounded-sm"
                      style={{ background: dailyTrendConfig[k].color }}
                    />
                    {tokenTypeLabel(k)}
                  </span>
                ))}
              </div>
              <div className="flex gap-0.5 rounded-md border bg-muted/30 p-0.5">
                {([
                  { days: 7,   label: tr("dashboard.range.d7") },
                  { days: 30,  label: tr("dashboard.range.d30") },
                  { days: 90,  label: tr("dashboard.range.m3") },
                  { days: 180, label: tr("dashboard.range.m6") },
                  { days: 365, label: tr("dashboard.range.y1") },
                ] as const).map(({ days, label }) => (
                  <button
                    key={days}
                    onClick={() => setTokenDays(days)}
                    className={cn(
                      "rounded px-2.5 py-0.5 text-[9px] font-medium transition-colors",
                      tokenDays === days
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {dailyTokenData.length === 0 ? (
              <div className="flex flex-1 items-center justify-center rounded-lg border bg-muted/10 text-xs text-muted-foreground" style={{ minHeight: 180 }}>
                {tr("dashboard.noData")}
              </div>
            ) : (
              <ChartContainer config={dailyTrendConfig} className="h-[200px] w-full">
                <BarChart
                  data={dailyTokenData}
                  margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
                  maxBarSize={40}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 10 }}
                    tickMargin={6}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickFormatter={(v) => fmtTokens(Number(v))}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 10 }}
                    width={44}
                  />
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        indicator="line"
                        formatter={(value, name) => (
                          <div className="flex w-full items-center justify-between gap-4">
                            <span>{tokenTypeLabel(String(name))}</span>
                            <span className="font-mono font-semibold tabular-nums">
                              {fmtTokens(Number(value))}
                            </span>
                          </div>
                        )}
                      />
                    }
                  />
                  <Bar dataKey="input"     stackId="1" fill="var(--color-input)"     radius={[0, 0, 0, 0]} />
                  <Bar dataKey="output"    stackId="1" fill="var(--color-output)"    radius={[0, 0, 0, 0]} />
                  <Bar dataKey="cacheRead" stackId="1" fill="var(--color-cacheRead)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </div>
          )}
        </div>
      </Card>

      {/* ── Row 3: 活动流 | 发现 ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">

        {/* 活动流 */}
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              <ActivityIcon className="size-3.5 text-muted-foreground" />
              {tr("dashboard.activityFeed.title")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">
                {tr("dashboard.activityFeed.eventCount", { count: activity.filter((a) => a.kind !== "usage").length })}
              </span>
              <Link
                href={activityTaskId ? `/function/tasks/detail?id=${activityTaskId}` : "/function/tasks"}
                className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                {tr("dashboard.activityFeed.viewTasks")} <ArrowUpRightIcon className="size-3" />
              </Link>
            </div>
          </div>

          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {(["tool_use", "tool_result", "text", "thinking", "result"] as const).map(
              (kind) => {
                const count = activity.filter((a) => a.kind === kind).length;
                if (count === 0) return null;
                return (
                  <span
                    key={kind}
                    className="rounded border bg-muted/20 px-1.5 py-0.5 text-[9px] text-muted-foreground"
                  >
                    {kind} <strong className="text-foreground/70">{count}</strong>
                  </span>
                );
              },
            )}
          </div>

          <div className="divide-y">
            {recentActivity.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                {tr("dashboard.activityFeed.empty")}
              </div>
            ) : (
              recentActivity.map((a) => (
                <div key={a.seq} className="flex gap-2.5 py-2">
                  <span
                    className={cn(
                      "shrink-0 self-start rounded border px-1.5 py-0.5 font-mono text-[9px]",
                      workerBg(a.worker),
                    )}
                  >
                    {a.worker}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium">{kindLabel(a)}</div>
                    <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                      {a.summary}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <Badge
                      variant="outline"
                      className="px-1.5 py-0 text-[9px] text-muted-foreground"
                    >
                      {a.kind}
                    </Badge>
                    <div className="mt-0.5 text-[9px] tabular-nums text-muted-foreground">
                      {fmtRel(a.ts)}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* 发现 */}
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              <BugIcon className="size-3.5 text-muted-foreground" />
              {tr("dashboard.findings.title")}
            </div>
            <Link
              href="/function/findings"
              className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              {tr("dashboard.all")} <ArrowUpRightIcon className="size-3" />
            </Link>
          </div>

          <div className="divide-y">
            {recentFindings.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                {tr("dashboard.findings.empty")}
              </div>
            ) : (
              recentFindings.map((f) => (
                <div key={f.id} className="flex items-start gap-2 py-2">
                  <StatusBadge
                    domain="severity"
                    value={f.severity}
                    className="mt-0.5 shrink-0 px-1.5 py-0 text-[10px]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-semibold">{f.vulnclass}</span>
                      {f.task_description && (
                        <span className="truncate text-[10px] text-muted-foreground">
                          {f.task_description}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                      {f.summary}
                    </div>
                  </div>
                  <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">
                    {fmtRel(f.ts)}
                  </span>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* ── Row 4: 任务表格 ── */}
      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <ClockIcon className="size-3.5 text-muted-foreground" />
            {tr("dashboard.tasks.title")}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              {tr("dashboard.taskCount", {
                count:
                  selectedTask === "all"
                    ? tasks.length
                    : tasks.filter((t) => t.id === selectedTask).length,
              })}
            </span>
            <Link
              href="/function/tasks"
              className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              {tr("dashboard.all")} <ArrowUpRightIcon className="size-3" />
            </Link>
          </div>
        </div>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b">
              {[
                tr("dashboard.tasks.col.task"),
                tr("common.status"),
                tr("dashboard.tasks.col.engine"),
                tr("dashboard.tasks.col.goalProgress"),
                tr("dashboard.tasks.col.inFlight"),
                tr("dashboard.tasks.col.lastActivity"),
              ].map((h) => (
                <th
                  key={h}
                  className="px-4 py-2 text-left text-[9px] font-semibold uppercase tracking-widest text-muted-foreground first:pl-4"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedTasks.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-6 text-center text-xs text-muted-foreground"
                >
                  {tr("dashboard.noTasks")}
                </td>
              </tr>
            ) : (
              sortedTasks.map((t) => {
                const goalsPct = t.goals_total
                  ? Math.round(((t.goals_met ?? 0) / t.goals_total) * 100)
                  : null;
                return (
                  <tr
                    key={t.id}
                    className="border-b last:border-0 transition-colors hover:bg-muted/30"
                  >
                    <td className="max-w-xs px-4 py-3">
                      <Link
                        href={`/function/tasks/detail?id=${t.id}`}
                        className="group flex flex-col"
                      >
                        <span className="truncate font-medium group-hover:underline">
                          {t.description}
                        </span>
                        <span className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                          {t.id}
                        </span>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge domain="task" value={t.status} dot className="px-1.5 py-0 text-[10px]" />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        domain="engine"
                        value={t.engine_mode ?? "idle"}
                        className="px-1.5 py-0 text-[10px]"
                      />
                    </td>
                    <td className="px-4 py-3">
                      {goalsPct !== null ? (
                        <div className="flex items-center gap-2">
                          <Progress value={goalsPct} className="h-1 w-14" />
                          <span className="tabular-nums text-muted-foreground">
                            {t.goals_met ?? 0}/{t.goals_total}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {t.in_flight ?? 0 > 0 ? (
                        <span className="font-semibold">{t.in_flight}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {fmtRel(t.last_activity_unix ?? t.created_unix)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Card>

      {/* ── Row 5: 资产分布 | 流量状态码 | 拦截 & 待审批 ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">

        {/* 资产分布 */}
        <Card className="p-4">
          <SectionTitle icon={NetworkIcon} sub={tr("dashboard.assets.byType")}>
            {tr("dashboard.assets.title")}
          </SectionTitle>

          {assetByType.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {tr("dashboard.assets.empty")}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {assetByType.map(([type, count]) => (
                <div key={type} className="flex items-center gap-2 text-xs">
                  <span className="w-8 shrink-0 text-right text-[10px] text-muted-foreground">
                    {assetTypeLabel(type)}
                  </span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn("h-full rounded-full", ASSET_COLORS[type] ?? "bg-slate-400")}
                      style={{ width: `${(count / assetMax) * 100}%` }}
                    />
                  </div>
                  <span className="w-4 text-right tabular-nums">{count}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 border-t pt-3 text-[10px] text-muted-foreground">
            {tr("dashboard.assets.totalNodes", { count: totalAssets })}
          </div>
        </Card>

        {/* 流量状态码 */}
        <Card className="p-4">
          <SectionTitle icon={ActivityIcon} sub={tr("dashboard.traffic.requestCount", { count: effectiveTrafficCount })}>
            {tr("dashboard.traffic.title")}
          </SectionTitle>

          {/* bar chart */}
          {trafficByCodes.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {tr("dashboard.traffic.empty")}
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-end gap-2" style={{ height: 52 }}>
                {trafficByCodes.map(({ code, n }) => (
                  <div key={code} className="flex flex-1 flex-col items-center gap-1">
                    <span className="text-[9px] tabular-nums text-muted-foreground">
                      {n}
                    </span>
                    <div
                      className={cn(
                        "w-full min-h-1 rounded-sm",
                        statusBg(code),
                        "opacity-80",
                      )}
                      style={{ height: Math.max(4, (n / trafficMax) * 36) }}
                    />
                    <span className={cn("text-[9px] font-mono", statusColor(code))}>
                      {code}
                    </span>
                  </div>
                ))}
              </div>

              <div className="border-t pt-2.5">
                <div className="mb-1.5 text-[10px] text-muted-foreground">
                  {tr("dashboard.traffic.recentRequests")}
                </div>
                <div className="flex flex-col gap-1.5">
                  {recentTraffic.map((e) => (
                    <div key={e.id} className="flex items-center gap-1.5 text-[10px]">
                      <span
                        className={cn(
                          "shrink-0 rounded border px-1 py-0 font-mono text-[9px]",
                          e.method === "GET"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                            : "border-blue-500/30 bg-blue-500/10 text-blue-400",
                        )}
                      >
                        {e.method}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {e.host}
                        {e.url.replace(/^https?:\/\/[^/]+/, "").substring(0, 30)}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 font-mono text-[9px]",
                          statusColor(e.status),
                        )}
                      >
                        {e.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </Card>

        {/* 系统状态 & 待审批 */}
        <Card className="p-4">
          <SectionTitle icon={ShieldCheckIcon}>{tr("dashboard.system.title")}</SectionTitle>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-2">
              <div className="text-[10px] text-muted-foreground">{tr("dashboard.system.llmConfig")}</div>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  stats?.llm_configured
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : "border-red-500/30 bg-red-500/10 text-red-400",
                )}
              >
                {stats?.llm_configured ? tr("dashboard.system.configured") : tr("dashboard.system.notConfigured")}
              </Badge>
            </div>

            <div className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-2">
              <div className="text-[10px] text-muted-foreground">{tr("dashboard.system.trafficCapture")}</div>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  settings?.traffic_capture
                    ? "border-violet-500/30 bg-violet-500/10 text-violet-400"
                    : "text-muted-foreground",
                )}
              >
                {settings?.traffic_capture ? tr("dashboard.system.on") : tr("dashboard.system.off")}
              </Badge>
            </div>

            {activeProfile && (
              <div className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-2">
                <div className="text-[10px] text-muted-foreground">{tr("dashboard.system.activeModel")}</div>
                <span className="font-mono text-[10px]">{activeProfile.model}</span>
              </div>
            )}
          </div>

          {/* pending approvals */}
          {pendingCount > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[10px] font-medium text-amber-400">
                {tr("dashboard.approvals.pending", { count: pendingCount })}
              </div>
              <div className="flex flex-col gap-1.5">
                {pending.slice(0, 3).map((p) => (
                  <Link
                    key={p.id}
                    href="/system/intercept/approvals"
                    className="flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 hover:bg-amber-500/10"
                  >
                    <div className="min-w-0">
                      <div className="text-[10px] font-medium">{p.tool_name}</div>
                      <div className="text-[9px] text-muted-foreground">
                        {p.agent_name}
                      </div>
                    </div>
                    <ArrowUpRightIcon className="size-3 shrink-0 text-amber-400" />
                  </Link>
                ))}
                {pendingCount > 3 && (
                  <Link
                    href="/system/intercept/approvals"
                    className="text-center text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    {tr("dashboard.approvals.more", { count: pendingCount - 3 })}
                  </Link>
                )}
              </div>
            </div>
          )}

          {pendingCount === 0 && (
            <div className="mt-3 rounded-lg border bg-muted/10 px-3 py-3 text-center text-[10px] text-muted-foreground">
              <ShieldCheckIcon className="mx-auto mb-1 size-4 text-emerald-500/50" />
              {tr("dashboard.approvals.empty")}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
