"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ListFilterIcon,
  PencilIcon,
  PlusIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import type { InterceptRule, InterceptAction, Tool } from "@/lib/types";

// ---- tool scope ----

// SDK tools are intentionally not seeded into the DB (they apply to every agent
// and have no per-agent binding). We hardcode them here so they still appear in
// the scope dialog.
function sdkTool(key: string, description: string): Tool {
  return { key, system: true, description, schema: {}, agents: [], enabled: true, kind: "builtin" };
}

const SDK_EXEC_KEYS = ["Bash", "WebFetch", "web_search", "shell_open", "shell_send", "shell_read", "shell_close", "shell_list"];
const SDK_WRITE_KEYS = ["Write", "Edit", "MultiEdit"];

const SDK_KEYS = new Set([...SDK_EXEC_KEYS, ...SDK_WRITE_KEYS]);

function groupTools(t: (key: string) => string, dbTools: Tool[]) {
  const sdkExec = SDK_EXEC_KEYS.map((k) => sdkTool(k, t(`intercept.sdkTool.${k}`)));
  const sdkWrite = SDK_WRITE_KEYS.map((k) => sdkTool(k, t(`intercept.sdkTool.${k}`)));
  const sys: Tool[] = [], custom: Tool[] = [];
  for (const tool of dbTools) {
    if (SDK_KEYS.has(tool.key)) continue; // already covered by hardcoded groups
    if (tool.system) sys.push(tool);
    else             custom.push(tool);
  }
  return [
    { label: t("intercept.toolGroup.exec"),   tools: sdkExec },
    { label: t("intercept.toolGroup.write"),  tools: sdkWrite },
    { label: t("intercept.toolGroup.system"), tools: sys },
    { label: t("intercept.toolGroup.custom"), tools: custom },
  ].filter((g) => g.tools.length > 0);
}

// ---- form state ----

type RuleForm = {
  name: string;
  enabled: boolean;
  priority: number;
  match_target: "tool_name" | "tool_input";
  match_type: "string" | "regex";
  pattern: string;
  action: InterceptAction;
  message: string;
  timeout_enabled: boolean;
  timeout_seconds: number;
  timeout_action: "deny" | "allow";
};

const defaultForm = (): RuleForm => ({
  name: "",
  enabled: true,
  priority: 0,
  match_target: "tool_name",
  match_type: "string",
  pattern: "",
  action: "deny",
  message: "",
  timeout_enabled: true,
  timeout_seconds: 60,
  timeout_action: "deny",
});

// ---- small components ----

function ActionBadge({ action }: { action: InterceptAction }) {
  const { t } = useTranslation();
  if (action === "allow") return <Badge variant="secondary">{t("intercept.action.allow")}</Badge>;
  if (action === "deny")  return <Badge variant="destructive">{t("intercept.action.deny")}</Badge>;
  return <Badge variant="outline" className="border-amber-400 text-amber-600">{t("intercept.action.ask")}</Badge>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </Label>
      {children}
    </div>
  );
}

// ---- page ----

