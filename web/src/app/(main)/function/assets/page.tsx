"use client";

import * as React from "react";
import {
  BuildingIcon,
  GlobeIcon,
  NetworkIcon,
  LayoutTemplateIcon,
  LinkIcon,
  SearchIcon,
  KeyRoundIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  RefreshCwIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";

import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { taskLabel } from "@/lib/task-label";
import type { Asset, Company, Task } from "@/lib/types";

// ── DSL autocomplete ──────────────────────────────────────────────────────────

const DSL_FIELDS: { name: string; desc: string; ops: { op: string; desc: string }[] }[] = [
  { name: "domain",       desc: "assets.dsl.field.domain",      ops: [{ op: "=",  desc: "assets.dsl.op.fuzzy" }, { op: "==", desc: "assets.dsl.op.exact" }, { op: "!=", desc: "assets.dsl.op.exclude" }] },
  { name: "ip",           desc: "assets.dsl.field.ip",          ops: [{ op: "=",  desc: "assets.dsl.op.fuzzy" }, { op: "==", desc: "assets.dsl.op.exact" }, { op: "!=", desc: "assets.dsl.op.exclude" }] },
  { name: "url",          desc: "assets.dsl.field.url",         ops: [{ op: "=",  desc: "assets.dsl.op.fuzzy" }, { op: "==", desc: "assets.dsl.op.exact" }, { op: "!=", desc: "assets.dsl.op.exclude" }] },
  { name: "root_domain",  desc: "assets.dsl.field.rootDomain",  ops: [{ op: "=",  desc: "assets.dsl.op.fuzzy" }, { op: "==", desc: "assets.dsl.op.exact" }, { op: "!=", desc: "assets.dsl.op.exclude" }] },
  { name: "page_title",   desc: "assets.dsl.field.pageTitle",   ops: [{ op: "=",  desc: "assets.dsl.op.fuzzy" }, { op: "==", desc: "assets.dsl.op.exact" }, { op: "!=", desc: "assets.dsl.op.exclude" }] },
  { name: "icp",          desc: "assets.dsl.field.icp",         ops: [{ op: "=",  desc: "assets.dsl.op.fuzzy" }, { op: "==", desc: "assets.dsl.op.exact" }, { op: "!=", desc: "assets.dsl.op.exclude" }] },
  { name: "service_name", desc: "assets.dsl.field.serviceName", ops: [{ op: "=",  desc: "assets.dsl.op.fuzzy" }, { op: "==", desc: "assets.dsl.op.exact" }, { op: "!=", desc: "assets.dsl.op.exclude" }] },
  { name: "app_name",     desc: "assets.dsl.field.appName",     ops: [{ op: "=",  desc: "assets.dsl.op.fuzzy" }, { op: "==", desc: "assets.dsl.op.exact" }, { op: "!=", desc: "assets.dsl.op.exclude" }] },
  { name: "method",       desc: "assets.dsl.field.method",      ops: [{ op: "==", desc: "assets.dsl.op.exact" }, { op: "!=", desc: "assets.dsl.op.exclude" }] },
  { name: "service_type", desc: "assets.dsl.field.serviceType", ops: [{ op: "==", desc: "assets.dsl.op.exact" }, { op: "!=", desc: "assets.dsl.op.exclude" }] },
  { name: "record_type",  desc: "assets.dsl.field.recordType",  ops: [{ op: "==", desc: "assets.dsl.op.exact" }, { op: "!=", desc: "assets.dsl.op.exclude" }] },
  { name: "technology",   desc: "assets.dsl.field.technology",  ops: [{ op: "=",  desc: "assets.dsl.op.fuzzy" }, { op: "==", desc: "assets.dsl.op.exact" }, { op: "!=", desc: "assets.dsl.op.exclude" }] },
  { name: "port",         desc: "assets.dsl.field.port",        ops: [{ op: "==", desc: "assets.dsl.op.eq" }, { op: "!=", desc: "assets.dsl.op.neq" }, { op: ">",  desc: "assets.dsl.op.gt" }, { op: ">=", desc: "assets.dsl.op.gte" }, { op: "<",  desc: "assets.dsl.op.lt" }, { op: "<=", desc: "assets.dsl.op.lte" }] },
  { name: "status_code",  desc: "assets.dsl.field.statusCode",  ops: [{ op: "==", desc: "assets.dsl.op.eq" }, { op: "!=", desc: "assets.dsl.op.neq" }, { op: ">",  desc: "assets.dsl.op.gt" }, { op: ">=", desc: "assets.dsl.op.gte" }, { op: "<",  desc: "assets.dsl.op.lt" }, { op: "<=", desc: "assets.dsl.op.lte" }] },
  { name: "company_id",   desc: "assets.dsl.field.companyId",   ops: [{ op: "==", desc: "assets.dsl.op.eq" }] },
  { name: "task_id",      desc: "assets.dsl.field.taskId",      ops: [{ op: "==", desc: "assets.dsl.op.eq" }] },
];

const LOGIC_OPS = [
  { label: "AND", desc: "assets.dsl.logic.and" },
  { label: "OR",  desc: "assets.dsl.logic.or" },
];

interface DslSuggestion {
  kind: "field" | "operator" | "logic";
  label: string;
  desc: string;
  replaceStart: number;
  replaceEnd: number;
  insertText: string;
}

function getDslSuggestions(text: string, cursor: number): DslSuggestion[] {
  const before = text.slice(0, cursor);
  // Current token: non-whitespace, non-paren run ending at cursor
  const tokenMatch = before.match(/([^\s()]*$)/);
  const currentToken = tokenMatch?.[1] ?? "";
  const tokenStart = cursor - currentToken.length;

  // Token already contains field+operator → typing a value, no suggestions
  if (/^[a-z_]+(==|!=|>=|<=|=|>|<)/.test(currentToken)) return [];

  // Complete known field name → suggest operators for that field
  const exactField = DSL_FIELDS.find((f) => f.name === currentToken.toLowerCase());
  if (exactField) {
    return exactField.ops.map(({ op, desc }) => ({
      kind: "operator",
      label: `${exactField.name}${op}`,
      desc,
      replaceStart: tokenStart,
      replaceEnd: cursor,
      insertText: `${exactField.name}${op}`,
    }));
  }

  // Everything before the current token (trimmed)
  const beforeToken = before.slice(0, tokenStart).trimEnd();
  const afterExpression =
    beforeToken.length > 0 &&
    !/\b(AND|OR)\s*$/i.test(beforeToken) &&
    !beforeToken.endsWith("(");

  // Current token is a prefix of AND/OR and follows a complete expression
  if (/^(a|an|and|o|or)$/i.test(currentToken) && afterExpression) {
    return LOGIC_OPS.filter((l) => l.label.startsWith(currentToken.toUpperCase())).map(
      ({ label, desc }) => ({
        kind: "logic",
        label,
        desc,
        replaceStart: tokenStart,
        replaceEnd: cursor,
        insertText: `${label} `,
      }),
    );
  }

  // No current token, after a complete expression → suggest AND/OR
  if (!currentToken && afterExpression) {
    return LOGIC_OPS.map(({ label, desc }) => ({
      kind: "logic",
      label,
      desc,
      replaceStart: cursor,
      replaceEnd: cursor,
      insertText: `${label} `,
    }));
  }

  // Default: suggest fields filtered by prefix
  const prefix = currentToken.toLowerCase();
  return DSL_FIELDS.filter((f) => f.name.startsWith(prefix)).map((f) => ({
    kind: "field",
    label: f.name,
    desc: f.desc,
    replaceStart: tokenStart,
    replaceEnd: cursor,
    insertText: f.name,
  }));
}

function applyDslSuggestion(
  text: string,
  s: DslSuggestion,
): { text: string; cursor: number } {
  const newText = text.slice(0, s.replaceStart) + s.insertText + text.slice(s.replaceEnd);
  return { text: newText, cursor: s.replaceStart + s.insertText.length };
}

const KIND_STYLE: Record<string, string> = {
  field:    "text-blue-500 dark:text-blue-400",
  operator: "text-amber-500 dark:text-amber-400",
  logic:    "text-emerald-500 dark:text-emerald-400",
};

const METHOD_COLOR: Record<string, string> = {
  GET: "bg-emerald-100 text-emerald-700",
  POST: "bg-blue-100 text-blue-700",
  PUT: "bg-amber-100 text-amber-700",
  PATCH: "bg-orange-100 text-orange-700",
  DELETE: "bg-red-100 text-red-700",
  HEAD: "bg-purple-100 text-purple-700",
  OPTIONS: "bg-slate-100 text-slate-600",
};

function MethodBadge({ method }: { method: string }) {
  const m = method.toUpperCase();
  return (
    <span className={cn("inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none", METHOD_COLOR[m] ?? "bg-muted text-muted-foreground")}>
      {m || "—"}
    </span>
  );
}

function statusTone(code: number) {
  if (code >= 500) return "text-red-500";
  if (code >= 400) return "text-amber-500";
  if (code >= 300) return "text-blue-500";
  if (code >= 200) return "text-emerald-500";
  return "text-muted-foreground";
}

const PAGE_SIZES = [25, 50, 100, 200];

const TABS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: "company",     label: "assets.tabs.company",    icon: BuildingIcon },
  { key: "root_domain", label: "assets.tabs.rootDomain", icon: GlobeIcon },
  { key: "ip",          label: "assets.tabs.ip",         icon: NetworkIcon },
  { key: "subdomain",   label: "assets.tabs.subdomain",  icon: GlobeIcon },
  { key: "service",     label: "assets.tabs.service",    icon: LayoutTemplateIcon },
  { key: "endpoint",    label: "assets.tabs.endpoint",   icon: LinkIcon },
];

