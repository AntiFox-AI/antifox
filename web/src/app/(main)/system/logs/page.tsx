"use client";

import * as React from "react";

import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, sseUrl } from "@/lib/api";
import { MOCK } from "@/lib/mock/enabled";
import type { AuditLog, LogLine } from "@/lib/types";
import { cn } from "@/lib/utils";

type TFn = ReturnType<typeof useTranslation>["t"];

// Mock demo：无后端 SSE，塞几行示例日志。
function buildMockLogs(t: TFn): LogLine[] {
  return [
    { seq: 1, ts: "2026-07-26T03:55:00Z", level: "info", tag: "engine", text: "AntiFox v2.0.0 backend listening on :8787 (workers=3)" },
    { seq: 2, ts: "2026-07-26T03:55:01Z", level: "info", tag: "config", text: "LLM configured from DB: anthropic / claude-opus-4-8" },
    { seq: 3, ts: "2026-07-26T03:56:10Z", level: "info", tag: "planner", text: t("logs.mock.planning") },
    { seq: 4, ts: "2026-07-26T03:57:00Z", level: "warn", tag: "guard", text: t("logs.mock.blocked") },
    { seq: 5, ts: "2026-07-26T03:57:30Z", level: "info", tag: "work#1", text: t("logs.mock.finding") },
    { seq: 6, ts: "2026-07-26T03:58:20Z", level: "error", tag: "work#3", text: t("logs.mock.intercept") },
  ];
}

const levelTone: Record<LogLine["level"], string> = {
  info: "text-foreground/80",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
};
const levelDot: Record<LogLine["level"], string> = {
  info: "bg-muted-foreground/40",
  warn: "bg-amber-500",
  error: "bg-red-500",
};

