"use client";

import * as React from "react";
import { toast } from "sonner";
import { PlayIcon, PlusIcon, RotateCcwIcon, SaveIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { api } from "@/lib/api";
import type { Agent, Tool } from "@/lib/types";

// Traffic tools are host tools gated by the global 流量捕获 switch: bindable, but
// only usable when capture is on. Keep in sync with traffic.SeedToolMetas.
const TRAFFIC_TOOL_KEYS = new Set(["traffic_search", "traffic_get"]);

// paramRows flattens schema.properties into an ordered row list for editing.
// name/type/required are read-only (welded to the Go handler); description/default
// are editable. Non-scalar params (array/object) can't carry an editable default.
// parentKey is set for rows that live inside an array param's items.properties.
type ParamRow = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  defaultStr: string; // "" = no default declared
  scalar: boolean;
  parentKey?: string; // set when this is a sub-field of an array param's items
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRows(schema: Record<string, any>): ParamRow[] {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set<string>((schema?.required as string[]) ?? []);
  const rows: ParamRow[] = [];
  for (const [name, p] of Object.entries(props)) {
    const type = String(p?.type ?? "");
    const hasDefault = p != null && "default" in p && (p as Record<string, unknown>).default != null;
    rows.push({
      name, type,
      required: required.has(name),
      description: String(p?.description ?? ""),
      defaultStr: hasDefault ? String((p as Record<string, unknown>).default) : "",
      scalar: ["string", "integer", "number", "boolean"].includes(type),
    });
    // Expand items.properties for array params so sub-fields are editable.
    if (type === "array") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itemProps = (p as any)?.items?.properties as Record<string, Record<string, unknown>> | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itemRequired = new Set<string>(((p as any)?.items?.required as string[]) ?? []);
      if (itemProps) {
        for (const [subName, subP] of Object.entries(itemProps)) {
          const subType = String((subP as Record<string, unknown>)?.type ?? "");
          const subHasDefault = subP != null && "default" in subP && subP.default != null;
          rows.push({
            name: subName, type: subType,
            required: itemRequired.has(subName),
            description: String(subP?.description ?? ""),
            defaultStr: subHasDefault ? String(subP.default) : "",
            scalar: ["string", "integer", "number", "boolean"].includes(subType),
            parentKey: name,
          });
        }
      }
    }
  }
  return rows;
}

// coerceDefault turns the edited default string back into a typed JSON value, or
// undefined to drop the "default" key entirely.
function coerceDefault(type: string, raw: string): unknown {
  const s = raw.trim();
  if (s === "") return undefined;
  if (type === "integer" || type === "number") {
    const n = Number(s);
    return Number.isNaN(n) ? undefined : n;
  }
  if (type === "boolean") return s === "true";
  return raw;
}

// applyRows writes edited rows back into a deep-copied schema (structure untouched).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyRows(schema: Record<string, any>, rows: ParamRow[]): Record<string, any> {
  const next = structuredClone(schema ?? {});
  const props = (next.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const r of rows) {
    if (r.parentKey) {
      // Sub-field of an array param's items.properties
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parent = props[r.parentKey] as any;
      const subP = parent?.items?.properties?.[r.name] as Record<string, unknown> | undefined;
      if (!subP) continue;
      subP.description = r.description;
      if (r.scalar) {
        const dv = coerceDefault(r.type, r.defaultStr);
        if (dv === undefined) delete subP.default;
        else subP.default = dv;
      }
    } else {
      const p = props[r.name];
      if (!p) continue;
      p.description = r.description;
      if (r.scalar) {
        const dv = coerceDefault(r.type, r.defaultStr);
        if (dv === undefined) delete p.default;
        else p.default = dv;
      }
    }
  }
  return next;
}

