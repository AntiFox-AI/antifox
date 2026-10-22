"use client";

import * as React from "react";
import {
  RadioTowerIcon,
  SearchIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XIcon,
  Loader2Icon,
  CameraIcon,
  Maximize2Icon,
  Minimize2Icon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { HttpPacket, requestWithHost } from "@/components/http-packet";
import { PacketShotModal } from "@/components/packet-shot-modal";
import { LinkTrafficDialog } from "@/components/link-traffic-dialog";

import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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

// SnippetText renders a body-search match excerpt, bolding the hit that the backend
// wrapped in \x01…\x02 markers (snippet() output).
function SnippetText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /\x01([^\x02]*)\x02/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <mark key={i++} className="rounded-sm bg-amber-300/60 px-0.5 text-foreground dark:bg-amber-500/40">
        {m[1]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <span className="font-mono text-[11px] leading-relaxed break-all text-muted-foreground">{parts}</span>;
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
  // 高级筛选：路径 / 状态码桶 / 响应长度区间（走后端索引列）
  const [path, setPath] = React.useState("");
  const [pathQ, setPathQ] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [respMin, setRespMin] = React.useState("");
  const [respMax, setRespMax] = React.useState("");
  // 正文搜索：请求+响应解码后全文，FTS trigram（≥3 字），命中带高亮片段
  const [body, setBody] = React.useState("");
  const [bodyQ, setBodyQ] = React.useState("");

  const [traffic, setTraffic] = React.useState<TrafficResp | null>(null);
  const [selected, setSelected] = React.useState<TrafficExchange | null>(null);
  const [detail, setDetail] = React.useState<TrafficDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false); // 放大详情面板(便于截完整包)
  const [shotMode, setShotMode] = React.useState(false); // 截图模式：请求+响应一屏，替代 Burp 截图
  const [selectedFlows, setSelectedFlows] = React.useState<Set<string>>(new Set()); // 勾选待关联的流量
  const [linkOpen, setLinkOpen] = React.useState(false); // 关联到漏洞弹窗

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
  React.useEffect(() => {
    const t = setTimeout(() => setPathQ(path.trim()), 300);
    return () => clearTimeout(t);
  }, [path]);
  React.useEffect(() => {
    const t = setTimeout(() => setBodyQ(body.trim()), 300);
    return () => clearTimeout(t);
  }, [body]);

  // Deep-link: /function/traffic?exchange=<id> opens that exact packet's detail
  // (jumped from a finding's evidence), even if it's not on the current page. Reads
  // window.location directly so it works under static export without a Suspense boundary.
  React.useEffect(() => {
    const exId = new URLSearchParams(window.location.search).get("exchange");
    if (!exId) return;
    api
      .trafficMeta(exId)
      .then((m) => setSelected(m))
      .catch(() => {});
    // Drop the param so a refresh doesn't re-trigger the jump.
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // Any filter/size change resets to the first page.
  React.useEffect(() => {
    setPage(0);
  }, [hostQ, queryQ, method, size, taskFilter, pathQ, statusFilter, respMin, respMax, bodyQ]);

  // Load the current page. Auto-refresh only on page 0 (newest) so paging back
  // through history isn't yanked out from under the user.
  React.useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .traffic(page, size, hostQ, method, queryQ, taskFilter === "all" ? 0 : Number(taskFilter), {
          path: pathQ,
          status: statusFilter,
          respMin: Number(respMin) || 0,
          respMax: Number(respMax) || 0,
          body: bodyQ,
        })
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
  }, [page, size, hostQ, method, queryQ, taskFilter, pathQ, statusFilter, respMin, respMax, bodyQ]);

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

      {/* 高级筛选：路径 / 状态码桶 / 响应长度区间（305k+ 条里精确定位到那一个包）*/}
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
        <span className="pl-1 text-xs font-medium text-muted-foreground">{t("traffic.advFilter")}</span>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("traffic.advBody")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="h-8 w-64 pl-7"
            title={t("traffic.advBodyHint")}
          />
        </div>
        <Input
          placeholder={t("traffic.advPath")}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          className="h-8 w-56"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger size="sm" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("traffic.allStatus")}</SelectItem>
            <SelectItem value="2xx">2xx</SelectItem>
            <SelectItem value="3xx">3xx</SelectItem>
            <SelectItem value="4xx">4xx</SelectItem>
            <SelectItem value="5xx">5xx</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>{t("traffic.respLen")}</span>
          <Input type="number" min={0} placeholder={t("traffic.minB")} value={respMin} onChange={(e) => setRespMin(e.target.value)} className="h-8 w-24" />
          <span>–</span>
          <Input type="number" min={0} placeholder={t("traffic.maxB")} value={respMax} onChange={(e) => setRespMax(e.target.value)} className="h-8 w-24" />
        </div>
        {(body || path || statusFilter !== "all" || respMin || respMax) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => {
              setBody("");
              setPath("");
              setStatusFilter("all");
              setRespMin("");
              setRespMax("");
            }}
          >
            {t("traffic.clearFilter")}
          </Button>
        )}
      </div>

      {taskFilter !== "all" && (
        <p className="text-xs text-muted-foreground">{t("traffic.taskHint")}</p>
      )}

      {/* 勾选流量 → 关联到漏洞（作证据来源） */}
      {selectedFlows.size > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{t("traffic.selectedN", { count: selectedFlows.size })}</span>
          <Button size="sm" className="h-8" onClick={() => setLinkOpen(true)}>
            {t("traffic.linkToFinding")}
          </Button>
          <Button variant="ghost" size="sm" className="h-8" onClick={() => setSelectedFlows(new Set())}>
            {t("traffic.clearSelection")}
          </Button>
        </div>
      )}

      {/* History table + detail (Burp-style split) */}
      <div className="flex h-[calc(100vh-15rem)] min-h-0 flex-col gap-3">
        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden py-0">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      aria-label="select-page"
                      checked={exchanges.length > 0 && exchanges.every((e) => selectedFlows.has(e.id))}
                      onCheckedChange={(c) =>
                        setSelectedFlows((prev) => {
                          const next = new Set(prev);
                          for (const e of exchanges) {
                            if (c === true) next.add(e.id);
                            else next.delete(e.id);
                          }
                          return next;
                        })
                      }
                    />
                  </TableHead>
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
                  <React.Fragment key={e.id}>
                  <TableRow
                    className={cn(
                      "cursor-pointer",
                      selected?.id === e.id && "bg-accent hover:bg-accent",
                      e.match_snippet && "border-b-0",
                    )}
                    onClick={() => setSelected(e)}
                  >
                    <TableCell onClick={(ev) => ev.stopPropagation()}>
                      <Checkbox
                        aria-label={`select ${e.id}`}
                        checked={selectedFlows.has(e.id)}
                        onCheckedChange={() =>
                          setSelectedFlows((prev) => {
                            const next = new Set(prev);
                            if (next.has(e.id)) next.delete(e.id);
                            else next.add(e.id);
                            return next;
                          })
                        }
                      />
                    </TableCell>
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
                  {e.match_snippet && (
                    <TableRow
                      className={cn("cursor-pointer", selected?.id === e.id && "bg-accent hover:bg-accent")}
                      onClick={() => setSelected(e)}
                    >
                      <TableCell />
                      <TableCell colSpan={7} className="pt-0 pb-2">
                        <SnippetText text={e.match_snippet} />
                      </TableCell>
                    </TableRow>
                  )}
                  </React.Fragment>
                ))}
                {exchanges.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
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
              <Badge variant="outline" className="shrink-0 font-mono text-xs">
                {selected.method}
              </Badge>
              <span className="max-w-[16rem] shrink-0 truncate font-mono text-xs font-semibold" title={selected.host}>
                {selected.host}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={selected.url}>
                {selected.url}
              </span>
              <span
                className={cn(
                  "shrink-0 font-mono text-xs font-semibold tabular-nums",
                  statusTone(selected.status),
                )}
              >
                {selected.status}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 gap-1"
                title={t("traffic.shotMode")}
                onClick={() => setShotMode(true)}
              >
                <CameraIcon className="size-3.5" /> {t("traffic.shotMode")}
              </Button>
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
            <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 p-2">
              {(
                [
                  ["req", t("traffic.reqLabel"), requestWithHost(detail?.req ?? "", selected.host, selected.url)],
                  ["resp", t("traffic.respLabel"), detail?.resp ?? ""],
                ] as const
              ).map(([key, label, body]) => (
                <div key={key} className="flex min-h-0 min-w-0 flex-col gap-1">
                  <span className="px-1 text-[11px] font-medium text-muted-foreground">{label}</span>
                  {detailLoading ? (
                    <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                      <Loader2Icon className="size-3.5 animate-spin" />
                      {t("traffic.loadingBody")}
                    </div>
                  ) : (
                    <HttpPacket raw={body} className="min-h-0 flex-1" />
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* 截图模式：请求+响应一屏、自说明头，替代 Burp 截图（与漏洞详情共用 PacketShotModal）*/}
      {shotMode && selected && <PacketShotModal exchange={selected} onClose={() => setShotMode(false)} />}

      {/* 关联到漏洞：把勾选的流量关到某个漏洞作证据来源 */}
      <LinkTrafficDialog
        open={linkOpen}
        exchangeIds={Array.from(selectedFlows)}
        onOpenChange={setLinkOpen}
        onDone={() => {
          setSelectedFlows(new Set());
          setLinkOpen(false);
        }}
      />
    </div>
  );
}