export default function AssetsPage() {
  const { t: tr } = useTranslation();
  const [rows, setRows] = React.useState<Asset[]>([]);
  const [total, setTotal] = React.useState(0);
  const [companies, setCompanies] = React.useState<Company[]>([]);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const [tab, setTab] = React.useState("company");
  const [query, setQuery] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [page, setPage] = React.useState(0);
  const [size, setSize] = React.useState(50);
  const [dslError, setDslError] = React.useState("");
  const [refreshKey, setRefreshKey] = React.useState(0);

  // Per-task filter. Assets carry task_ids[]; we compose `task_id==N` into the
  // server-side DSL so filtering + pagination totals stay correct across all pages
  // (not just the loaded page). "all" ⇒ no task clause.
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [taskFilter, setTaskFilter] = React.useState("all");
  // Per-type badge counts scoped to the selected task (null ⇒ use global counts).
  const [taskCounts, setTaskCounts] = React.useState<Record<string, number> | null>(null);

  // asset selection & delete
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [deleteIds, setDeleteIds] = React.useState<number[]>([]);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  // company delete
  const [companyDeleteTarget, setCompanyDeleteTarget] = React.useState<Company | null>(null);
  const [companyDeleteAssets, setCompanyDeleteAssets] = React.useState(false);
  const [companyDeleting, setCompanyDeleting] = React.useState(false);

  // Companies + per-type counts (tab badges) — loaded on demand, no background polling.
  const loadMeta = React.useCallback(() => {
    api.assetCounts().then(setCounts).catch(() => {});
    api.tasks().then((r) => setTasks(r.tasks)).catch(() => {});
  }, []);

  // Companies reload scoped to the selected task (企业 tab respects the task filter:
  // only companies owning assets in the task are shown; "all" ⇒ global).
  React.useEffect(() => {
    api.companies(taskFilter === "all" ? 0 : Number(taskFilter)).then(setCompanies).catch(() => {});
  }, [taskFilter, refreshKey]);

  // Manual refresh: reload counts/companies and re-fetch the current page.
  const refresh = React.useCallback(() => {
    loadMeta();
    setRefreshKey((k) => k + 1);
    setSelected(new Set());
  }, [loadMeta]);

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (ids: number[]) => {
    setSelected((prev) => {
      const allSelected = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const openDelete = (ids: number[]) => {
    setDeleteIds(ids);
    setDeleteOpen(true);
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      const res = await api.deleteAssets(deleteIds);
      toast.success(tr("assets.deletedAssets", { count: res.deleted }));
      setSelected(new Set());
      refresh();
    } catch (e) {
      toast.error(tr("assets.deleteFailed", { msg: String((e as Error)?.message ?? e) }));
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  const confirmDeleteCompany = async () => {
    if (!companyDeleteTarget) return;
    setCompanyDeleting(true);
    try {
      const res = await api.deleteCompany(companyDeleteTarget.id, companyDeleteAssets);
      const msg = companyDeleteAssets && res.assets_deleted > 0
        ? tr("assets.companyDeletedWithAssets", { count: res.assets_deleted })
        : tr("assets.companyDeleted");
      toast.success(msg);
      refresh();
    } catch (e) {
      toast.error(tr("assets.deleteFailed", { msg: String((e as Error)?.message ?? e) }));
    } finally {
      setCompanyDeleting(false);
      setCompanyDeleteTarget(null);
      setCompanyDeleteAssets(false);
    }
  };

  React.useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  // Reset query + page + selection when switching tabs
  React.useEffect(() => {
    setQuery("");
    setDslError("");
    setSelected(new Set());
  }, [tab]);

  React.useEffect(() => setPage(0), [tab, size, query, taskFilter]);

  const dslMode = query.trim() !== "";

  // Compose the task filter into the server-side DSL. `task_id==N` maps to
  // `N = ANY(task_ids)` in Postgres (see db/asset_dsl.go), so the filter is applied
  // server-side — the returned page AND the total both reflect the selected task
  // across every page, not just the loaded rows. Wrap the user's query in parens
  // before AND-ing the task clause (AND binds tighter than OR, so a bare "a OR b"
  // would otherwise mis-associate).
  const userDsl = query.trim();
  const taskClause = taskFilter !== "all" ? `task_id==${taskFilter}` : "";
  const effectiveDsl = taskClause
    ? userDsl
      ? `(${userDsl}) AND ${taskClause}`
      : taskClause
    : userDsl;

  // Server-side paginated page loader for the active data tab (company tab excluded).
  React.useEffect(() => {
    if (tab === "company") return;
    const dsl = effectiveDsl;
    setLoading(true);
    const offset = page * size;
    const run = async () => {
      try {
        const r = dsl
          ? await api.searchAssets(dsl, tab, size, offset)
          : await api.assets(tab, size, offset);
        setRows(r.assets);
        setTotal(r.total);
        setDslError("");
      } catch (e) {
        setDslError(String((e as Error)?.message ?? e));
        setRows([]);
        setTotal(0);
      } finally {
        setLoading(false);
        setLoaded(true);
      }
    };
    // Debounce only while the user is typing a query; task-filter changes apply now.
    const tid = setTimeout(run, userDsl ? 400 : 0);
    return () => clearTimeout(tid);
  }, [tab, page, size, effectiveDsl, userDsl, refreshKey]);

  // When a task is selected, recompute per-type badge counts scoped to that task.
  // The /assets/counts endpoint is global-only, so we count each data type via the
  // DSL (limit=1, read total). "all" ⇒ clear and fall back to the global counts.
  React.useEffect(() => {
    if (taskFilter === "all") {
      setTaskCounts(null);
      return;
    }
    let cancelled = false;
    const clause = `task_id==${taskFilter}`;
    const types = TABS.filter((t) => t.key !== "company").map((t) => t.key);
    Promise.all(
      types.map((type) =>
        api
          .searchAssets(clause, type, 1, 0)
          .then((r) => [type, r.total] as const)
          .catch(() => [type, 0] as const),
      ),
    ).then((entries) => {
      if (!cancelled) setTaskCounts(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [taskFilter, refreshKey]);

  const companyById = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const c of companies) m.set(c.id, c.name);
    return m;
  }, [companies]);

  const companyName = (id?: number) => (id ? (companyById.get(id) ?? "") : "");

  // When a task is selected, badges + header total reflect that task's assets.
  const effectiveCounts = taskCounts ?? counts;
  const tabCounts: Record<string, number> = { ...effectiveCounts, company: companies.length };
  const totalAssets = Object.values(effectiveCounts).reduce((a, b) => a + b, 0);

  // rows are already the current server-side page.
  const tabData = (_type: string): Asset[] => rows;
  const slice = <T,>(list: T[]) => list;

  const searchBox = (
    <TabSearchBox
      query={query}
      onChange={setQuery}
      loading={loading}
      error={dslError}
      count={dslMode ? total : undefined}
    />
  );

  return (
    <div className="flex h-[calc(100vh-6rem)] min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{tr("assets.title")}</h1>
        </div>
        <div className="flex items-center gap-3">
          <Select value={taskFilter} onValueChange={setTaskFilter}>
            <SelectTrigger size="sm" className="h-8 w-52" aria-label={tr("assets.filterTask")}>
              <SelectValue placeholder={tr("assets.allTasks")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr("assets.allTasks")}</SelectItem>
              {tasks.map((t) => (
                <SelectItem key={t.id} value={t.id}>{taskLabel(t)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground tabular-nums">
            {tr("assets.totalAssets", { count: totalAssets })}
          </span>
          {selected.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => openDelete(Array.from(selected) as number[])}
            >
              <Trash2Icon className="size-3.5" /> {tr("assets.deleteSelected", { count: selected.size })}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} /> {tr("assets.refresh")}
          </Button>
          <CompanyDialog onSaved={refresh} />
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="overflow-x-auto overflow-y-hidden">
          <TabsList variant="default">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                <t.icon className="size-3.5" />
                {tr(t.label)}
                <span className="ml-1 tabular-nums text-muted-foreground">{tabCounts[t.key]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {/* 企业 */}
        <TabsContent value="company" className="mt-0 flex min-h-0 flex-1 flex-col">
          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden py-0">
            <div className="min-h-0 flex-1 overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead>{tr("assets.company.thName")}</TableHead>
                    <TableHead className="w-24 text-right">{tr("assets.company.thAssetCount")}</TableHead>
                    <TableHead>{tr("assets.company.thScope")}</TableHead>
                    <TableHead className="w-36 text-right">{tr("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {companies.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <CompanyAvatar name={c.name} logo={c.logo} />
                          <span className="font-medium">{c.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{c.asset_count}</TableCell>
                      <TableCell>
                        {c.scope?.length ? (
                          <div className="flex flex-wrap gap-1">
                            {c.scope.map((s, i) => (
                              <Badge key={i} variant="secondary" className="font-mono text-[11px]">{s.raw}</Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">{tr("assets.company.noScope")}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <EditScopeDialog company={c} onSaved={refresh} />
                          <AppendScopeDialog company={c} onSaved={refresh} />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-destructive"
                            onClick={() => { setCompanyDeleteTarget(c); setCompanyDeleteAssets(false); }}
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {companies.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                        {tr("assets.company.empty")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        </TabsContent>

        {/* 根域名 */}
        <TabsContent value="root_domain" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
          {searchBox}
          <AssetCard
            cols={["", tr("assets.cols.domain"), tr("assets.cols.icpFiling"), tr("assets.cols.company"), ""]}
            loaded={loaded}
            total={total}
            page={page}
            size={size}
            onSize={setSize}
            onPage={setPage}
            rows={rows}
            selected={selected}
            onToggleAll={(ids) => toggleSelectAll(ids)}
          >
            {slice(tabData("root_domain")).map((a) => (
              <TableRow key={a.id} className={selected.has(a.id) ? "bg-muted/40" : undefined}>
                <TableCell className="w-8 pr-0">
                  <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleSelect(a.id)} />
                </TableCell>
                <TableCell className="font-mono text-xs font-medium">{a.domain}</TableCell>
                <TableCell className="text-xs">{a.icp || "—"}</TableCell>
                <TableCell className="text-xs">
                  {companyName(a.company_id) || <span className="text-muted-foreground">{tr("assets.unattributed")}</span>}
                </TableCell>
                <TableCell className="w-8 pl-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => openDelete([a.id])}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </AssetCard>
        </TabsContent>

        {/* IP */}
        <TabsContent value="ip" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
          {searchBox}
          <AssetCard
            cols={["", "IP", tr("assets.cols.cSegment"), tr("assets.cols.boundDomains"), tr("assets.cols.openPorts"), ""]}
            loaded={loaded}
            total={total}
            page={page}
            size={size}
            onSize={setSize}
            onPage={setPage}
            rows={rows}
            selected={selected}
            onToggleAll={(ids) => toggleSelectAll(ids)}
          >
            {slice(tabData("ip")).map((a) => (
              <TableRow key={a.id} className={selected.has(a.id) ? "bg-muted/40" : undefined}>
                <TableCell className="w-8 pr-0">
                  <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleSelect(a.id)} />
                </TableCell>
                <TableCell className="font-mono text-xs font-medium">{a.ip}</TableCell>
                <TableCell className="font-mono text-xs">{a.c_segment || "—"}</TableCell>
                <TableCell><Chips items={a.bound_domains ?? []} mono /></TableCell>
                <TableCell>
                  <Chips
                    items={(a.open_ports ?? []).map((p) =>
                      p.service ? `${p.port}/${p.service}` : String(p.port),
                    )}
                    mono
                  />
                </TableCell>
                <TableCell className="w-8 pl-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => openDelete([a.id])}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </AssetCard>
        </TabsContent>

        {/* 子域名 */}
        <TabsContent value="subdomain" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
          {searchBox}
          <AssetCard
            cols={["", tr("assets.cols.domain"), tr("assets.cols.rootDomain"), tr("assets.cols.recordType"), tr("assets.cols.recordValue"), ""]}
            loaded={loaded}
            total={total}
            page={page}
            size={size}
            onSize={setSize}
            onPage={setPage}
            rows={rows}
            selected={selected}
            onToggleAll={(ids) => toggleSelectAll(ids)}
          >
            {slice(tabData("subdomain")).map((a) => (
              <TableRow key={a.id} className={selected.has(a.id) ? "bg-muted/40" : undefined}>
                <TableCell className="w-8 pr-0">
                  <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleSelect(a.id)} />
                </TableCell>
                <TableCell className="font-mono text-xs font-medium">{a.domain}</TableCell>
                <TableCell className="font-mono text-xs">{a.root_domain || "—"}</TableCell>
                <TableCell className="text-xs">{a.record_type || "—"}</TableCell>
                <TableCell className="max-w-xs truncate font-mono text-xs">{(Array.isArray(a.record_value) ? a.record_value.join(", ") : a.record_value) || "—"}</TableCell>
                <TableCell className="w-8 pl-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => openDelete([a.id])}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </AssetCard>
        </TabsContent>

        {/* 服务 */}
        <TabsContent value="service" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
          {searchBox}
          <AssetCard
            cols={["", tr("assets.cols.service"), tr("assets.cols.domain"), "IP", tr("assets.cols.port"), tr("assets.cols.statusCode"), tr("assets.cols.title"), tr("assets.cols.fingerprint"), tr("assets.cols.auth"), ""]}
            loaded={loaded}
            total={total}
            page={page}
            size={size}
            onSize={setSize}
            onPage={setPage}
            rows={rows}
            selected={selected}
            onToggleAll={(ids) => toggleSelectAll(ids)}
          >
            {slice(tabData("service")).map((a) => {
              const isHttp = a.service_type === "http";
              const svc = a.service_name || (isHttp ? "http" : "") || a.service_type || "";
              let domainCell: React.ReactNode = "—";
              if (isHttp && a.url) {
                domainCell = (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {a.domain || a.url}
                  </a>
                );
              } else if (a.domain) {
                domainCell = a.domain;
              }
              return (
                <TableRow key={a.id} className={selected.has(a.id) ? "bg-muted/40" : undefined}>
                  <TableCell className="w-8 pr-0">
                    <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleSelect(a.id)} />
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant={isHttp ? "default" : "secondary"} className="font-mono text-[10px]">
                      {svc || "—"}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[14rem] truncate font-mono text-xs" title={a.domain || a.url}>
                    {domainCell}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{a.ip || "—"}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{a.port || "—"}</TableCell>
                  <TableCell>
                    {a.status_code != null ? (
                      <span className={cn("font-mono text-xs font-semibold tabular-nums", statusTone(a.status_code))}>
                        {a.status_code}
                      </span>
                    ) : "—"}
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate text-xs" title={a.page_title}>{a.page_title || "—"}</TableCell>
                  <TableCell><Chips items={a.technologies ?? []} /></TableCell>
                  <TableCell>
                    {(a.auth ?? []).length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      (a.auth ?? []).map((authItem, i) => {
                        const item = authItem as Record<string, string>;
                        const label = item.type || item.username || tr("assets.cols.auth");
                        return (
                          <span key={i} className="inline-flex items-center gap-1 text-[11px]">
                            <KeyRoundIcon className="size-3 text-muted-foreground" />
                            <span className="font-mono">{label}</span>
                          </span>
                        );
                      })
                    )}
                  </TableCell>
                  <TableCell className="w-8 pl-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => openDelete([a.id])}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </AssetCard>
        </TabsContent>

        {/* 接口 */}
        <TabsContent value="endpoint" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
          {searchBox}
          <AssetCard
            cols={["", tr("assets.cols.method"), tr("assets.cols.fullUrl"), tr("assets.cols.params"), ""]}
            loaded={loaded}
            total={total}
            page={page}
            size={size}
            onSize={setSize}
            onPage={setPage}
            rows={rows}
            selected={selected}
            onToggleAll={(ids) => toggleSelectAll(ids)}
          >
            {slice(tabData("endpoint")).map((a) => (
              <TableRow key={a.id} className={selected.has(a.id) ? "bg-muted/40" : undefined}>
                <TableCell className="w-8 pr-0">
                  <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleSelect(a.id)} />
                </TableCell>
                <TableCell className="w-16"><MethodBadge method={a.method || ""} /></TableCell>
                <TableCell className="max-w-sm truncate font-mono text-xs" title={a.url}>{a.url || "—"}</TableCell>
                <TableCell>
                  <Chips
                    items={(a.params ?? []).map((p) => {
                      const item = p as Record<string, string>;
                      return item.name ? `${item.name}(${item.location || "?"})` : "?";
                    })}
                    mono
                  />
                </TableCell>
                <TableCell className="w-8 pl-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => openDelete([a.id])}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </AssetCard>
        </TabsContent>
      </Tabs>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr("assets.confirmDelete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr("assets.deleteDialog.desc", { count: deleteIds.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{tr("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirmDelete(); }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? tr("assets.deleting") : tr("assets.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!companyDeleteTarget} onOpenChange={(o) => { if (!o) { setCompanyDeleteTarget(null); setCompanyDeleteAssets(false); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr("assets.companyDelete.title", { name: companyDeleteTarget?.name })}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{tr("assets.companyDelete.warning")}</p>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-md border p-3 hover:bg-muted/50">
                  <Checkbox
                    id="delete-assets-opt"
                    checked={companyDeleteAssets}
                    onCheckedChange={(v) => setCompanyDeleteAssets(!!v)}
                  />
                  <span className="text-sm leading-snug">
                    {tr("assets.companyDelete.alsoDeleteAssets")}
                    <span className="block text-xs text-muted-foreground">
                      {tr("assets.companyDelete.alsoDeleteHint")}
                    </span>
                  </span>
                </label>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={companyDeleting}>{tr("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirmDeleteCompany(); }}
              disabled={companyDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {companyDeleting ? tr("assets.deleting") : tr("assets.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TabSearchBox({
  query,
  onChange,
  loading,
  error,
  count,
}: {
  query: string;
  onChange: (v: string) => void;
  loading: boolean;
  error: string;
  count?: number;
}) {
  const { t } = useTranslation();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [suggestions, setSuggestions] = React.useState<DslSuggestion[]>([]);
  const [selIdx, setSelIdx] = React.useState(0);
  const [open, setOpen] = React.useState(false);

  const refresh = React.useCallback((val: string, pos: number) => {
    const suggs = getDslSuggestions(val, pos);
    setSuggestions(suggs);
    setSelIdx(0);
    setOpen(suggs.length > 0);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onChange(val);
    refresh(val, e.target.selectionStart ?? val.length);
  };

  const apply = React.useCallback(
    (s: DslSuggestion) => {
      const cursor = inputRef.current?.selectionStart ?? query.length;
      // use cursor for logic-kind (insert at cursor), replaceStart/End for others
      const adjusted: DslSuggestion =
        s.kind === "logic" && !query.slice(s.replaceStart, s.replaceEnd)
          ? { ...s, replaceStart: cursor, replaceEnd: cursor }
          : s;
      const { text: newText, cursor: newCursor } = applyDslSuggestion(query, adjusted);
      onChange(newText);
      requestAnimationFrame(() => {
        if (!inputRef.current) return;
        inputRef.current.setSelectionRange(newCursor, newCursor);
        inputRef.current.focus();
        refresh(newText, newCursor);
      });
    },
    [query, onChange, refresh],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Tab" || e.key === "Enter") {
      const s = suggestions[selIdx];
      if (s) { e.preventDefault(); apply(s); }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const cursorPos = () =>
    inputRef.current?.selectionStart ?? query.length;

  return (
    <div className="flex flex-col gap-1">
      <div className="relative max-w-lg">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          placeholder={t("assets.search.placeholder")}
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => refresh(query, cursorPos())}
          onClick={() => refresh(query, cursorPos())}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          className="h-8 pl-8 font-mono text-xs"
        />
        {open && suggestions.length > 0 && (
          <div className="absolute top-full left-0 z-50 mt-1 w-max min-w-full max-w-sm rounded-md border bg-popover py-1 shadow-md">
            {suggestions.map((s, i) => (
              <div
                key={i}
                className={cn(
                  "flex cursor-pointer items-center gap-3 px-3 py-1.5",
                  i === selIdx ? "bg-accent" : "hover:bg-accent/50",
                )}
                onMouseEnter={() => setSelIdx(i)}
                onMouseDown={(e) => { e.preventDefault(); apply(s); }}
              >
                <span className={cn("shrink-0 font-mono text-xs font-semibold", KIND_STYLE[s.kind])}>
                  {s.label}
                </span>
                <span className="text-xs text-muted-foreground">{t(s.desc)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {query.trim() && !open && (
        <p className="pl-1 text-[11px] text-muted-foreground">
          {loading
            ? t("assets.search.searching")
            : error
            ? <span className="text-destructive">{error}</span>
            : t("assets.search.found", { count: count ?? 0 })}
        </p>
      )}
    </div>
  );
}

function AssetCard({
  cols,
  loaded,
  total,
  page,
  size,
  onSize,
  onPage,
  rows: dataRows,
  selected,
  onToggleAll,
  children,
}: {
  cols: string[];
  loaded: boolean;
  total: number;
  page: number;
  size: number;
  onSize: React.Dispatch<React.SetStateAction<number>>;
  onPage: React.Dispatch<React.SetStateAction<number>>;
  rows?: Asset[];
  selected?: Set<number>;
  onToggleAll?: (ids: number[]) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const childRows = React.Children.toArray(children);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const start = total === 0 ? 0 : page * size + 1;
  const end = page * size + childRows.length;

  const pageIds = dataRows?.map((r) => r.id) ?? [];
  const allSelected = pageIds.length > 0 && selected != null && pageIds.every((id) => selected.has(id));
  const someSelected = selected != null && pageIds.some((id) => selected.has(id));

  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden py-0">
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin scrollbar-track-transparent">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              {cols.map((c, i) =>
                c === "" && i === 0 && onToggleAll ? (
                  <TableHead key={i} className="w-8 pr-0">
                    <Checkbox
                      checked={allSelected ? true : someSelected ? "indeterminate" : false}
                      onCheckedChange={() => onToggleAll(pageIds)}
                    />
                  </TableHead>
                ) : (
                  <TableHead key={c + i}>{c}</TableHead>
                )
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {childRows.length > 0 ? childRows : (
              <TableRow>
                <TableCell colSpan={cols.length} className="py-12 text-center text-sm text-muted-foreground">
                  {loaded ? t("assets.noData") : t("common.loading")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {total > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
          <Select value={String(size)} onValueChange={(v) => onSize(Number(v))}>
            <SelectTrigger size="sm" className="h-7 w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{t("assets.perPage", { count: n })}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="tabular-nums">{start}–{end} / {total}</span>
          {pageCount > 1 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" className="size-7" disabled={page <= 0} onClick={() => onPage((p) => Math.max(0, p - 1))}>
                <ChevronLeftIcon />
              </Button>
              <span className="tabular-nums">{page + 1} / {pageCount}</span>
              <Button variant="outline" size="icon" className="size-7" disabled={page + 1 >= pageCount} onClick={() => onPage((p) => Math.min(pageCount - 1, p + 1))}>
                <ChevronRightIcon />
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Chips({ items, mono }: { items: string[]; mono?: boolean }) {
  const clean = items.filter(Boolean);
  if (clean.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {clean.map((s, i) => (
        <Badge key={i} variant="outline" className={cn("text-[10px]", mono && "font-mono")}>{s}</Badge>
      ))}
    </div>
  );
}

function CompanyAvatar({ name, logo }: { name: string; logo?: string }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <Avatar className="size-7 shrink-0">
      {logo ? <AvatarImage src={logo} alt={name} /> : null}
      <AvatarFallback className="text-xs">{initial}</AvatarFallback>
    </Avatar>
  );
}

// 新增企业弹窗
function CompanyDialog({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [logo, setLogo] = React.useState("");
  const [scope, setScope] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setLogo("");
    setScope("");
  }, [open]);

  const submit = async () => {
    if (!name.trim()) { toast.error(t("assets.companyDialog.nameRequired")); return; }
    setBusy(true);
    try {
      const res = await api.createCompany(name.trim(), logo.trim(), scope);
      const added = res.scope_added ?? 0;
      const invalid = res.scope_invalid ?? 0;
      if (invalid > 0) toast.warning(t("assets.companyDialog.createdWithInvalid", { added, invalid }));
      else toast.success(t("assets.companyDialog.created", { added }));
      setOpen(false);
      onSaved();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/:\s*409$/.test(msg)) toast.error(t("assets.companyDialog.exists"));
      else toast.error(t("assets.saveFailed", { msg }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><BuildingIcon className="size-3.5" /> {t("assets.companyDialog.title")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("assets.companyDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("assets.companyDialog.desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="cn-name">{t("assets.companyDialog.nameLabel")}</Label>
            <Input id="cn-name" placeholder={t("assets.companyDialog.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cn-logo">{t("assets.companyDialog.logoLabel")}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="cn-logo"
                placeholder={t("assets.companyDialog.logoPlaceholder")}
                value={logo}
                onChange={(e) => setLogo(e.target.value)}
              />
              <CompanyAvatar name={name || "?"} logo={logo.trim() || undefined} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cn-scope">{t("assets.companyDialog.scopeLabel")}</Label>
            <Textarea
              id="cn-scope"
              rows={5}
              className="font-mono text-xs"
              placeholder={"example.com\n203.0.113.10\n198.51.100.0/24"}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t("common.cancel")}</Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>{busy ? t("common.saving") : t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 编辑（覆盖）资产范围弹窗
function EditScopeDialog({ company, onSaved }: { company: Company; onSaved: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [scope, setScope] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setScope(company.scope?.length ? company.scope.map((s) => s.raw).join("\n") : "");
    setReason("");
  }, [open, company]);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.updateCompanyScope(company.id, scope, reason);
      const errCount = res.invalid ?? 0;
      if (errCount > 0) toast.warning(t("assets.savedWithInvalid", { count: errCount }));
      else toast.success(t("assets.editScope.updated", { count: res.added }));
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(t("assets.saveFailed", { msg: String((e as Error)?.message ?? e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7">{t("common.edit")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("assets.editScope.title", { name: company.name })}</DialogTitle>
          <DialogDescription>
            {t("assets.editScope.desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="es-scope">{t("assets.companyDialog.scopeLabel")}</Label>
            <Textarea
              id="es-scope"
              rows={6}
              className="font-mono text-xs"
              placeholder={"example.com\n203.0.113.10\n198.51.100.0/24"}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="es-reason">{t("assets.scopeReasonLabel")}</Label>
            <Input id="es-reason" placeholder={t("assets.scopeReasonPlaceholder")} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t("common.cancel")}</Button>
          <Button onClick={submit} disabled={busy}>{busy ? t("common.saving") : t("assets.editScope.overwriteSave")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 追加资产范围弹窗
function AppendScopeDialog({ company, onSaved }: { company: Company; onSaved: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [scope, setScope] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setScope("");
    setReason("");
  }, [open]);

  const submit = async () => {
    if (!scope.trim()) { toast.error(t("assets.appendScope.scopeRequired")); return; }
    setBusy(true);
    try {
      const res = await api.addCompanyScope(company.id, scope, reason);
      const errCount = res.invalid ?? 0;
      if (errCount > 0) toast.warning(t("assets.savedWithInvalid", { count: errCount }));
      else toast.success(t("assets.appendScope.appended", { count: res.added }));
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(t("assets.saveFailed", { msg: String((e as Error)?.message ?? e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7">{t("assets.appendScope.button")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("assets.appendScope.title", { name: company.name })}</DialogTitle>
          <DialogDescription>
            {t("assets.appendScope.desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="as-scope">{t("assets.appendScope.scopeLabel")}</Label>
            <Textarea
              id="as-scope"
              rows={5}
              className="font-mono text-xs"
              placeholder={"example.com\n203.0.113.10\n198.51.100.0/24"}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="as-reason">{t("assets.scopeReasonLabel")}</Label>
            <Input id="as-reason" placeholder={t("assets.scopeReasonPlaceholder")} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t("common.cancel")}</Button>
          <Button onClick={submit} disabled={busy || !scope.trim()}>{busy ? t("common.saving") : t("assets.appendScope.button")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