export default function InterceptPage() {
  const { t: tr } = useTranslation();
  const [rules, setRules]     = React.useState<InterceptRule[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen]       = React.useState(false);
  const [editing, setEditing] = React.useState<InterceptRule | null>(null);
  const [form, setForm]       = React.useState<RuleForm>(defaultForm());
  const [saving, setSaving]   = React.useState(false);
  const [regexErr, setRegexErr] = React.useState("");
  const [regexWarn, setRegexWarn] = React.useState(false); // true = JS 无法解析但可能是合法 Go 语法

  // ---- tool scope dialog ----
  const [scopeOpen, setScopeOpen]       = React.useState(false);
  const [allTools, setAllTools]         = React.useState<Tool[]>([]);
  const [enabledTools, setEnabledTools] = React.useState<Set<string>>(new Set());
  const [scopeLoading, setScopeLoading] = React.useState(false);
  const [scopeSaving, setScopeSaving]   = React.useState(false);

  // ---- data ----

  const load = React.useCallback(async () => {
    try {
      const r = await api.interceptRules();
      setRules(r);
    } catch {
      toast.error(tr("intercept.toast.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [tr]);

  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    if (form.match_type !== "regex" || !form.pattern) { setRegexErr(""); setRegexWarn(false); return; }
    try {
      new RegExp(form.pattern);
      setRegexErr("");
      setRegexWarn(false);
    } catch {
      // JS RegExp 不支持 Go RE2 扩展语法（如 (?i) 内联 flag）。
      // 这里只是预览校验失败，不代表 Go 端无效；交给服务端最终验证。
      setRegexErr("");
      setRegexWarn(true);
    }
  }, [form.pattern, form.match_type]);

  // ---- rule handlers ----

  function set(patch: Partial<RuleForm>) { setForm(f => ({ ...f, ...patch })); }

  function openNew() {
    setEditing(null);
    setForm(defaultForm());
    setRegexErr("");
    setOpen(true);
  }

  function openEdit(rule: InterceptRule) {
    setEditing(rule);
    setForm({
      name: rule.name, enabled: rule.enabled, priority: rule.priority,
      match_target: rule.match_target, match_type: rule.match_type,
      pattern: rule.pattern, action: rule.action, message: rule.message,
      timeout_enabled: rule.timeout_enabled, timeout_seconds: rule.timeout_seconds,
      timeout_action: rule.timeout_action,
    });
    setRegexErr("");
    setOpen(true);
  }

  async function handleSave() {
    if (!form.name.trim())    { toast.error(tr("intercept.toast.nameRequired")); return; }
    if (!form.pattern.trim()) { toast.error(tr("intercept.toast.patternRequired")); return; }
    if (regexErr)             { toast.error(tr("intercept.toast.regexInvalid")); return; }
    setSaving(true);
    try {
      if (editing) {
        await api.updateInterceptRule(editing.id, form);
        toast.success(tr("intercept.toast.updated"));
      } else {
        await api.createInterceptRule(form);
        toast.success(tr("intercept.toast.created"));
      }
      setOpen(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await api.deleteInterceptRule(id);
      toast.success(tr("intercept.toast.deleted"));
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleToggle(rule: InterceptRule) {
    try {
      await api.toggleInterceptRule(rule.id, !rule.enabled);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // ---- scope handlers ----

  async function openScope() {
    setScopeOpen(true);
    setScopeLoading(true);
    try {
      const [tools, cfg] = await Promise.all([api.tools(), api.interceptGetToolConfig()]);
      setAllTools(tools);
      setEnabledTools(new Set(cfg.enabled_tools));
    } catch (e) {
      toast.error(tr("intercept.toast.loadFailMsg", { msg: (e as Error).message }));
    } finally {
      setScopeLoading(false);
    }
  }

  function toggleTool(key: string, val: boolean) {
    setEnabledTools(prev => {
      const next = new Set(prev);
      if (val) next.add(key); else next.delete(key);
      return next;
    });
  }

  async function saveScope() {
    setScopeSaving(true);
    try {
      await api.interceptSetToolConfig([...enabledTools]);
      toast.success(tr("intercept.toast.scopeSaved"));
      setScopeOpen(false);
    } catch (e) {
      toast.error(tr("intercept.toast.saveFailMsg", { msg: (e as Error).message }));
    } finally {
      setScopeSaving(false);
    }
  }

  const toolGroups = React.useMemo(() => groupTools(tr, allTools), [tr, allTools]);

  // ---- render ----

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">

      {/* ---- header ---- */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <ShieldAlertIcon className="h-5 w-5 mt-0.5 shrink-0" />
          <div>
            <h1 className="text-lg font-semibold leading-tight">{tr("intercept.title")}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {tr("intercept.subtitle")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={openScope}>
            <ListFilterIcon className="h-4 w-4" />
            {tr("intercept.scope")}
          </Button>
          <Button onClick={openNew} size="sm">
            <PlusIcon className="h-4 w-4" />
            {tr("intercept.newRule")}
          </Button>
        </div>
      </div>

      {/* ---- rules table ---- */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-6 text-sm text-muted-foreground">{tr("common.loading")}</p>
          ) : rules.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <ShieldAlertIcon className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{tr("intercept.empty")}</p>
              <Button size="sm" variant="outline" onClick={openNew}>
                <PlusIcon className="h-4 w-4" />
                {tr("intercept.createFirst")}
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[72px]">{tr("intercept.col.priority")}</TableHead>
                  <TableHead>{tr("common.name")}</TableHead>
                  <TableHead className="w-[90px]">{tr("intercept.col.target")}</TableHead>
                  <TableHead className="w-[80px]">{tr("common.type")}</TableHead>
                  <TableHead>{tr("intercept.col.pattern")}</TableHead>
                  <TableHead className="w-[72px]">{tr("intercept.col.policy")}</TableHead>
                  <TableHead className="w-[64px] text-center">{tr("common.enabled")}</TableHead>
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id} className={!rule.enabled ? "opacity-40" : ""}>
                    <TableCell>
                      <span className="font-mono text-xs tabular-nums">{rule.priority}</span>
                    </TableCell>
                    <TableCell className="font-medium text-sm">{rule.name}</TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">
                        {rule.match_target === "tool_name" ? tr("intercept.targetName") : tr("intercept.targetInput")}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">
                        {rule.match_type === "regex" ? tr("intercept.typeRegex") : tr("intercept.typeString")}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[220px]">
                      <code className="block truncate rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                        {rule.pattern}
                      </code>
                    </TableCell>
                    <TableCell>
                      <ActionBadge action={rule.action} />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={rule.enabled}
                        onCheckedChange={() => handleToggle(rule)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-0.5">
                        <Button
                          size="icon" variant="ghost" className="h-7 w-7"
                          onClick={() => openEdit(rule)}
                        >
                          <PencilIcon className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon" variant="ghost"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => handleDelete(rule.id)}
                        >
                          <Trash2Icon className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ---- editor sheet ---- */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex flex-col gap-0 p-0 sm:max-w-md">
          <SheetHeader className="border-b px-6 py-4">
            <SheetTitle>{editing ? tr("intercept.editRule") : tr("intercept.newRule")}</SheetTitle>
            <SheetDescription className="text-xs">
              {tr("intercept.sheetDesc")}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
            <Field label={tr("common.name")}>
              <Input
                placeholder={tr("intercept.namePlaceholder")}
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </Field>

            <Field label={tr("intercept.fieldPriority")}>
              <Input
                type="number"
                value={form.priority}
                onChange={(e) => set({ priority: parseInt(e.target.value) || 0 })}
              />
            </Field>

            <Separator />

            <Field label={tr("intercept.fieldMatchTarget")}>
              <Select
                value={form.match_target}
                onValueChange={(v) => set({ match_target: v as RuleForm["match_target"] })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="tool_name">{tr("intercept.optTargetName")}</SelectItem>
                  <SelectItem value="tool_input">{tr("intercept.optTargetInput")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label={tr("intercept.fieldMatchType")}>
              <Select
                value={form.match_type}
                onValueChange={(v) => set({ match_type: v as RuleForm["match_type"] })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="string">{tr("intercept.optTypeString")}</SelectItem>
                  <SelectItem value="regex">{tr("intercept.optTypeRegex")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label={tr("intercept.fieldPattern")}>
              <Input
                placeholder={form.match_type === "regex" ? "^Bash$" : "rm -rf"}
                value={form.pattern}
                onChange={(e) => set({ pattern: e.target.value })}
                className={regexErr ? "border-destructive focus-visible:ring-destructive" : ""}
              />
              {regexErr && (
                <p className="text-xs text-destructive mt-1">{regexErr}</p>
              )}
              {regexWarn && (
                <p className="text-xs text-amber-600 mt-1">{tr("intercept.regexWarnPre")}<code className="font-mono">(?i)</code>{tr("intercept.regexWarnPost")}</p>
              )}
            </Field>

            <Separator />

            <Field label={tr("intercept.fieldAction")}>
              <Select
                value={form.action}
                onValueChange={(v) => set({ action: v as InterceptAction })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">{tr("intercept.optActionAllow")}</SelectItem>
                  <SelectItem value="deny">{tr("intercept.optActionDeny")}</SelectItem>
                  <SelectItem value="ask">{tr("intercept.optActionAsk")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {form.action !== "allow" && (
              <Field label={form.action === "deny" ? tr("intercept.fieldDenyMsg") : tr("intercept.fieldAskMsg")}>
                <Textarea
                  placeholder={form.action === "deny" ? tr("intercept.denyMsgPlaceholder") : ""}
                  value={form.message}
                  onChange={(e) => set({ message: e.target.value })}
                  rows={2}
                  className="resize-none"
                />
              </Field>
            )}

            {form.action === "ask" && (
              <>
                <Separator />
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{tr("intercept.timeoutTitle")}</p>
                    <p className="text-xs text-muted-foreground">{tr("intercept.timeoutDesc")}</p>
                  </div>
                  <Switch
                    checked={form.timeout_enabled}
                    onCheckedChange={(v) => set({ timeout_enabled: v })}
                  />
                </div>
                {form.timeout_enabled && (
                  <div className="flex items-end gap-3">
                    <Field label={tr("intercept.fieldTimeoutSeconds")}>
                      <Input
                        type="number"
                        min={5}
                        className="w-28"
                        value={form.timeout_seconds}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          if (n > 0) set({ timeout_seconds: n });
                        }}
                      />
                    </Field>
                    <Field label={tr("intercept.fieldTimeoutAction")}>
                      <Select
                        value={form.timeout_action}
                        onValueChange={(v) => set({ timeout_action: v as "deny" | "allow" })}
                      >
                        <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="deny">{tr("intercept.optTimeoutDeny")}</SelectItem>
                          <SelectItem value="allow">{tr("intercept.optTimeoutAllow")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                )}
              </>
            )}

            <Separator />

            <div className="flex items-center gap-3">
              <Switch
                id="rule-enabled"
                checked={form.enabled}
                onCheckedChange={(v) => set({ enabled: v })}
              />
              <Label htmlFor="rule-enabled" className="cursor-pointer">{tr("intercept.enableThisRule")}</Label>
            </div>
          </div>

          <SheetFooter className="border-t px-6 py-4 flex-row justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>{tr("common.cancel")}</Button>
            <Button onClick={handleSave} disabled={saving || !!regexErr}>
              {saving ? tr("common.saving") : tr("common.save")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* ---- scope dialog ---- */}
      <Dialog open={scopeOpen} onOpenChange={setScopeOpen}>
        <DialogContent className="sm:max-w-lg flex flex-col overflow-hidden p-0 gap-0" style={{ maxHeight: "min(80vh, 560px)" }}>
          <DialogHeader className="shrink-0 border-b px-6 py-4">
            <DialogTitle className="flex items-center gap-2">
              <ListFilterIcon className="h-4 w-4" />
              {tr("intercept.scope")}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {tr("intercept.scopeDesc")}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-5">
            {scopeLoading ? (
              <p className="text-sm text-muted-foreground py-4">{tr("common.loading")}</p>
            ) : (
              toolGroups.map((group, gi) => (
                <div key={group.label}>
                  {gi > 0 && <Separator className="mb-5" />}
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    {group.label}
                  </p>
                  <div className="space-y-0.5">
                    {group.tools.map((t) => (
                      <div key={t.key} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
                        <Switch
                          id={`scope-${t.key}`}
                          checked={enabledTools.has(t.key)}
                          onCheckedChange={(v) => toggleTool(t.key, v)}
                        />
                        <label htmlFor={`scope-${t.key}`} className="flex-1 min-w-0 cursor-pointer">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-sm">{t.key}</span>
                            {(t.kind && t.kind !== "builtin") && (
                              <Badge variant="outline" className="px-1 py-0 text-[10px]">{t.kind}</Badge>
                            )}
                          </div>
                          {t.description && (
                            <p className="text-[11px] text-muted-foreground line-clamp-1">{t.description}</p>
                          )}
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="shrink-0 border-t px-6 py-3 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setScopeOpen(false)}>{tr("common.cancel")}</Button>
            <Button size="sm" onClick={saveScope} disabled={scopeSaving || scopeLoading}>
              {scopeSaving ? tr("common.saving") : tr("common.save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
