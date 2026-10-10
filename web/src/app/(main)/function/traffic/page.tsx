"use client";

import * as React from "react";
import {
  RadioTowerIcon,
  SearchIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XIcon,
  Loader2Icon,
  CopyIcon,
  CheckIcon,
  Maximize2Icon,
  Minimize2Icon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { taskLabel } from "@/lib/task-label";
import type { Task, TrafficExchange, TrafficResp, TrafficDetail } from "@/lib/types";

function fmtTime(ts: string) {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtBytes(n: number) {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / Math.pow(1024, i);
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

function statusTone(status: number) {
  if (status >= 500) return "text-red-500";
  if (status >= 400) return "text-amber-500";
  if (status >= 300) return "text-blue-500";
  if (status >= 200) return "text-emerald-500";
  return "text-muted-foreground";
}

// Fixed method set (server filters exact-match); avoids deriving options from a
// single page, which would only ever list the methods on that page.
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
const PAGE_SIZES = [25, 50, 100, 200];

export default function TrafficPage() {
  const { t } = useTranslation();
  const [page, setPage] = React.useState(0);
  const [size, setSize] = React.useState(50);
  const [host, setHost] = React.useState(""); // raw host input
  const [hostQ, setHostQ] = React.useState(""); // debounced → server
  const [query, setQuery] = React.useState(""); // raw free-text input
  const [queryQ, setQueryQ] = React.useState(""); // debounced → server
  const [method, setMethod] = React.useState("all");
  const [taskFilter, setTaskFilter] = React.useState("all");
  const [tasks, setTasks] = React.useState<Task[]>([]);

  const [traffic, setTraffic] = React.useState<TrafficResp | null>(null);
  const [selected, setSelected] = React.useState<TrafficExchange | null>(null);
  const [detail, setDetail] = React.useState<TrafficDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false); // 放大详情面板(便于截完整包)
  const [copied, setCopied] = React.useState<string | null>(null); // 复制反馈("req"/"resp")

  // Task list drives the per-task filter dropdown (traffic is host-keyed with no
  // task column, so the backend scopes a task by its discovered asset hosts).
  React.useEffect(() => {
    api.tasks().then((r) => setTasks(r.tasks)).catch(() => {});
  }, []);

  // Debounce both filters so we don't refetch on every keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setHostQ(host.trim()), 300);
    return () => clearTimeout(t);
  }, [host]);
  React.useEffect(() => {
    const t = setTimeout(() => setQueryQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Any filter/size change resets to the first page.
  React.useEffect(() => {
    setPage(0);
  }, [hostQ, queryQ, method, size, taskFilter]);

  // Load the current page. Auto-refresh only on page 0 (newest) so paging back
  // through history isn't yanked out from under the user.
  React.useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .traffic(page, size, hostQ, method, queryQ, taskFilter === "all" ? 0 : Number(taskFilter))
        .then((r) => {
          if (alive) setTraffic(r);
        })
        .catch(() => {});
    load();
    const t = page === 0 ? setInterval(load, 5000) : null;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [page, size, hostQ, method, queryQ, taskFilter]);

  // Lazy-load the raw request/response for the selected exchange.
  React.useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetailLoading(true);
    setDetail(null);
    api
      .trafficExchange(selected.id)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => {
        if (alive) setDetail({ req: t("traffic.loadFailed"), resp: "" });
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  const exchanges = React.useMemo(() => traffic?.exchanges ?? [], [traffic]);
  const total = traffic?.total ?? exchanges.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const rangeStart = total === 0 ? 0 : page * size + 1;
  const rangeEnd = page * size + exchanges.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("traffic.title")}</h1>
          <p className="text-muted-foreground text-sm">
            {t("traffic.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
              traffic?.enabled
                ? "border-emerald-500/20 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "border-transparent bg-muted text-muted-foreground",
            )}
          >
            <RadioTowerIcon className="size-3.5" />
            {traffic?.enabled ? t("traffic.recording") : t("traffic.stopped")}
          </span>
          {traffic?.proxy && (
            <span className="font-mono text-xs text-muted-foreground">
              {traffic.proxy}
            </span>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("traffic.totalCount", { count: traffic?.count ?? 0 })}
          </span>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-48">
          <Input
            placeholder="host…"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            className="h-8"
          />
        </div>
        <div className="relative max-w-sm flex-1">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("traffic.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-8"
          />
        </div>
        <Select value={method} onValueChange={setMethod}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue placeholder={t("traffic.method")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("traffic.allMethods")}</SelectItem>
            {METHODS.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={taskFilter} onValueChange={setTaskFilter}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder={t("traffic.filterTask")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("traffic.allTasks")}</SelectItem>
            {tasks.map((tk) => (
              <SelectItem key={tk.id} value={tk.id}>
                {taskLabel(tk)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(size)} onValueChange={(v) => setSize(Number(v))}>
          <SelectTrigger size="sm" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {t("traffic.perPage", { n })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {rangeStart}–{rangeEnd} / {total}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={page <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeftIcon />
          </Button>
          <span className="tabular-nums">
            {page + 1} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>

      {taskFilter !== "all" && (
        <p className="text-xs text-muted-foreground">{t("traffic.taskHint")}</p>
      )}

      {/* History table + detail (Burp-style split) */}
      <div className="flex h-[calc(100vh-15rem)] min-h-0 flex-col gap-3">
        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden py-0">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="w-36">{t("traffic.colTime")}</TableHead>
                  <TableHead className="w-44">host</TableHead>
                  <TableHead className="w-20">{t("traffic.method")}</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead className="w-20">{t("traffic.colStatus")}</TableHead>
                  <TableHead className="w-36">content-type</TableHead>
                  <TableHead className="w-24 text-right">{t("traffic.colRespLen")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exchanges.map((e) => (
                  <TableRow
                    key={e.id}
                    className={cn(
                      "cursor-pointer",
                      selected?.id === e.id && "bg-accent hover:bg-accent",
                    )}
                    onClick={() => setSelected(e)}
                  >
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {fmtTime(e.ts)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.host}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs">
                        {e.method}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-0">
                      <span className="block truncate font-mono text-xs">
                        {e.url}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "font-mono text-xs font-semibold tabular-nums",
                          statusTone(e.status),
                        )}
                      >
                        {e.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {e.content_type}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {fmtBytes(e.resp_len)}
                    </TableCell>
                  </TableRow>
                ))}
                {exchanges.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-12 text-center text-sm text-muted-foreground"
                    >
                      {traffic === null ? t("common.loading") : t("traffic.empty")}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Card>

        {/* Raw request/response pane */}
        {selected && (
          <Card
            className={cn(
              "flex min-h-0 flex-col overflow-hidden py-0",
              expanded ? "h-[82%]" : "h-[42%]",
            )}
          >
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <Badge variant="outline" className="font-mono text-xs">
                {selected.method}
              </Badge>
              <span className="truncate font-mono text-xs">{selected.url}</span>
              <span
                className={cn(
                  "ml-auto font-mono text-xs font-semibold tabular-nums",
                  statusTone(selected.status),
                )}
              >
                {selected.status}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label={expanded ? "collapse" : "expand"}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="close"
                onClick={() => {
                  setSelected(null);
                  setExpanded(false);
                }}
              >
                <XIcon />
              </Button>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-2 divide-x">
              {(
                [
                  ["req", t("traffic.reqLabel"), detail?.req],
                  ["resp", t("traffic.respLabel"), detail?.resp],
                ] as const
              ).map(([key, label, body]) => (
                <div key={key} className="flex min-h-0 min-w-0 flex-col">
                  <div className="flex items-center gap-2 border-b px-3 py-1">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {label}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-auto size-6 shrink-0"
                      aria-label="copy"
                      disabled={!body}
                      onClick={() => {
                        if (!body) return;
                        navigator.clipboard?.writeText(body);
                        setCopied(key);
                        setTimeout(() => setCopied(null), 1200);
                      }}
                    >
                      {copied === key ? (
                        <CheckIcon className="size-3.5 text-emerald-500" />
                      ) : (
                        <CopyIcon className="size-3.5" />
                      )}
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto">
                    {detailLoading ? (
                      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                        <Loader2Icon className="size-3.5 animate-spin" />
                        {t("traffic.loadingBody")}
                      </div>
                    ) : (
                      <pre className="p-3 font-mono text-xs break-all whitespace-pre-wrap">
                        {body || t("traffic.emptyBody")}
                      </pre>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
