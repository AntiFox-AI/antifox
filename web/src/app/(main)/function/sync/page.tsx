"use client";

import * as React from "react";

import { AlertCircleIcon, CheckCircle2Icon, DownloadIcon, PlugZapIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { SSProject, SSTask } from "@/lib/types";

type SSStatus = {
  exists: boolean;
  configured: boolean;
  enabled: boolean;
  reachable: boolean;
  url?: string;
  tools: string[];
};

type Dimension = "project" | "task";

const ASSET_TYPES: { key: string; label: string }[] = [
  { key: "subdomain", label: "sync.assetType.subdomain" },
  { key: "service", label: "sync.assetType.service" },
  { key: "app", label: "sync.assetType.app" },
];

export default function AssetSyncPage() {
  const { t } = useTranslation();
  return (
    <div className="p-4 md:p-6">
      <div className="mb-4">
        <h1 className="font-semibold text-xl">{t("sync.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("sync.subtitle")}</p>
      </div>
      <Tabs defaultValue="scopesentry">
        <TabsList>
          <TabsTrigger value="scopesentry">ScopeSentry</TabsTrigger>
        </TabsList>
        <TabsContent value="scopesentry" className="mt-4">
          <ScopeSentryPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ScopeSentryPanel() {
  const { t } = useTranslation();
  const [status, setStatus] = React.useState<SSStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = React.useState(true);

  const loadStatus = React.useCallback(() => {
    setLoadingStatus(true);
    api
      .ssStatus()
      .then(setStatus)
      .catch((e) => toast.error(t("sync.statusLoadFailed", { msg: e.message })))
      .finally(() => setLoadingStatus(false));
  }, []);

  React.useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const ready = !!status && status.exists && status.configured && status.enabled;

  return (
    <div className="space-y-4">
      <DataSourceCard status={status} loading={loadingStatus} onChanged={loadStatus} />
      {ready ? (
        <SyncWorkbench />
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            {t("sync.readyHint")}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── 数据源状态卡 ─────────────────────────────────────────────────────────────

function DataSourceCard({
  status,
  loading,
  onChanged,
}: {
  status: SSStatus | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (status?.url) setUrl(status.url);
  }, [status?.url]);

  const create = async () => {
    setBusy(true);
    try {
      await api.ssDatasource({});
      toast.success(t("sync.dataSource.created"));
      onChanged();
    } catch (e) {
      toast.error(t("sync.createFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!url.trim()) return toast.error(t("sync.dataSource.urlRequired"));
    setBusy(true);
    try {
      const r = await api.ssDatasource({ url: url.trim(), api_key: apiKey.trim() });
      toast.success(r.enabled ? t("sync.dataSource.savedEnabled") : t("sync.dataSource.savedNotEnabled"));
      setApiKey("");
      onChanged();
    } catch (e) {
      toast.error(t("sync.saveFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <PlugZapIcon className="size-4" /> {t("sync.dataSource.title")}
          <StatusBadge status={status} loading={loading} />
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={onChanged} disabled={loading}>
          <RefreshCwIcon className={loading ? "size-4 animate-spin" : "size-4"} /> {t("sync.refresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!status?.exists ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-muted-foreground text-sm">
              {t("sync.dataSource.notCreated")}
            </p>
            <Button onClick={create} disabled={busy}>
              {t("sync.dataSource.createButton")}
            </Button>
          </div>
        ) : (
          <>
            {!status.configured && (
              <p className="text-amber-600 text-sm dark:text-amber-500">
                {t("sync.dataSource.notConfigured")}
              </p>
            )}
            {status.configured && !status.enabled && (
              <p className="text-amber-600 text-sm dark:text-amber-500">{t("sync.dataSource.notEnabled")}</p>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("sync.dataSource.urlLabel")}</Label>
                <Input placeholder={t("sync.dataSource.urlPlaceholder")} value={url} onChange={(e) => setUrl(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>{t("sync.dataSource.apiKeyLabel")}</Label>
                <Input
                  type="password"
                  placeholder="ssk_..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={save} disabled={busy}>
                {t("sync.dataSource.saveButton")}
              </Button>
              {status.enabled && status.tools.length > 0 && (
                <span className="text-muted-foreground text-xs">{t("sync.dataSource.toolsFound", { count: status.tools.length })}</span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status, loading }: { status: SSStatus | null; loading: boolean }) {
  const { t } = useTranslation();
  if (loading || !status) return <Badge variant="secondary">{t("sync.badge.checking")}</Badge>;
  if (!status.exists) return <Badge variant="destructive">{t("sync.badge.notCreated")}</Badge>;
  if (!status.configured) return <Badge variant="outline">{t("sync.badge.notConfigured")}</Badge>;
  if (!status.enabled) return <Badge variant="outline">{t("sync.badge.notEnabled")}</Badge>;
  if (status.reachable)
    return (
      <Badge className="bg-emerald-600 hover:bg-emerald-600">
        <CheckCircle2Icon className="mr-1 size-3" /> {t("sync.badge.connected")}
      </Badge>
    );
  return (
    <Badge variant="destructive">
      <AlertCircleIcon className="mr-1 size-3" /> {t("sync.badge.unreachable")}
    </Badge>
  );
}

// ── 同步工作区（项目 / 任务维度）────────────────────────────────────────────────

function SyncWorkbench() {
  const { t: tr } = useTranslation();
  const [dimension, setDimension] = React.useState<Dimension>("project");
  const [assetTypes, setAssetTypes] = React.useState<Record<string, boolean>>({
    subdomain: true,
    service: true,
    app: true,
  });
  const [createCompany, setCreateCompany] = React.useState(true);

  const [projects, setProjects] = React.useState<SSProject[]>([]);
  const [tasks, setTasks] = React.useState<SSTask[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const [syncing, setSyncing] = React.useState(false);
  const [result, setResult] = React.useState<Awaited<ReturnType<typeof api.ssSync>> | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setSelected(new Set());
    const fn =
      dimension === "project"
        ? api.ssProjects(page, 50, search).then((r) => setProjects(r.projects))
        : api.ssTasks(page, 50, search).then(setTasks);
    fn.catch((e) => toast.error(tr("sync.listLoadFailed", { msg: e.message }))).finally(() => setLoading(false));
  }, [dimension, page, search]);

  React.useEffect(() => {
    load();
  }, [load]);

  const rows = dimension === "project" ? projects : tasks;
  const idOf = (row: SSProject | SSTask) => (dimension === "project" ? (row as SSProject).id : (row as SSTask).name);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map(idOf))));
  };

  const chosenTypes = ASSET_TYPES.filter((t) => assetTypes[t.key]).map((t) => t.key);

  const runSync = async () => {
    if (selected.size === 0)
      return toast.error(tr("sync.selectAtLeastOne", { target: tr(dimension === "project" ? "sync.project" : "sync.task") }));
    if (chosenTypes.length === 0) return toast.error(tr("sync.selectAssetType"));
    setSyncing(true);
    setResult(null);
    try {
      const r = await api.ssSync({
        dimension,
        targets: [...selected],
        asset_types: chosenTypes,
        create_company: dimension === "project" ? createCompany : false,
      });
      setResult(r);
      const total = Object.values(r.synced ?? {}).reduce((a, b) => a + b, 0);
      toast.success(tr("sync.syncDone", { count: total }));
    } catch (e) {
      toast.error(tr("sync.syncFailed", { msg: (e as Error).message }));
    } finally {
      setSyncing(false);
    }
  };

  const renderRows = () => {
    if (loading) {
      return (
        <TableRow>
          <TableCell colSpan={4} className="py-8 text-center text-muted-foreground text-sm">
            {tr("common.loading")}
          </TableCell>
        </TableRow>
      );
    }
    if (rows.length === 0) {
      return (
        <TableRow>
          <TableCell colSpan={4} className="py-8 text-center text-muted-foreground text-sm">
            {tr("sync.noData")}
          </TableCell>
        </TableRow>
      );
    }
    if (dimension === "project") {
      return projects.map((p) => (
        <TableRow key={p.id} className="cursor-pointer" onClick={() => toggle(p.id)}>
          <TableCell onClick={(e) => e.stopPropagation()}>
            <Checkbox checked={selected.has(p.id)} onCheckedChange={() => toggle(p.id)} />
          </TableCell>
          <TableCell className="font-medium">{p.name}</TableCell>
          <TableCell>{p.tag ? <Badge variant="secondary">{p.tag}</Badge> : "—"}</TableCell>
          <TableCell className="text-right">{p.AssetCount ?? 0}</TableCell>
        </TableRow>
      ));
    }
    return tasks.map((t) => (
      <TableRow key={t.id} className="cursor-pointer" onClick={() => toggle(t.name)}>
        <TableCell onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={selected.has(t.name)} onCheckedChange={() => toggle(t.name)} />
        </TableCell>
        <TableCell className="font-medium">{t.name}</TableCell>
        <TableCell>
          <Badge variant={t.progress === 100 ? "secondary" : "outline"}>
            {t.progress != null ? `${t.progress}%` : "—"}
          </Badge>
        </TableCell>
        <TableCell className="text-muted-foreground text-xs">{t.endTime || t.creatTime || "—"}</TableCell>
      </TableRow>
    ));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{tr("sync.workbench.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 维度切换 */}
        <Tabs
          value={dimension}
          onValueChange={(v) => {
            setDimension(v as Dimension);
            setPage(1);
          }}
        >
          <TabsList>
            <TabsTrigger value="project">{tr("sync.projectDimension")}</TabsTrigger>
            <TabsTrigger value="task">{tr("sync.taskDimension")}</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* 资产类型 + 选项 */}
        <div className="flex flex-wrap items-center gap-4">
          <span className="font-medium text-sm">{tr("sync.syncAssets")}</span>
          {ASSET_TYPES.map((t) => (
            <label key={t.key} htmlFor={`at-${t.key}`} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                id={`at-${t.key}`}
                checked={!!assetTypes[t.key]}
                onCheckedChange={(c) => setAssetTypes((prev) => ({ ...prev, [t.key]: !!c }))}
              />
              {tr(t.label)}
            </label>
          ))}
          {dimension === "project" && (
            <label htmlFor="create-company" className="flex items-center gap-1.5 text-sm">
              <Checkbox id="create-company" checked={createCompany} onCheckedChange={(c) => setCreateCompany(!!c)} />
              {tr("sync.createCompanyOption")}
            </label>
          )}
        </div>

        {/* 搜索 + 操作 */}
        <div className="flex items-center gap-2">
          <div className="relative max-w-xs flex-1">
            <SearchIcon className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder={dimension === "project" ? tr("sync.searchProjectName") : tr("sync.searchTaskName")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setPage(1);
                  load();
                }
              }}
            />
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCwIcon className={loading ? "size-4 animate-spin" : "size-4"} />
          </Button>
          <div className="flex-1" />
          <span className="text-muted-foreground text-xs">{tr("sync.selectedCount", { count: selected.size })}</span>
          <Button onClick={runSync} disabled={syncing || selected.size === 0}>
            <DownloadIcon className={syncing ? "size-4 animate-pulse" : "size-4"} /> {tr("sync.syncSelected")}
          </Button>
        </div>

        {/* 列表 */}
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={rows.length > 0 && selected.size === rows.length} onCheckedChange={toggleAll} />
                </TableHead>
                <TableHead>{dimension === "project" ? tr("sync.projectName") : tr("sync.taskName")}</TableHead>
                {dimension === "project" ? (
                  <>
                    <TableHead>{tr("sync.tag")}</TableHead>
                    <TableHead className="text-right">{tr("sync.assetCount")}</TableHead>
                  </>
                ) : (
                  <>
                    <TableHead>{tr("common.status")}</TableHead>
                    <TableHead>{tr("sync.time")}</TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>{renderRows()}</TableBody>
          </Table>
        </div>

        {/* 分页 */}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
            {tr("sync.prevPage")}
          </Button>
          <span className="text-muted-foreground text-xs">{tr("sync.pageN", { page })}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={rows.length < 50 || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            {tr("sync.nextPage")}
          </Button>
        </div>

        {/* 结果 */}
        {result && <SyncResult result={result} />}
      </CardContent>
    </Card>
  );
}

function SyncResult({ result }: { result: Awaited<ReturnType<typeof api.ssSync>> }) {
  const { t } = useTranslation();
  const synced = result.synced ?? {};
  const labels: Record<string, string> = {
    subdomain: t("sync.assetType.subdomain"),
    service: t("sync.assetType.service"),
    app: t("sync.assetType.app"),
    ip: "IP",
  };
  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap gap-3">
        {Object.entries(synced).map(([k, v]) => (
          <Badge key={k} variant="secondary">
            {labels[k] ?? k}: {v}
          </Badge>
        ))}
      </div>
      {result.companies && result.companies.length > 0 && (
        <p className="text-muted-foreground">{t("sync.companiesUpserted", { companies: result.companies.join("、") })}</p>
      )}
      {result.warnings && result.warnings.length > 0 && (
        <ul className="list-inside list-disc text-amber-600 dark:text-amber-500">
          {result.warnings.map((wm) => (
            <li key={wm}>{wm}</li>
          ))}
        </ul>
      )}
      {result.errors && result.errors.length > 0 && (
        <ul className="list-inside list-disc text-destructive">
          {result.errors.slice(0, 20).map((em) => (
            <li key={em}>{em}</li>
          ))}
          {result.errors.length > 20 && <li>{t("sync.moreErrors", { count: result.errors.length })}</li>}
        </ul>
      )}
    </div>
  );
}