// ToolEditor is the full edit form for one tool, rendered inside the drawer.
function ToolEditor({
  tool,
  agents,
  captureOn,
  onSaved,
  onClose,
}: {
  tool: Tool;
  agents: Agent[];
  captureOn: boolean;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // traffic tools can't be bound/enabled until the global 流量捕获 switch is on.
  const trafficGated = TRAFFIC_TOOL_KEYS.has(tool.key) && !captureOn;
  const [description, setDescription] = React.useState(tool.description);
  const [bound, setBound] = React.useState<string[]>(tool.agents);
  const [enabled, setEnabled] = React.useState(tool.enabled);
  const [rows, setRows] = React.useState<ParamRow[]>(() => toRows(tool.schema));
  const [saving, setSaving] = React.useState(false);

  const setRow = (i: number, patch: Partial<ParamRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggleAgent = (k: string) =>
    setBound((b) => (b.includes(k) ? b.filter((x) => x !== k) : [...b, k]));

  async function save() {
    setSaving(true);
    try {
      await api.saveTool(tool.key, {
        description,
        schema: applyRows(tool.schema, rows),
        agents: bound,
        enabled,
      });
      toast.success(t("tools.editor.savedTool", { key: tool.key }));
      onSaved();
      onClose();
    } catch (e) {
      toast.error(t("tools.toast.saveFailed", { msg: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }
  async function reset() {
    try {
      await api.resetTool(tool.key);
      toast.success(t("tools.editor.resetDone", { key: tool.key }));
      onSaved();
      onClose();
    } catch (e) {
      toast.error(t("tools.editor.resetFailed", { msg: (e as Error).message }));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
        {trafficGated && (
          <div className="border-amber-500/40 bg-amber-500/10 text-muted-foreground rounded-md border px-3 py-2 text-xs">
            {t("tools.editor.trafficGatedPre")}
            <b>{t("tools.editor.trafficCaptureLabel")}</b>
            {t("tools.editor.trafficGatedPost")}
          </div>
        )}
        {/* binding + switch */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground text-xs">{t("tools.editor.bindAgent")}</Label>
            <div className="flex flex-wrap gap-3">
              {agents.map((ag) => (
                <label key={ag.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={bound.includes(ag.key)}
                    disabled={trafficGated}
                    onCheckedChange={() => toggleAgent(ag.key)}
                  />
                  {ag.name}
                  <span className="text-muted-foreground font-mono text-xs">{ag.key}</span>
                </label>
              ))}
              {agents.length === 0 && <span className="text-muted-foreground text-xs">{t("tools.editor.noAgents")}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} id={`en-${tool.key}`} />
            <Label htmlFor={`en-${tool.key}`} className="text-sm">
              {t("common.enabled")}
            </Label>
          </div>
        </div>

        {/* description */}
        <div className="grid gap-1.5">
          <Label className="text-muted-foreground text-xs">{t("tools.editor.descLabel")}</Label>
          <Textarea
            className="font-mono text-xs"
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* params */}
        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">
            {t("tools.editor.paramsLabel")}
          </Label>
          {rows.length === 0 && <span className="text-muted-foreground text-xs">{t("tools.editor.noParams")}</span>}
          {rows.map((r, i) => (
            <div
              key={(r.parentKey ?? "") + "." + r.name}
              className={r.parentKey
                ? "border-l-2 border-muted ml-3 pl-3 grid gap-2 py-2"
                : "grid gap-2 rounded-md border p-3"
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                {r.parentKey && <span className="text-muted-foreground font-mono text-[10px]">↳</span>}
                <span className="font-mono text-sm">{r.name}</span>
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  {r.type || "?"}
                </Badge>
                {r.required && (
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                    {t("tools.editor.required")}
                  </Badge>
                )}
                {r.parentKey && (
                  <span className="text-muted-foreground text-[10px]">{t("tools.editor.itemsSubfield")}</span>
                )}
              </div>
              <div className="grid gap-2">
                <div className="grid gap-1">
                  <Label className="text-muted-foreground text-[11px]">{t("tools.editor.description")}</Label>
                  <Input
                    className="text-xs"
                    value={r.description}
                    onChange={(e) => setRow(i, { description: e.target.value })}
                  />
                </div>
                <div className="grid gap-1">
                  <Label className="text-muted-foreground text-[11px]">{t("tools.editor.default")}</Label>
                  <Input
                    className="text-xs"
                    placeholder={r.scalar ? t("tools.editor.defaultPlaceholder") : t("tools.editor.scalarOnly")}
                    disabled={!r.scalar}
                    value={r.defaultStr}
                    onChange={(e) => setRow(i, { defaultStr: e.target.value })}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Separator className="mt-4" />
      <div className="flex flex-wrap gap-2 p-4">
        <Button size="sm" onClick={save} disabled={saving}>
          <SaveIcon /> {t("common.save")}
        </Button>
        <Button size="sm" variant="outline" onClick={reset}>
          <RotateCcwIcon /> {t("tools.editor.resetDefault")}
        </Button>
      </div>
    </div>
  );
}

// ToolGridCard is one clickable tile in the catalog grid.
function ToolGridCard({ tool, onClick }: { tool: Tool; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      className="hover:border-primary/50 hover:bg-muted/40 focus-visible:ring-ring flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{tool.key}</span>
        {tool.system ? (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {t("tools.card.system")}
          </Badge>
        ) : (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            {t("tools.card.custom", { kind: tool.kind })}
          </Badge>
        )}
        {tool.deferred && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            deferred
          </Badge>
        )}
        {!tool.enabled && (
          <Badge variant="outline" className="text-destructive px-1.5 py-0 text-[10px]">
            {t("tools.card.disabled")}
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground line-clamp-1 h-4 text-xs">
        {tool.description || t("tools.card.noDesc")}
      </p>
      <div className="mt-auto flex flex-wrap gap-1 pt-1">
        {tool.agents.length === 0 && (
          <span className="text-muted-foreground text-[10px]">{t("tools.card.noBoundAgent")}</span>
        )}
        {tool.agents.map((a) => (
          <Badge key={a} variant="outline" className="px-1.5 py-0 text-[10px]">
            {a}
          </Badge>
        ))}
      </div>
    </button>
  );
}

export default function ToolsPage() {
  const { t: tr } = useTranslation();
  const [tools, setTools] = React.useState<Tool[]>([]);
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [captureOn, setCaptureOn] = React.useState(false);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [customEdit, setCustomEdit] = React.useState<Tool | "new" | null>(null);

  const reload = React.useCallback(() => {
    api.tools().then(setTools).catch(() => setTools([]));
  }, []);
  React.useEffect(() => {
    reload();
    api.agents().then(setAgents).catch(() => {});
    api.settings().then((s) => setCaptureOn(!!s.traffic_capture)).catch(() => {});
  }, [reload]);

  const [query, setQuery] = React.useState("");

  const selected = tools.find((t) => t.key === selectedKey) ?? null;
  const matchTool = React.useCallback((t: Tool) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      t.key.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.agents.some((a) => a.toLowerCase().includes(q))
    );
  }, [query]);
  const systemTools = tools.filter((t) => t.system && matchTool(t));
  const customTools = tools.filter((t) => !t.system && matchTool(t));
  const allSystemCount = tools.filter((t) => t.system).length;
  const allCustomCount = tools.filter((t) => !t.system).length;
  // clicking a built-in tool opens the binding drawer; a custom tool opens its full editor.
  const openTool = (t: Tool) => (t.system ? setSelectedKey(t.key) : setCustomEdit(t));

  return (
    <div className="flex flex-1 flex-col gap-4 md:gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{tr("tools.title")}</h1>
          <p className="text-muted-foreground text-sm">{tr("tools.subtitle")}</p>
        </div>
        <div className="relative w-64">
          <SearchIcon className="text-muted-foreground absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
          <Input
            className="h-8 pl-8 text-sm"
            placeholder={tr("tools.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <Tabs defaultValue="system">
        <TabsList>
          <TabsTrigger value="system">{tr("tools.tab.system")}</TabsTrigger>
          <TabsTrigger value="custom">{tr("tools.tab.custom")}</TabsTrigger>
        </TabsList>

        <TabsContent value="system">
          <Card>
            <CardHeader>
              <CardTitle>{tr("tools.tab.system")}</CardTitle>
              <CardDescription>
                {query.trim()
                  ? tr("tools.systemDescMatch", { shown: systemTools.length, total: allSystemCount })
                  : tr("tools.systemDesc", { total: allSystemCount })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {systemTools.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  {query.trim() ? tr("tools.noSystemMatch") : tr("tools.noSystemTools")}
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {systemTools.map((t) => (
                    <ToolGridCard key={t.key} tool={t} onClick={() => openTool(t)} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="custom">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>{tr("tools.tab.custom")}</CardTitle>
                  <CardDescription>
                    {query.trim()
                      ? tr("tools.customDescMatch", { shown: customTools.length, total: allCustomCount })
                      : tr("tools.customDesc", { total: allCustomCount })}
                  </CardDescription>
                </div>
                <Button size="sm" onClick={() => setCustomEdit("new")}>
                  <PlusIcon /> {tr("tools.newCustom")}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {customTools.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  {query.trim() ? tr("tools.noCustomMatch") : tr("tools.noCustomTools")}
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {customTools.map((t) => (
                    <ToolGridCard key={t.key} tool={t} onClick={() => openTool(t)} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelectedKey(null)}>
        <SheetContent
          side="right"
          className="gap-0 p-0 data-[side=right]:w-[30vw] data-[side=right]:sm:max-w-[30vw]"
        >
          {selected && (
            <>
              <SheetHeader className="px-4">
                <SheetTitle className="font-mono">{selected.key}</SheetTitle>
                <SheetDescription>{tr("tools.editDrawerDesc")}</SheetDescription>
              </SheetHeader>
              <ToolEditor
                key={selected.key}
                tool={selected}
                agents={agents}
                captureOn={captureOn}
                onSaved={reload}
                onClose={() => setSelectedKey(null)}
              />
            </>
          )}
        </SheetContent>
      </Sheet>

      <CustomToolDialog
        edit={customEdit}
        agents={agents}
        onClose={() => setCustomEdit(null)}
        onSaved={() => {
          setCustomEdit(null);
          reload();
        }}
      />
    </div>
  );
}

// ---- 自定义工具编辑器 ----

type ExecState = {
  command: string;
  code: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  timeout_ms: string;
  proxy: string;
  use_recording_proxy: boolean;
};

function CustomToolDialog({
  edit,
  agents,
  onClose,
  onSaved,
}: {
  edit: Tool | "new" | null;
  agents: Agent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t: tr } = useTranslation();
  const isNew = edit === "new";
  const tool = edit && edit !== "new" ? edit : null;
  const [key, setKey] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [kind, setKind] = React.useState<"shell" | "command" | "script" | "http">("shell");
  const [ex, setEx] = React.useState<ExecState>({
    command: "", code: "", method: "GET", url: "", headers: "", body: "", timeout_ms: "", proxy: "", use_recording_proxy: false,
  });
  const [schemaText, setSchemaText] = React.useState("");
  const [bound, setBound] = React.useState<string[]>([]);
  const [deferred, setDeferred] = React.useState(false);
  const [enabled, setEnabled] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [paramsText, setParamsText] = React.useState("");
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ output: string; is_error: boolean } | null>(null);

  // (re)load form state when opening.
  React.useEffect(() => {
    if (!edit) return;
    setParamsText(""); setTestResult(null);
    if (edit === "new") {
      setKey(""); setDescription(""); setKind("shell");
      setEx({ command: "", code: "", method: "GET", url: "", headers: "", body: "", timeout_ms: "", proxy: "", use_recording_proxy: false });
      setSchemaText(""); setBound([]); setDeferred(false); setEnabled(true);
      return;
    }
    const t = edit;
    const e = (t.exec ?? {}) as Record<string, unknown>;
    setKey(t.key);
    setDescription(t.description);
    setKind((t.kind as "shell" | "command" | "script" | "http") ?? "shell");
    setEx({
      command: String(e.command ?? ""),
      code: String(e.code ?? ""),
      method: String(e.method ?? "GET"),
      url: String(e.url ?? ""),
      headers: e.headers ? JSON.stringify(e.headers, null, 2) : "",
      body: String(e.body ?? ""),
      timeout_ms: e.timeout_ms ? String(e.timeout_ms) : "",
      proxy: String(e.proxy ?? ""),
      use_recording_proxy: !!e.use_recording_proxy,
    });
    setSchemaText(t.schema && Object.keys(t.schema).length ? JSON.stringify(t.schema, null, 2) : "");
    setBound(t.agents ?? []);
    setDeferred(!!t.deferred);
    setEnabled(t.enabled);
  }, [edit]);

  const toggleAgent = (k: string) => setBound((b) => (b.includes(k) ? b.filter((x) => x !== k) : [...b, k]));

  function buildExec(): Record<string, unknown> {
    if (kind === "shell") return {};
    const t = ex.timeout_ms ? Number(ex.timeout_ms) : undefined;
    if (kind === "command") return { command: ex.command, timeout_ms: t };
    if (kind === "script") return { code: ex.code, timeout_ms: t };
    let headers: Record<string, string> = {};
    if (ex.headers.trim()) {
      try { headers = JSON.parse(ex.headers); } catch { /* validated on save */ }
    }
    return { method: ex.method, url: ex.url, headers, body: ex.body, timeout_ms: t, proxy: ex.proxy, use_recording_proxy: ex.use_recording_proxy };
  }

  async function save() {
    if (isNew && !/^[a-z][a-z0-9_]*$/.test(key.trim())) {
      toast.error(tr("tools.custom.keyInvalid"));
      return;
    }
    let schema: Record<string, unknown> = {};
    if (schemaText.trim()) {
      try { schema = JSON.parse(schemaText); } catch { toast.error(tr("tools.custom.schemaInvalid")); return; }
    }
    if (kind === "http" && ex.headers.trim()) {
      try { JSON.parse(ex.headers); } catch { toast.error(tr("tools.custom.headersInvalid")); return; }
    }
    if (kind === "http") {
      const props = (schema as { properties?: Record<string, unknown> }).properties;
      if (!props || Object.keys(props).length === 0) {
        toast.error(tr("tools.custom.httpSchemaRequired"));
        return;
      }
    }
    setSaving(true);
    const payload = { description, schema: kind === "shell" ? {} : schema, agents: bound, enabled, kind, exec: buildExec(), deferred: kind === "shell" ? false : deferred };
    try {
      if (isNew) await api.createCustomTool({ key: key.trim(), ...payload });
      else await api.updateCustomTool(tool!.key, payload);
      toast.success(isNew ? tr("tools.custom.created") : tr("tools.custom.saved"));
      onSaved();
    } catch (e) {
      toast.error(tr("tools.toast.saveFailed", { msg: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }
  async function del() {
    if (!tool) return;
    try {
      await api.deleteCustomTool(tool.key);
      toast.success(tr("tools.custom.deleted"));
      onSaved();
    } catch (e) {
      toast.error(tr("tools.toast.deleteFailed", { msg: (e as Error).message }));
    }
  }
  // runTest dry-runs the CURRENT form (unsaved) with the sample params, so a
  // template/script/request can be debugged before saving.
  async function runTest() {
    let params: Record<string, unknown> = {};
    if (paramsText.trim()) {
      try { params = JSON.parse(paramsText); } catch { toast.error(tr("tools.custom.testParamsInvalid")); return; }
    }
    if (kind === "http" && ex.headers.trim()) {
      try { JSON.parse(ex.headers); } catch { toast.error(tr("tools.custom.headersInvalid")); return; }
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testCustomTool({ kind, exec: buildExec(), params });
      setTestResult(r);
    } catch (e) {
      setTestResult({ output: (e as Error).message, is_error: true });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Sheet open={!!edit} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex flex-col gap-0 p-0 data-[side=right]:w-[45vw] data-[side=right]:sm:max-w-[45vw] data-[side=right]:min-w-[480px]"
      >
        <SheetHeader className="px-4">
          <SheetTitle>{isNew ? tr("tools.newCustom") : tr("tools.custom.editTitle", { key: tool?.key })}</SheetTitle>
          <SheetDescription>{tr("tools.custom.dialogDesc")}</SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          <div className="grid gap-1.5">
            <Label className="text-xs">Key</Label>
            <Input className="font-mono" placeholder={tr("tools.custom.keyPlaceholder")} value={key} disabled={!isNew}
              onChange={(e) => setKey(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">{tr("tools.custom.descLabel")}</Label>
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs">{tr("common.type")}</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as "shell" | "command" | "script" | "http")}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="shell">{tr("tools.custom.kindShell")}</SelectItem>
                <SelectItem value="command">{tr("tools.custom.kindCommand")}</SelectItem>
                <SelectItem value="script">{tr("tools.custom.kindScript")}</SelectItem>
                <SelectItem value="http">{tr("tools.custom.kindHttp")}</SelectItem>
              </SelectContent>
            </Select>
            {kind === "shell" && (
              <p className="text-muted-foreground text-xs">{tr("tools.custom.shellHint")}</p>
            )}
          </div>

          {kind === "command" && (
            <div className="grid gap-1.5">
              <Label className="text-xs">{tr("tools.custom.commandLabel")}</Label>
              <Textarea className="font-mono text-xs" rows={2} value={ex.command}
                onChange={(e) => setEx({ ...ex, command: e.target.value })} />
            </div>
          )}
          {kind === "script" && (
            <div className="grid gap-1.5">
              <Label className="text-xs">{tr("tools.custom.scriptLabel")}</Label>
              <Textarea className="font-mono text-xs" rows={10} value={ex.code}
                placeholder={'import json,sys\nargs=json.load(sys.stdin)\nprint(...)'}
                onChange={(e) => setEx({ ...ex, code: e.target.value })} />
            </div>
          )}
          {kind === "http" && (
            <div className="grid gap-2">
              <div className="flex gap-2">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Method</Label>
                  <Input className="w-24" value={ex.method} onChange={(e) => setEx({ ...ex, method: e.target.value })} />
                </div>
                <div className="grid flex-1 gap-1.5">
                  <Label className="text-xs">{tr("tools.custom.urlLabel")}</Label>
                  <Input className="font-mono text-xs" value={ex.url} onChange={(e) => setEx({ ...ex, url: e.target.value })} />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">{tr("tools.custom.headersLabel")}</Label>
                <Textarea className="font-mono text-xs" rows={2} value={ex.headers}
                  placeholder={'{"Authorization": "Bearer {token}"}'} onChange={(e) => setEx({ ...ex, headers: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">{tr("tools.custom.bodyLabel")}</Label>
                <Textarea className="font-mono text-xs" rows={2} value={ex.body} onChange={(e) => setEx({ ...ex, body: e.target.value })} />
              </div>
              <div className="flex items-center gap-4">
                <div className="grid gap-1.5">
                  <Label className="text-xs">{tr("tools.custom.proxyLabel")}</Label>
                  <Input className="font-mono text-xs w-56" value={ex.proxy} onChange={(e) => setEx({ ...ex, proxy: e.target.value })} />
                </div>
                <label className="mt-4 flex items-center gap-2 text-sm">
                  <Checkbox checked={ex.use_recording_proxy} onCheckedChange={(v) => setEx({ ...ex, use_recording_proxy: !!v })} />
                  {tr("tools.custom.useRecordingProxy")}
                </label>
              </div>
            </div>
          )}

          {kind !== "shell" && (
            <div className="flex items-center gap-3">
              <div className="grid gap-1.5">
                <Label className="text-xs">{tr("tools.custom.timeoutLabel")}</Label>
                <Input type="number" className="w-32" value={ex.timeout_ms} onChange={(e) => setEx({ ...ex, timeout_ms: e.target.value })} />
              </div>
            </div>
          )}

          {kind !== "shell" && (
            <div className="grid gap-1.5">
              <Label className="text-xs">
                {tr("tools.custom.schemaLabel")}{kind === "http" ? tr("tools.custom.schemaHttpHint") : tr("tools.custom.schemaEmptyHint")}
              </Label>
              <Textarea className="font-mono text-xs" rows={4} value={schemaText}
                placeholder={'{"type":"object","properties":{"target":{"type":"string"}},"required":["target"]}'}
                onChange={(e) => setSchemaText(e.target.value)} />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label className="text-muted-foreground text-xs">{tr("tools.custom.bindAgent")}</Label>
            <div className="flex flex-wrap gap-3">
              {agents.map((a) => (
                <label key={a.key} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={bound.includes(a.key)} onCheckedChange={() => toggleAgent(a.key)} />
                  {a.name}<span className="text-muted-foreground font-mono text-xs">{a.key}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={enabled} onCheckedChange={setEnabled} /> {tr("common.enabled")}
            </label>
            {kind !== "shell" && (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={deferred} onCheckedChange={setDeferred} /> {tr("tools.custom.deferredLabel")}
              </label>
            )}
          </div>

          {kind !== "shell" && (
            <div className="grid gap-1.5 rounded-md border p-3">
              <Label className="text-xs font-medium">{tr("tools.custom.testRunTitle")}</Label>
              <Textarea className="font-mono text-xs" rows={2} value={paramsText}
                placeholder={tr("tools.custom.testParamsPlaceholder")}
                onChange={(e) => setParamsText(e.target.value)} />
              <div>
                <Button size="sm" variant="outline" onClick={runTest} disabled={testing}>
                  <PlayIcon /> {testing ? tr("tools.custom.running") : tr("tools.custom.testRun")}
                </Button>
              </div>
              {testResult && (
                <pre
                  className={
                    "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-xs " +
                    (testResult.is_error ? "text-destructive" : "")
                  }
                >
                  {testResult.output || tr("tools.custom.noOutput")}
                </pre>
              )}
            </div>
          )}
        </div>

        <Separator />
        <div className="flex items-center gap-2 p-4">
          <Button size="sm" onClick={save} disabled={saving}>
            <SaveIcon /> {isNew ? tr("tools.custom.createBtn") : tr("common.save")}
          </Button>
          {!isNew && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={del}>
              <Trash2Icon /> {tr("common.delete")}
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