function fmtTime(ts: string) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  // 显示完整日期+时间（登录日志等需按日期区分，仅时间会误导）。
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export default function LogsPage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("logs.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("logs.subtitle")}</p>
      </div>
      <Tabs defaultValue="system" className="flex flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="system">{t("logs.tabs.system")}</TabsTrigger>
          <TabsTrigger value="audit">{t("logs.tabs.audit")}</TabsTrigger>
        </TabsList>
        <TabsContent value="system" className="flex flex-1 flex-col">
          <SystemLogPanel />
        </TabsContent>
        <TabsContent value="audit" className="flex flex-1 flex-col">
          <AuditLogPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- 系统日志（实时 SSE 流）----------
function SystemLogPanel() {
  const { t } = useTranslation();
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const [q, setQ] = React.useState("");
  const [level, setLevel] = React.useState<"all" | LogLine["level"]>("all");
  const [paused, setPaused] = React.useState(false);
  const [loadingHistory, setLoadingHistory] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false);
  const bottom = React.useRef<HTMLDivElement>(null);
  const stick = React.useRef(true);
  const pausedRef = React.useRef(false);
  pausedRef.current = paused;

  const minDbId = React.useMemo(() => {
    let min = 0;
    for (const l of lines) {
      if (l.db_id && (min === 0 || l.db_id < min)) min = l.db_id;
    }
    return min;
  }, [lines]);

  React.useEffect(() => {
    if (MOCK) setLines(buildMockLogs(t));
  }, [t]);

  React.useEffect(() => {
    if (MOCK) return;
    const es = new EventSource(sseUrl("/api/logs/stream?since=0"));
    es.onmessage = (e) => {
      if (pausedRef.current) return;
      try {
        const l = JSON.parse(e.data) as LogLine;
        setLines((prev) => (prev.some((x) => x.seq === l.seq) ? prev : [...prev, l].slice(-3000)));
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => es.close();
  }, []);

  React.useEffect(() => {
    if (minDbId > 1) setHasMore(true);
  }, [minDbId]);

  async function loadOlderHistory() {
    if (loadingHistory) return;
    setLoadingHistory(true);
    try {
      const params = minDbId > 0 ? `?before=${minDbId}&limit=200` : `?limit=200`;
      const res = await fetch(`/api/logs/history${params}`);
      if (!res.ok) return;
      const data = await res.json() as { items: LogLine[]; has_more: boolean };
      if (data.items?.length) {
        setLines((prev) => {
          const minSeq = prev.reduce((m, l) => Math.min(m, l.seq ?? 0), 0);
          const older = data.items.map((l, i) => ({
            ...l,
            seq: minSeq - data.items.length + i,
          }));
          const merged = [...older, ...prev];
          const seen = new Set<number>();
          const deduped = merged.filter((l) => {
            if (!l.db_id) return true;
            if (seen.has(l.db_id)) return false;
            seen.add(l.db_id);
            return true;
          });
          return deduped.slice(-5000);
        });
      }
      setHasMore(data.has_more ?? false);
    } finally {
      setLoadingHistory(false);
    }
  }

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lines.filter(
      (l) =>
        (level === "all" || l.level === level) &&
        (!needle || l.text.toLowerCase().includes(needle) || l.tag.toLowerCase().includes(needle)),
    );
  }, [lines, q, level]);

  React.useEffect(() => {
    if (stick.current && !paused) bottom.current?.scrollIntoView();
  }, [filtered, paused]);

  const counts = React.useMemo(() => {
    let warn = 0,
      error = 0;
    for (const l of lines) {
      if (l.level === "warn") warn++;
      else if (l.level === "error") error++;
    }
    return { warn, error, total: lines.length };
  }, [lines]);

  return (
    <div className="flex flex-1 flex-col gap-3 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder={t("logs.filterPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-8 max-w-xs"
        />
        <div className="flex gap-1">
          {(["all", "info", "warn", "error"] as const).map((lv) => (
            <Button
              key={lv}
              size="sm"
              variant={level === lv ? "default" : "outline"}
              className="h-8"
              onClick={() => setLevel(lv)}
            >
              {lv === "all" ? t("logs.levelAll") : lv}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant={paused ? "default" : "outline"}
          className="h-8"
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? t("logs.paused") : t("logs.pause")}
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setLines([])}>
          {t("logs.clear")}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {counts.total} {t("logs.rows")} ·{" "}
          <span className="text-amber-600 dark:text-amber-400">{counts.warn} {t("logs.warnings")}</span> ·{" "}
          <span className="text-red-600 dark:text-red-400">{counts.error} {t("logs.errors")}</span>
        </span>
      </div>

      <div
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="h-[calc(100vh-17rem)] overflow-auto rounded-lg border bg-card p-2 font-mono text-xs leading-relaxed"
      >
        {hasMore && (
          <div className="flex justify-center py-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={loadingHistory}
              onClick={loadOlderHistory}
            >
              {loadingHistory ? t("common.loading") : t("logs.loadOlder")}
            </Button>
          </div>
        )}
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-muted-foreground">{t("logs.empty")}</p>
        ) : (
          filtered.map((l) => {
            const body =
              l.tag && l.text.startsWith("[" + l.tag + "]")
                ? l.text.slice(l.tag.length + 2).trimStart()
                : l.text;
            return (
              <div key={l.seq} className="flex items-start gap-2 px-1 py-0.5 hover:bg-muted/40">
                <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", levelDot[l.level])} />
                <span className="shrink-0 tabular-nums text-muted-foreground">{fmtTime(l.ts)}</span>
                {l.tag && (
                  <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-foreground/70">{l.tag}</span>
                )}
                <span className={cn("min-w-0 whitespace-pre-wrap break-words", levelTone[l.level])}>{body}</span>
              </div>
            );
          })
        )}
        <div ref={bottom} />
      </div>
    </div>
  );
}

// ---------- 登录与审计（审计表，服务端分页）----------
const PAGE_SIZE = 50;

