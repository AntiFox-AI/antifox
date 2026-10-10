"use client";

import * as React from "react";

import Link from "next/link";

import { ArrowUpRightIcon, ChevronRightIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { FindingDetail } from "@/components/finding-detail";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePagination } from "@/components/table-pagination";
import { api } from "@/lib/api";
import type { Finding, Severity, Task } from "@/lib/types";
import { taskLabel, taskMap } from "@/lib/task-label";
import { cn } from "@/lib/utils";

const SEVERITY_ORDER: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

function fmtTime(ts: string) {
  return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// extractTarget pulls the affected host/URL out of the finding text (summary +
// evidence) for the list — a display heuristic; the report's AI extraction is
// authoritative. Prefers a URL host, then a real-TLD domain, then an IP.
const TLD = "org|com|net|io|gov|edu|cn|hk|tw|co|info|biz|app|dev|xyz|me|jp|kr|uk|us|de|fr|ru|sg|au";
function extractTarget(f: Finding): string {
  const text = `${f.summary ?? ""} ${f.evidence ?? ""}`;
  const url = text.match(/https?:\/\/[^\s"'）)\]]+/i);
  if (url) {
    try {
      return new URL(url[0]).host;
    } catch {
      return url[0];
    }
  }
  const dom = text.match(new RegExp(String.raw`\b(?:[a-z0-9-]+\.)+(?:${TLD})\b(?::\d+)?`, "i"));
  if (dom) return dom[0];
  const ip = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/);
  if (ip) return ip[0];
  return "";
}

export default function FindingsPage() {
  const { t } = useTranslation();
  const [severity, setSeverity] = React.useState<"all" | Severity>("all");
  const [vulnclass, setVulnclass] = React.useState<string>("all");
  const [task, setTask] = React.useState<string>("all");
  const [sort, setSort] = React.useState<"severity" | "time">("severity");
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [findings, setFindings] = React.useState<Finding[]>([]);
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const reload = React.useCallback(() => {
    api
      .findings()
      .then(setFindings)
      .catch(() => {});
  }, []);
  React.useEffect(() => {
    reload();
    const iv = setInterval(reload, 5000);
    return () => clearInterval(iv);
  }, [reload]);
  React.useEffect(() => {
    api.tasks().then((r) => setTasks(r.tasks)).catch(() => {});
  }, []);

  const vulnclasses = React.useMemo(() => Array.from(new Set(findings.map((f) => f.vulnclass))).sort(), [findings]);

  // distinct tasks present in the loaded findings, for the task filter dropdown;
  // labels prefer the task's 名称/目标 (from the tasks list) then #id·描述.
  const tmap = React.useMemo(() => taskMap(tasks), [tasks]);
  const taskOptions = React.useMemo(() => {
    const descById = new Map<string, string>();
    for (const f of findings) if (f.task_id) descById.set(f.task_id, f.task_description || "");
    return Array.from(descById, ([id, description]) => ({ id, label: taskLabel(tmap.get(id) ?? { id, description }) }));
  }, [findings, tmap]);

  const counts = React.useMemo(() => {
    const c = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) if (f.severity in c) c[f.severity]++;
    const tasks = new Set(findings.map((f) => f.task_id)).size;
    return { ...c, total: findings.length, tasks };
  }, [findings]);

  const rows = React.useMemo(() => {
    let list = findings.slice();
    if (severity !== "all") list = list.filter((f) => f.severity === severity);
    if (vulnclass !== "all") list = list.filter((f) => f.vulnclass === vulnclass);
    if (task !== "all") list = list.filter((f) => f.task_id === task);
    list.sort((a, b) => {
      if (sort === "severity") {
        const d = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
        if (d !== 0) return d;
      }
      return new Date(b.ts).getTime() - new Date(a.ts).getTime();
    });
    return list;
  }, [findings, severity, vulnclass, task, sort]);

  React.useEffect(() => {
    setPage(1);
  }, [severity, vulnclass, task, sort]);

  const paginated = React.useMemo(() => rows.slice((page - 1) * pageSize, page * pageSize), [rows, page, pageSize]);

  const statCards: { label: string; value: number; tone?: string }[] = [
    { label: t("findings.stat.total"), value: counts.total },
    { label: t("status.severity.critical"), value: counts.critical, tone: "text-red-600" },
    { label: t("status.severity.high"), value: counts.high, tone: "text-red-500" },
    { label: t("status.severity.medium"), value: counts.medium, tone: "text-amber-500" },
    { label: t("status.severity.low"), value: counts.low, tone: "text-slate-500" },
    { label: t("findings.stat.tasks"), value: counts.tasks },
  ];

  return (
    <div className="flex flex-1 flex-col gap-4 md:gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("findings.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("findings.subtitle")}</p>
      </div>
      <div className="flex flex-1 flex-col gap-4 md:gap-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {statCards.map((s) => (
            <Card key={s.label} className="gap-1 py-4">
              <CardHeader className="px-4">
                <CardDescription>{s.label}</CardDescription>
                <CardTitle className={cn("text-2xl tabular-nums", s.tone)}>{s.value}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border p-0.5">
            {(["all", "critical", "high", "medium", "low"] as const).map((val) => (
              <button
                key={val}
                onClick={() => setSeverity(val)}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                  severity === val ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {val === "all" ? t("findings.filterAll") : t(`status.severity.${val}`)}
              </button>
            ))}
          </div>

          <Select value={vulnclass} onValueChange={setVulnclass}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue placeholder={t("findings.vulnclass")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("findings.allTypes")}</SelectItem>
              {vulnclasses.map((vc) => (
                <SelectItem key={vc} value={vc}>
                  {vc}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={task} onValueChange={setTask}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue placeholder={t("findings.colTask")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("findings.allTasks")}</SelectItem>
              {taskOptions.map((tk) => (
                <SelectItem key={tk.id} value={tk.id}>
                  {tk.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sort} onValueChange={(v) => setSort(v as "severity" | "time")}>
            <SelectTrigger size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="severity">{t("findings.sortSeverity")}</SelectItem>
              <SelectItem value="time">{t("findings.sortTime")}</SelectItem>
            </SelectContent>
          </Select>

          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {t("findings.total", { count: rows.length })}
          </span>
        </div>

        <Card className="py-0">
          <CardContent className="px-0">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead className="w-20">{t("findings.colSeverity")}</TableHead>
                  <TableHead>{t("findings.colName")}</TableHead>
                  <TableHead className="w-44">{t("findings.colTarget")}</TableHead>
                  <TableHead className="w-36 max-w-[9rem]">{t("findings.colTask")}</TableHead>
                  <TableHead className="w-28">{t("findings.colTime")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.map((f) => {
                  const open = expanded === f.id;
                  const target = f.enr_target || extractTarget(f);
                  const name = f.enr_name || f.vulnclass || t("findings.unnamed");
                  return (
                    <React.Fragment key={f.id}>
                      <TableRow className="cursor-pointer" onClick={() => setExpanded(open ? null : f.id)}>
                        <TableCell>
                          <ChevronRightIcon
                            className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")}
                          />
                        </TableCell>
                        <TableCell>
                          <StatusBadge domain="severity" value={f.severity} dot />
                        </TableCell>
                        <TableCell className="max-w-lg">
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="flex items-center gap-2">
                              <span className="truncate font-medium" title={f.vulnclass}>
                                {name}
                              </span>
                              {f.status && <StatusBadge domain="findingStatus" value={f.status} />}
                            </span>
                            <span className="text-muted-foreground line-clamp-1 text-xs" title={f.summary}>
                              {f.summary}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="w-44">
                          {target ? (
                            <code
                              className="block max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
                              title={target}
                            >
                              {target}
                            </code>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </TableCell>
                        <TableCell className="w-36 max-w-[9rem]">
                          {f.task_id ? (
                            <Link
                              href={`/function/tasks/detail?id=${f.task_id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
                              title={f.task_description}
                            >
                              <span className="truncate">{f.task_description}</span>
                              <ArrowUpRightIcon className="size-3 shrink-0" />
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">{fmtTime(f.ts)}</TableCell>
                      </TableRow>
                      {open && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={6} className="bg-muted/30 whitespace-normal">
                            <FindingDetail finding={f} onChanged={reload} />
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                      {t("findings.empty")}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={rows.length}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

