"use client";

import * as React from "react";
import { toast } from "sonner";
import { BarChart3Icon, HeartPulseIcon, PlusIcon, RefreshCwIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { MCPServer, MCPStat, MCPStatsResp, MCPTool, Agent } from "@/lib/types";

type Transport = "stdio" | "http";
type FormState = {
  name: string;
  transport: Transport;
  command: string;
  args: string;
  url: string;
  env: string;
  headers: string;
  description: string;
  timeoutSeconds: number;
};
const emptyForm: FormState = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  env: "",
  headers: "",
  description: "",
  timeoutSeconds: 30,
};

export default function MCPPage() {
  const { t: tr } = useTranslation();
  const [servers, setServers] = React.useState<MCPServer[]>([]);
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [visibility, setVisibility] = React.useState<Record<number, string[]>>({});

  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MCPServer | null>(null); // null = add mode
  const [tab, setTab] = React.useState<"config" | "tools">("config");
  const [form, setForm] = React.useState<FormState>(emptyForm);
  const [saving, setSaving] = React.useState(false);
  const [tools, setTools] = React.useState<MCPTool[]>([]);
  const [toolsLoading, setToolsLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [stats, setStats] = React.useState<MCPStatsResp | null>(null);
  const [statsOpen, setStatsOpen] = React.useState(false);

  const load = React.useCallback(() => {
    api.agents().then(setAgents).catch(() => {});
    api
      .mcpServers()
      .then((ss) => {
        setServers(ss);
        ss.forEach((s) =>
          api
            .resourceVisibility("mcp", s.id)
            .then((ids) => setVisibility((v) => ({ ...v, [s.id]: ids })))
            .catch(() => {}),
        );
      })
      .catch(() => {});
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);

  const loadStats = React.useCallback(() => {
    api.mcpStats().then(setStats).catch(() => {});
  }, []);

  React.useEffect(() => { loadStats(); }, [loadStats]);

  async function healthCheck(s: MCPServer) {
    try {
      const r = await api.mcpHealthCheck(s.id);
      toast[r.status === "ok" ? "success" : "error"](r.status === "ok" ? tr("mcp.healthOk", { name: s.name }) : tr("mcp.healthErr", { name: s.name, msg: r.error ?? "" }));
      load();
      loadStats();
    } catch (e) {
      toast.error(tr("mcp.opFailed", { msg: (e as Error).message }));
    }
  }

  function setF(patch: Partial<FormState>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  function parseEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
    return out;
  }
  function envToText(env: Record<string, string> | undefined): string {
    return Object.entries(env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  }

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setTools([]);
    setTab("config");
    setOpen(true);
  }

  function openEdit(s: MCPServer) {
    setEditing(s);
    setForm({
      name: s.name,
      transport: s.transport,
      command: s.command ?? "",
      args: (s.args ?? []).join(" "),
      url: s.url ?? "",
      env: envToText(s.env),
      headers: envToText(s.headers),
      description: s.description ?? "",
      timeoutSeconds: s.timeout_seconds ?? 30,
    });
    setTab("config");
    setOpen(true);
    loadTools(s.id);
  }

  async function loadTools(id: number) {
    setToolsLoading(true);
    try {
      setTools(await api.mcpTools(id));
    } catch {
      setTools([]);
    } finally {
      setToolsLoading(false);
    }
  }

  async function saveForm() {
    if (!form.name.trim()) {
      toast.error(tr("mcp.errNameRequired"));
      return;
    }
    if (form.transport === "stdio" && !form.command.trim()) {
      toast.error(tr("mcp.errCommandRequired"));
      return;
    }
    if (form.transport === "http" && !form.url.trim()) {
      toast.error(tr("mcp.errUrlRequired"));
      return;
    }
    setSaving(true);
    try {
      const base =
        form.transport === "http"
          ? {
              transport: "http" as const,
              url: form.url.trim(),
              command: "",
              args: [] as string[],
              env: parseEnv(form.env),
              headers: parseEnv(form.headers),
            }
          : {
              transport: "stdio" as const,
              command: form.command.trim(),
              args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
              env: parseEnv(form.env),
            };
      await api.saveMcpServer({
        ...(editing ? { id: editing.id } : {}),
        name: form.name.trim(),
        enabled: editing ? editing.enabled : true,
        description: form.description.trim(),
        timeout_seconds: form.timeoutSeconds,
        ...base,
      });
      toast.success(editing ? tr("mcp.saved") : tr("mcp.added"));
      if (!editing) setOpen(false);
      load();
    } catch (e) {
      toast.error(tr("mcp.saveFailed", { msg: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  async function refreshTools() {
    if (!editing) return;
    setRefreshing(true);
    try {
      const t = await api.refreshMcpServer(editing.id);
      setTools(t);
      toast.success(tr("mcp.discovered", { count: t.length }));
      load();
    } catch (e) {
      toast.error(tr("mcp.refreshFailed", { msg: (e as Error).message }));
    } finally {
      setRefreshing(false);
    }
  }

  async function removeServer(s: MCPServer) {
    try {
      await api.deleteMcpServer(s.id);
      toast.success(tr("mcp.deleted", { name: s.name }));
      setOpen(false);
      load();
    } catch (e) {
      toast.error(tr("mcp.deleteFailed", { msg: (e as Error).message }));
    }
  }

  async function toggleEnabled(s: MCPServer) {
    try {
      await api.saveMcpServer({ ...s, enabled: !s.enabled });
      load();
    } catch (e) {
      toast.error(tr("mcp.opFailed", { msg: (e as Error).message }));
    }
  }

  async function toggleVisibility(serverId: number, agentId: string, agentName: string) {
    const on = (visibility[serverId] ?? []).includes(agentId);
    try {
      await api.toggleVisibility(agentId, "mcp", serverId, !on);
      toast.success(on ? tr("mcp.visRevoke", { name: agentName }) : tr("mcp.visGrant", { name: agentName }));
      load();
    } catch (e) {
      toast.error(tr("mcp.opFailed", { msg: (e as Error).message }));
    }
  }

  function renderForm() {
    return (
      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label>{tr("mcp.transport")}</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={form.transport === "stdio" ? "default" : "outline"}
              onClick={() => setF({ transport: "stdio" })}
            >
              {tr("mcp.transportStdio")}
            </Button>
            <Button
              type="button"
              variant={form.transport === "http" ? "default" : "outline"}
              onClick={() => setF({ transport: "http" })}
            >
              {tr("mcp.transportHttp")}
            </Button>
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="m-name">{tr("common.name")}</Label>
          <Input
            id="m-name"
            placeholder="filesystem"
            value={form.name}
            onChange={(e) => setF({ name: e.target.value })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="m-desc">{tr("mcp.descriptionLabel")}</Label>
          <Input
            id="m-desc"
            placeholder={tr("mcp.descriptionPlaceholder")}
            value={form.description}
            onChange={(e) => setF({ description: e.target.value })}
          />
        </div>
        {form.transport === "stdio" ? (
          <>
            <div className="grid gap-2">
              <Label htmlFor="m-cmd">{tr("mcp.command")}</Label>
              <Input
                id="m-cmd"
                className="font-mono"
                placeholder="npx"
                value={form.command}
                onChange={(e) => setF({ command: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="m-args">{tr("mcp.argsLabel")}</Label>
              <Input
                id="m-args"
                className="font-mono"
                placeholder="-y @modelcontextprotocol/server-filesystem /data"
                value={form.args}
                onChange={(e) => setF({ args: e.target.value })}
              />
            </div>
          </>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="m-url">{tr("mcp.remoteUrl")}</Label>
            <Input
              id="m-url"
              className="font-mono"
              placeholder="https://mcp.example.com/mcp"
              value={form.url}
              onChange={(e) => setF({ url: e.target.value })}
            />
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor="m-env">
            {form.transport === "http" ? tr("mcp.envLabel") : tr("mcp.envLabel")}
          </Label>
          <Textarea
            id="m-env"
            className="font-mono"
            placeholder={form.transport === "http" ? "TRACE_ID=xxx" : "API_KEY=xxxx\nFOO=bar"}
            value={form.env}
            onChange={(e) => setF({ env: e.target.value })}
          />
        </div>
        {form.transport === "http" && (
          <div className="grid gap-2">
            <Label htmlFor="m-headers">{tr("mcp.headersLabel")}</Label>
            <Textarea
              id="m-headers"
              className="font-mono"
              placeholder="Authorization=Bearer xxxx&#10;X-API-Key=yyy"
              value={form.headers}
              onChange={(e) => setF({ headers: e.target.value })}
            />
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor="m-timeout">{tr("mcp.timeoutLabel")}</Label>
          <Input
            id="m-timeout"
            type="number"
            min={5}
            max={300}
            className="w-28"
            value={form.timeoutSeconds}
            onChange={(e) => setF({ timeoutSeconds: Number(e.target.value) || 30 })}
          />
        </div>
      </div>
    );
  }

  function renderTools() {
    return (
      <div className="flex flex-col gap-3 py-4">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-sm">{tr("mcp.toolCount", { count: tools.length })}</span>
          <Button size="sm" variant="outline" disabled={refreshing} onClick={refreshTools}>
            <RefreshCwIcon className={refreshing ? "animate-spin" : ""} /> {tr("mcp.refresh")}
          </Button>
        </div>
        {toolsLoading ? (
          <p className="text-muted-foreground text-sm">{tr("common.loading")}</p>
        ) : tools.length === 0 ? (
          <p className="text-muted-foreground text-sm">{tr("mcp.noToolsHint")}</p>
        ) : (
          <div className="flex flex-col divide-y">
            {tools.map((t) => (
              <div key={t.name} className="py-2.5">
                <code className="font-mono text-sm">{t.name}</code>
                {t.description && (
                  <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                    {t.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 md:gap-6">
      <div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">MCP</h1>
            <p className="text-muted-foreground text-sm">{tr("mcp.subtitle")}</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => { loadStats(); setStatsOpen(true); }}>
            <BarChart3Icon className="size-3.5" />{tr("mcp.statsButton")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <button
          type="button"
          onClick={openAdd}
          className="text-foreground/70 border-foreground/70 hover:bg-muted/60 hover:shadow-sm flex min-h-[116px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed transition"
        >
          <PlusIcon className="size-6" />
          <span className="text-sm">{tr("mcp.addCard")}</span>
        </button>

        {servers.map((s) => (
          <Card
            key={s.id}
            onClick={() => openEdit(s)}
            className="hover:border-primary/60 cursor-pointer gap-3 transition hover:shadow-sm"
          >
            <CardHeader>
              <div className="flex items-center gap-2">
                <ServerIcon className="text-muted-foreground size-4 shrink-0" />
                <CardTitle className="truncate text-base">{s.name}</CardTitle>
                <Badge variant="outline" className="uppercase">
                  {s.transport}
                </Badge>
                {(s.status === "ok" || s.status === "error") && (
                  <Badge
                    variant={s.status === "ok" ? "default" : "destructive"}
                    className="text-[10px]"
                    title={s.status === "ok" ? tr("mcp.statusOk") : tr("mcp.statusErr", { msg: s.status_error || "" })}
                  >
                    {s.status === "ok" ? "✓" : "✗"}
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <Switch
                    checked={s.enabled}
                    onCheckedChange={() => toggleEnabled(s)}
                    aria-label={tr("common.enabled")}
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={tr("mcp.healthCheck")}
                    onClick={(e) => { e.stopPropagation(); healthCheck(s); }}
                  >
                    <HeartPulseIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={tr("common.delete")}
                    onClick={() => removeServer(s)}
                  >
                    <Trash2Icon className="text-destructive" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              {s.description && (
                <p className="text-muted-foreground text-xs line-clamp-2">{s.description}</p>
              )}
              <p className="text-muted-foreground text-sm">
                {s.tools && s.tools.length > 0 ? tr("mcp.toolCount", { count: s.tools.length }) : tr("mcp.noTools")}
              </p>
              <div className="grid gap-2" onClick={(e) => e.stopPropagation()}>
                <span className="text-muted-foreground text-xs">{tr("mcp.visibility")}</span>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {agents.map((a) => (
                    <label key={a.key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={(visibility[s.id] ?? []).includes(a.id)}
                        onCheckedChange={() => toggleVisibility(s.id, a.id, a.name)}
                      />
                      {a.name}
                    </label>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full data-[side=right]:sm:max-w-lg"
        >
          <SheetHeader>
            <SheetTitle>{editing ? editing.name : tr("mcp.addServer")}</SheetTitle>
            <SheetDescription>
              {tr("mcp.dialogDesc")}
            </SheetDescription>
          </SheetHeader>

          {editing ? (
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as "config" | "tools")}
              className="flex min-h-0 flex-1 flex-col px-4"
            >
              <TabsList>
                <TabsTrigger value="config">{tr("mcp.tabConfig")}</TabsTrigger>
                <TabsTrigger value="tools">
                  {tools.length ? tr("mcp.tabToolsCount", { count: tools.length }) : tr("mcp.tabTools")}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="config" className="min-h-0 flex-1 overflow-y-auto">
                {renderForm()}
                <div className="flex gap-2 pt-2 pb-6">
                  <Button onClick={saveForm} disabled={saving}>
                    {tr("common.save")}
                  </Button>
                </div>
              </TabsContent>
              <TabsContent value="tools" className="min-h-0 flex-1 overflow-y-auto">
                {renderTools()}
              </TabsContent>
            </Tabs>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
              {renderForm()}
              <div className="pt-2 pb-6">
                <Button onClick={saveForm} disabled={saving}>
                  <PlusIcon /> {tr("mcp.add")}
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* ── MCP 调用统计 ── */}
      <Sheet open={statsOpen} onOpenChange={setStatsOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 data-[side=right]:sm:max-w-xl">
          <SheetHeader className="px-4 pt-4">
            <SheetTitle className="flex items-center gap-2">
              <BarChart3Icon className="size-4" />{tr("mcp.statsTitle")}
            </SheetTitle>
          </SheetHeader>
          <div className="grid grid-cols-3 gap-2 px-4 py-3">
            {[
              { label: tr("mcp.statsEnabled"), value: stats?.enabled_count ?? 0 },
              { label: tr("mcp.statsTotal"), value: stats?.total_count ?? 0 },
              { label: tr("mcp.statsCalls"), value: stats?.total_calls ?? 0 },
            ].map((m) => (
              <div key={m.label} className="rounded-md border p-2 text-center">
                <div className="text-lg font-semibold tabular-nums">{m.value}</div>
                <div className="text-muted-foreground text-[11px]">{m.label}</div>
              </div>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            {stats && stats.servers.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {[...stats.servers].sort((a, b) => b.calls - a.calls).map((st) => (
                  <div key={st.server_name} className="rounded-md border p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-sm">{st.server_name}</span>
                      <Badge variant="secondary" className="shrink-0 tabular-nums">
                        {tr("mcp.statsCallsN", { n: st.calls })}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground mt-1 text-[11px]">
                      {st.last_at ? tr("mcp.statsLastAt", { t: new Date(st.last_at).toLocaleString() }) : "—"}
                    </div>
                    {Object.keys(st.by_agent).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {Object.entries(st.by_agent).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
                          <Badge key={k} variant="outline" className="px-1.5 py-0 text-[10px]">{k} · {n}</Badge>
                        ))}
                      </div>
                    )}
                    {/* top tools */}
                    {Object.entries(st.by_tool).length > 0 && (
                      <div className="mt-1 text-muted-foreground text-[10px] leading-relaxed">
                        {Object.entries(st.by_tool).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tn, n]) => (
                          <span key={tn} className="mr-2 font-mono">{tn} · {n}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground py-8 text-center text-sm">{tr("mcp.statsEmpty")}</p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