function AuditLogPanel() {
  const { t } = useTranslation();
  const [logs, setLogs] = React.useState<AuditLog[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(0);
  const [category, setCategory] = React.useState("auth");
  const [result, setResult] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");

  const load = React.useCallback(async () => {
    if (MOCK) {
      setLogs([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const data = await api.auditLogs({
        category: category || undefined,
        result: result || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setLogs(data.logs ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setErr(t("logs.audit.loadError"));
    } finally {
      setLoading(false);
    }
  }, [category, result, page, t]);

  React.useEffect(() => {
    load();
  }, [load]);

  function changeCategory(v: string) {
    setCategory(v);
    setPage(0);
  }
  function changeResult(v: string) {
    setResult(v);
    setPage(0);
  }

  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <div className="flex flex-1 flex-col gap-3 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect size="sm" value={category} onChange={(e) => changeCategory(e.target.value)} className="min-w-[8rem]">
          <NativeSelectOption value="">{t("logs.audit.catAll")}</NativeSelectOption>
          <NativeSelectOption value="auth">{t("logs.audit.catAuth")}</NativeSelectOption>
          <NativeSelectOption value="rbac">{t("logs.audit.catRbac")}</NativeSelectOption>
          <NativeSelectOption value="config">{t("logs.audit.catConfig")}</NativeSelectOption>
        </NativeSelect>
        <NativeSelect size="sm" value={result} onChange={(e) => changeResult(e.target.value)} className="min-w-[7rem]">
          <NativeSelectOption value="">{t("logs.audit.resAll")}</NativeSelectOption>
          <NativeSelectOption value="success">{t("logs.audit.resSuccess")}</NativeSelectOption>
          <NativeSelectOption value="fail">{t("logs.audit.resFail")}</NativeSelectOption>
        </NativeSelect>
        <Button size="sm" variant="outline" className="h-7" onClick={() => void load()} disabled={loading}>
          {loading ? t("common.loading") : t("logs.audit.refresh")}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {t("logs.audit.rangeLabel", { from, to, total })}
        </span>
      </div>

      <div className="h-[calc(100vh-17rem)] overflow-auto rounded-lg border bg-card">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/60 text-left text-muted-foreground backdrop-blur">
            <tr>
              <th className="px-3 py-2 font-medium">{t("logs.audit.colTime")}</th>
              <th className="px-3 py-2 font-medium">{t("logs.audit.colActor")}</th>
              <th className="px-3 py-2 font-medium">{t("logs.audit.colAction")}</th>
              <th className="px-3 py-2 font-medium">{t("logs.audit.colResult")}</th>
              <th className="px-3 py-2 font-medium">{t("logs.audit.colIp")}</th>
              <th className="px-3 py-2 font-medium">{t("logs.audit.colMessage")}</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                  {err || t("logs.audit.empty")}
                </td>
              </tr>
            ) : (
              logs.map((l) => {
                const isFail = l.result === "fail";
                const isLock = l.action === "login_locked";
                return (
                  <tr key={l.id} className={cn("border-t hover:bg-muted/30", isLock && "bg-red-500/5")}>
                    <td className="px-3 py-1.5 tabular-nums whitespace-nowrap text-muted-foreground">{fmtTime(l.created_at)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{l.actor || "—"}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap font-mono text-[11px]">
                      <span className="text-muted-foreground">{l.category}/</span>
                      {l.action}
                    </td>
                    <td className="px-3 py-1.5">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          isFail
                            ? "border-red-500/40 text-red-600 dark:text-red-400"
                            : "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
                        )}
                      >
                        {isFail ? t("logs.audit.resFail") : t("logs.audit.resSuccess")}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap font-mono text-[11px] text-muted-foreground">{l.ip || "—"}</td>
                    <td className="px-3 py-1.5 break-words">{l.message}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" className="h-7" disabled={page <= 0 || loading} onClick={() => setPage(0)}>
          {t("logs.audit.first")}
        </Button>
        <Button size="sm" variant="outline" className="h-7" disabled={page <= 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          {t("logs.audit.prev")}
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">{t("logs.audit.pageLabel", { page: page + 1, pages: maxPage + 1 })}</span>
        <Button size="sm" variant="outline" className="h-7" disabled={page >= maxPage || loading} onClick={() => setPage((p) => Math.min(maxPage, p + 1))}>
          {t("logs.audit.next")}
        </Button>
        <Button size="sm" variant="outline" className="h-7" disabled={page >= maxPage || loading} onClick={() => setPage(maxPage)}>
          {t("logs.audit.last")}
        </Button>
      </div>
    </div>
  );
}
