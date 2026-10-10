"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EyeIcon, GitCompareIcon, InfoIcon, RotateCcwIcon, SaveIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AgentDetail, AgentTrigger, LLMProfile, MCPServer, PromptVar, PromptVersion, Settings, SkillItem, Tool } from "@/lib/types";

// Traffic tools are host tools gated by the global 流量捕获 switch: bindable, but
// only usable when capture is on. Keep this list in sync with traffic.SeedToolMetas.
const TRAFFIC_TOOL_KEYS = new Set(["traffic_search", "traffic_get"]);

// AgentEditor is the tabbed editor for one agent, used inside the agents-page
// drawer (and reused full-page for deep links). Tabs: 配置与提示词 / MCP / Skill /
// Tools. Config + prompt save as before; visibility + tool bindings toggle live.
export function AgentEditor({ agentKey, onSaved }: { agentKey: string; onSaved?: () => void }) {
  const { t: tr } = useTranslation();
  const [detail, setDetail] = React.useState<AgentDetail | null>(null);
  const [versions, setVersions] = React.useState<PromptVersion[]>([]);
  const [variables, setVariables] = React.useState<PromptVar[]>([]);
  const [mcp, setMcp] = React.useState<MCPServer[]>([]);
  const [skills, setSkills] = React.useState<SkillItem[]>([]);
  const [tools, setTools] = React.useState<Tool[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [viewVer, setViewVer] = React.useState<PromptVersion | null>(null);
  const [diffVer, setDiffVer] = React.useState<PromptVersion | null>(null);

  const [prompt, setPrompt] = React.useState("");
  const [mcpVisible, setMcpVisible] = React.useState<number[]>([]);
  const [skillVisible, setSkillVisible] = React.useState<string[]>([]);
  const [preview, setPreview] = React.useState("");
  const [maxTurns, setMaxTurns] = React.useState("0");
  const [runSecs, setRunSecs] = React.useState("600");
  const [webSearch, setWebSearch] = React.useState(false);
  const [interactiveShell, setInteractiveShell] = React.useState(false);
  const [llmProfileId, setLlmProfileId] = React.useState("0"); // "0" = 用全局激活配置(分级绑定)
  const [profiles, setProfiles] = React.useState<LLMProfile[]>([]);
  const [wrapup, setWrapup] = React.useState("");
  const [wrapupDefault, setWrapupDefault] = React.useState("");
  const [wrapupTurns, setWrapupTurns] = React.useState("0");
  const [wrapupTurnsDefault, setWrapupTurnsDefault] = React.useState(5);
  // 任务级超时收尾词(仅 worker/planner)
  const [ttSupported, setTtSupported] = React.useState(false);
  const [ttWrapup, setTtWrapup] = React.useState("");
  const [ttWrapupDefault, setTtWrapupDefault] = React.useState("");
  const [ttTurns, setTtTurns] = React.useState("0");
  const [ttTurnsDefault, setTtTurnsDefault] = React.useState(5);
  const [settings, setSettings] = React.useState<Settings | null>(null);

  React.useEffect(() => {
    api.mcpServers().then(setMcp).catch(() => {});
    api.skills().then(setSkills).catch(() => {});
    api.tools().then(setTools).catch(() => {});
    api.settings().then(setSettings).catch(() => {});
    api.llmProfiles().then(setProfiles).catch(() => {});
  }, []);
  // global gates: traffic tools need 流量捕获, web search needs the master switch.
  const captureOn = !!settings?.traffic_capture;
  const webSearchGlobalOn = !!settings?.web_search_enabled;

  const reload = React.useCallback(() => {
    api
      .getAgent(agentKey)
      .then((d) => {
        setDetail(d);
        setPrompt(d.prompt ?? "");
        setVariables(d.variables ?? []);
        setVersions(d.versions ?? []);
        setMcpVisible(d.visibility?.mcp ?? []);
        setSkillVisible(d.visibility?.skill ?? []);
        setMaxTurns(String(d.agent?.max_turns ?? 0));
        setRunSecs(String(d.agent?.run_seconds ?? 600));
        setWebSearch(!!d.agent?.web_search);
        setInteractiveShell(!!d.agent?.interactive_shell);
        setLlmProfileId(String(d.agent?.llm_profile_id ?? 0));
        setWrapup(d.wrapup_prompt ?? "");
        setWrapupDefault(d.wrapup_default ?? "");
        setWrapupTurns(String(d.wrapup_max_turns ?? 0));
        setWrapupTurnsDefault(d.wrapup_max_turns_default ?? 5);
        setTtSupported(!!d.task_timeout_wrapup_supported);
        setTtWrapup(d.task_timeout_wrapup_prompt ?? "");
        setTtWrapupDefault(d.task_timeout_wrapup_default ?? "");
        setTtTurns(String(d.task_timeout_wrapup_max_turns ?? 0));
        setTtTurnsDefault(d.task_timeout_wrapup_max_turns_default ?? 5);
      })
      .catch(() => setDetail(null))
      .finally(() => setLoaded(true));
  }, [agentKey]);
  React.useEffect(() => {
    reload();
  }, [reload]);

  async function doPreview() {
    try {
      const r = await api.previewAgentPrompt(agentKey, prompt);
      setPreview(r.error ? tr("agentEditor.preview.renderError", { error: r.error }) : r.rendered);
    } catch (e) {
      setPreview(tr("agentEditor.preview.previewFailed", { msg: (e as Error).message }));
    }
  }
  async function savePrompt() {
    try {
      const r = await api.saveAgentPrompt(agentKey, prompt);
      toast.success(tr("agentEditor.toast.savedVersion", { version: r.version }));
      reload();
      onSaved?.();
    } catch (e) {
      toast.error(tr("agentEditor.toast.saveFailed", { msg: (e as Error).message }));
    }
  }
  async function resetPrompt() {
    try {
      const r = await api.resetAgentPrompt(agentKey);
      toast.success(tr("agentEditor.toast.resetToDefaultVersion", { version: r.version }));
      reload();
    } catch (e) {
      toast.error(tr("agentEditor.toast.resetFailed", { msg: (e as Error).message }));
    }
  }
  async function saveWrapup() {
    try {
      const turns = Math.max(0, Math.floor(Number(wrapupTurns) || 0));
      await api.saveAgentWrapup(agentKey, wrapup, turns);
      toast.success(wrapup.trim() || turns > 0 ? tr("agentEditor.toast.wrapupSaved") : tr("agentEditor.toast.wrapupCleared"));
      reload();
    } catch (e) {
      toast.error(tr("agentEditor.toast.saveFailed", { msg: (e as Error).message }));
    }
  }
  async function resetWrapup() {
    try {
      await api.resetAgentWrapup(agentKey);
      toast.success(tr("agentEditor.toast.resetToDefault"));
      reload();
    } catch (e) {
      toast.error(tr("agentEditor.toast.resetFailed", { msg: (e as Error).message }));
    }
  }
  async function saveTaskTimeoutWrapup() {
    try {
      const turns = Math.max(0, Math.floor(Number(ttTurns) || 0));
      await api.saveAgentTaskTimeoutWrapup(agentKey, ttWrapup, turns);
      toast.success(tr("agentEditor.toast.ttWrapupSaved"));
      reload();
    } catch (e) {
      toast.error(tr("agentEditor.toast.saveFailed", { msg: (e as Error).message }));
    }
  }
  async function resetTaskTimeoutWrapup() {
    try {
      await api.resetAgentTaskTimeoutWrapup(agentKey);
      toast.success(tr("agentEditor.toast.resetToDefault"));
      reload();
    } catch (e) {
      toast.error(tr("agentEditor.toast.resetFailed", { msg: (e as Error).message }));
    }
  }
  async function saveConfig() {
    try {
      const n = Math.max(0, Math.floor(Number(maxTurns) || 0));
      const rs = Math.max(0, Math.floor(Number(runSecs) || 0));
      await api.saveAgentConfig(agentKey, { max_turns: n, run_seconds: rs, web_search: webSearch, interactive_shell: interactiveShell, llm_profile_id: Number(llmProfileId) || 0 });
      toast.success(tr("agentEditor.toast.configSaved"));
      reload();
    } catch (e) {
      toast.error(tr("agentEditor.toast.saveFailed", { msg: (e as Error).message }));
    }
  }
  // applyVis optimistically updates, persists, and toasts success/failure. On
  // failure it reverts to the prior selection so the UI never lies about state.
  async function applyVis(nextMcp: number[], nextSkill: string[], okMsg: string) {
    const prevMcp = mcpVisible;
    const prevSkill = skillVisible;
    setMcpVisible(nextMcp);
    setSkillVisible(nextSkill);
    try {
      await api.setAgentVisibility(agentKey, nextMcp, nextSkill);
      toast.success(okMsg);
      onSaved?.(); // refresh the list so the card's MCP/Skill counts stay in sync
    } catch (e) {
      setMcpVisible(prevMcp);
      setSkillVisible(prevSkill);
      toast.error(tr("agentEditor.toast.saveFailed", { msg: (e as Error).message }));
    }
  }
  function toggleMcp(id: number) {
    const on = mcpVisible.includes(id);
    const name = mcp.find((m) => m.id === id)?.name ?? String(id);
    applyVis(
      on ? mcpVisible.filter((x) => x !== id) : [...mcpVisible, id],
      skillVisible,
      on ? tr("agentEditor.toast.mcpHidden", { name }) : tr("agentEditor.toast.mcpShown", { name }),
    );
  }
  function toggleSkill(name: string) {
    const on = skillVisible.includes(name);
    applyVis(
      mcpVisible,
      on ? skillVisible.filter((x) => x !== name) : [...skillVisible, name],
      on ? tr("agentEditor.toast.skillHidden", { name }) : tr("agentEditor.toast.skillShown", { name }),
    );
  }
  async function toggleTool(t: Tool) {
    const on = t.agents.includes(agentKey);
    const nextAgents = on ? t.agents.filter((k) => k !== agentKey) : [...t.agents, agentKey];
    // optimistic update
    setTools((ts) => ts.map((x) => (x.key === t.key ? { ...x, agents: nextAgents } : x)));
    try {
      await api.saveTool(t.key, {
        description: t.description,
        schema: t.schema,
        agents: nextAgents,
        enabled: t.enabled,
      });
      toast.success(on ? tr("agentEditor.toast.toolUnbound", { key: t.key }) : tr("agentEditor.toast.toolBound", { key: t.key }));
      onSaved?.(); // refresh the list so the card's 工具 count stays in sync
    } catch (e) {
      toast.error(tr("agentEditor.toast.toolBindFailed", { msg: (e as Error).message }));
      reload();
      api.tools().then(setTools).catch(() => {});
    }
  }

  if (loaded && !detail) {
    return <div className="text-muted-foreground p-6 text-center text-sm">{tr("agentEditor.notFound", { key: agentKey })}</div>;
  }
  // config is meaningless for the conversational main agent and the fixed-budget
  // goals decomposer; every other agent (workers, custom assistants) honors it.
  const showConfig = agentKey !== "mainagent" && agentKey !== "goals";
  // web search applies to every conversational/executing agent except the one-shot
  // goals decomposer; it's gated by the global master switch.
  const showWebSearch = agentKey !== "goals";
  // interactive shell (持久 PTY 会话工具族) 同样对除 goals 外的 agent 开放;无全局门控。
  const showInteractiveShell = agentKey !== "goals";
  // triggers (P3) only attach to custom agents.
  const isCustom = !!detail && !detail.agent?.builtin;

  return (
    <Tabs defaultValue="prompt" className="flex min-h-0 flex-1 flex-col">
      <TabsList className="mx-4 mt-2 w-fit">
        <TabsTrigger value="prompt">{tr("agentEditor.tabs.prompt")}</TabsTrigger>
        <TabsTrigger value="wrapup">{tr("agentEditor.tabs.wrapup")}</TabsTrigger>
        <TabsTrigger value="mcp">MCP</TabsTrigger>
        <TabsTrigger value="skill">Skill</TabsTrigger>
        <TabsTrigger value="tools">Tools</TabsTrigger>
        {isCustom && <TabsTrigger value="triggers">{tr("agentEditor.tabs.triggers")}</TabsTrigger>}
      </TabsList>

      {/* 配置 + 提示词 */}
      <TabsContent value="prompt" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid gap-4">
          {(showConfig || showWebSearch || showInteractiveShell) && (
            <div className="grid gap-3 rounded-md border p-3">
              <div className="flex flex-wrap items-end gap-3">
                {showConfig && (
                  <>
                    <div className="grid gap-1.5">
                      <Label htmlFor="max-turns" className="text-xs">{tr("agentEditor.config.maxTurns")}</Label>
                      <Input id="max-turns" type="number" min={0} className="h-8 w-32"
                        value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="run-seconds" className="text-xs">{tr("agentEditor.config.runSeconds")}</Label>
                      <Input id="run-seconds" type="number" min={0} className="h-8 w-32"
                        value={runSecs} onChange={(e) => setRunSecs(e.target.value)} />
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">{tr("agentEditor.config.llmProfile")}</Label>
                      <Select value={llmProfileId} onValueChange={setLlmProfileId}>
                        <SelectTrigger className="h-8 w-48"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="0">{tr("agentEditor.config.llmProfileGlobal")}</SelectItem>
                          {profiles.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}{p.is_default ? " ★" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}
                <Button size="sm" variant="outline" onClick={saveConfig}>
                  <SaveIcon /> {tr("agentEditor.config.saveConfig")}
                </Button>
              </div>
              {showWebSearch && (
                <div className="flex items-center gap-3 border-t pt-3">
                  <Switch
                    id="web-search"
                    checked={webSearch}
                    disabled={!webSearchGlobalOn}
                    onCheckedChange={setWebSearch}
                  />
                  <div className="grid gap-0.5">
                    <Label htmlFor="web-search" className="text-sm">{tr("agentEditor.config.webSearch")}</Label>
                    <span className="text-muted-foreground text-xs">
                      {webSearchGlobalOn
                        ? tr("agentEditor.config.webSearchOnHint")
                        : tr("agentEditor.config.webSearchOffHint")}
                    </span>
                  </div>
                </div>
              )}
              {showInteractiveShell && (
                <div className="flex items-center gap-3 border-t pt-3">
                  <Switch
                    id="interactive-shell"
                    checked={interactiveShell}
                    onCheckedChange={setInteractiveShell}
                  />
                  <div className="grid gap-0.5">
                    <Label htmlFor="interactive-shell" className="text-sm">{tr("agentEditor.config.interactiveShell")}</Label>
                    <span className="text-muted-foreground text-xs">
                      {tr("agentEditor.config.interactiveShellHint")}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="grid gap-2">
            <Label className="text-muted-foreground text-xs">{tr("agentEditor.vars.label")}</Label>
            <div className="flex flex-wrap gap-2">
              {variables.map((v) => (
                <Tooltip key={v.name}>
                  <TooltipTrigger asChild>
                    <button type="button" onClick={() => setPrompt((p) => `${p}{{.${v.name}}}`)}
                      className="hover:bg-muted inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs">
                      {`{{.${v.name}}}`}
                      <Badge variant="secondary" className="px-1 py-0 text-[10px]">{v.source}</Badge>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="font-medium">{v.description}</p>
                    <p className="text-muted-foreground mt-1">{tr("agentEditor.vars.example", { example: v.example })}</p>
                  </TooltipContent>
                </Tooltip>
              ))}
              {variables.length === 0 && <span className="text-muted-foreground text-xs">{tr("agentEditor.vars.none")}</span>}
            </div>
          </div>

          <Textarea className="font-mono text-xs" rows={16} value={prompt}
            placeholder={tr("agentEditor.prompt.placeholder")} onChange={(e) => setPrompt(e.target.value)} />

          <div className="flex flex-wrap gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" onClick={doPreview}>
                  <EyeIcon /> {tr("agentEditor.prompt.preview")}
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{tr("agentEditor.prompt.previewTitle")}</DialogTitle>
                  <DialogDescription>{tr("agentEditor.prompt.previewDesc", { placeholder: "{{.Var}}" })}</DialogDescription>
                </DialogHeader>
                <pre className="bg-muted max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md p-3 font-mono text-xs">
                  {preview}
                </pre>
              </DialogContent>
            </Dialog>
            <Button size="sm" onClick={savePrompt}>
              <SaveIcon /> {tr("agentEditor.prompt.saveNewVersion")}
            </Button>
            <Button variant="outline" size="sm" onClick={resetPrompt}>
              <RotateCcwIcon /> {tr("agentEditor.resetDefault")}
            </Button>
          </div>


          <Separator />
          <div className="grid gap-2">
            <Label className="text-muted-foreground text-xs">{tr("agentEditor.versions.label")}</Label>
            <ul className="grid gap-1">
              {versions.map((ver, i) => (
                <li key={ver.version} className="flex items-center gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-muted/50">
                  <span className="font-mono shrink-0">v{ver.version}</span>
                  {i === 0 && <Badge variant="secondary" className="px-1.5 py-0 shrink-0">{tr("agentEditor.versions.current")}</Badge>}
                  <span className="text-muted-foreground truncate flex-1">{ver.note}</span>
                  {ver.ts && (
                    <span className="text-muted-foreground/60 shrink-0 tabular-nums">
                      {new Date(ver.ts).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  )}
                  <Button variant="ghost" size="icon-sm" className="size-6 shrink-0" onClick={() => setViewVer(ver)}>
                    <EyeIcon className="size-3" />
                  </Button>
                  {i > 0 && versions[0] && (
                    <Button variant="ghost" size="icon-sm" className="size-6 shrink-0" onClick={() => setDiffVer(ver)}>
                      <GitCompareIcon className="size-3" />
                    </Button>
                  )}
                </li>
              ))}
              {versions.length === 0 && (
                <li className="text-muted-foreground text-xs">{tr("agentEditor.versions.empty")}</li>
              )}
            </ul>
          </div>

          {/* 查看版本 dialog */}
          <Dialog open={!!viewVer} onOpenChange={(o) => { if (!o) setViewVer(null); }}>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>
                  v{viewVer?.version}
                  {viewVer?.version === versions[0]?.version && (
                    <Badge variant="secondary" className="ml-2 px-1.5 py-0 align-middle">{tr("agentEditor.versions.current")}</Badge>
                  )}
                </DialogTitle>
                <DialogDescription>
                  {viewVer?.note || tr("agentEditor.versions.noNote")}
                  {viewVer?.ts && (
                    <span className="ml-2 text-muted-foreground/60">
                      {new Date(viewVer.ts).toLocaleString("zh-CN")}
                    </span>
                  )}
                </DialogDescription>
              </DialogHeader>
              <pre className="bg-muted max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-md p-3 font-mono text-xs">
                {viewVer?.template_text || tr("agentEditor.versions.emptyText")}
              </pre>
              <div className="flex gap-2 justify-end">
                {viewVer && viewVer.version !== versions[0]?.version && (
                  <Button variant="outline" size="sm" onClick={() => {
                    if (viewVer) { setDiffVer(viewVer); setViewVer(null); }
                  }}>
                    <GitCompareIcon className="mr-1 size-3.5" /> {tr("agentEditor.versions.diffWithCurrent")}
                  </Button>
                )}
                <Button size="sm" onClick={() => {
                  if (viewVer) { setPrompt(viewVer.template_text); setViewVer(null); toast.success(tr("agentEditor.toast.loadedToEditor", { version: viewVer.version })); }
                }}>
                  {tr("agentEditor.versions.loadToEditor")}
                </Button>
              </div>
            </DialogContent>
          </Dialog>

          {/* 版本对比 dialog */}
          <Dialog open={!!diffVer} onOpenChange={(o) => { if (!o) setDiffVer(null); }}>
            <DialogContent className="sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>{tr("agentEditor.versions.diffTitle", { from: diffVer?.version, to: versions[0]?.version })}</DialogTitle>
                <DialogDescription>
                  <span className="inline-flex items-center gap-3 text-xs">
                    <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-600 dark:text-red-400">{tr("agentEditor.diff.removed")}</span>
                    <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-green-600 dark:text-green-400">{tr("agentEditor.diff.added")}</span>
                  </span>
                </DialogDescription>
              </DialogHeader>
              <DiffView oldText={diffVer?.template_text ?? ""} newText={versions[0]?.template_text ?? ""} />
            </DialogContent>
          </Dialog>
        </div>
      </TabsContent>

      {/* 收尾提示词 */}
      <TabsContent value="wrapup" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid gap-3">
          <p className="text-muted-foreground text-xs leading-relaxed">
            {tr("agentEditor.wrapup.introPre")}
            <b>{tr("agentEditor.wrapup.introTimeout")}</b>
            {tr("agentEditor.wrapup.introOr")}
            <b>{tr("agentEditor.wrapup.introExhausted")}</b>
            {tr("agentEditor.wrapup.introPost")}
          </p>
          <div className="flex items-center gap-2">
            <Label className="text-xs">{tr("agentEditor.wrapup.bodyLabel")}</Label>
            {wrapup.trim() ? (
              <Badge variant="secondary" className="px-1.5 py-0">{tr("agentEditor.badge.custom")}</Badge>
            ) : (
              <Badge variant="outline" className="px-1.5 py-0">{tr("agentEditor.badge.builtinDefault")}</Badge>
            )}
          </div>
          <Textarea
            className="font-mono text-xs"
            rows={10}
            value={wrapup}
            placeholder={wrapupDefault || tr("agentEditor.wrapup.bodyPlaceholder")}
            onChange={(e) => setWrapup(e.target.value)}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="wrapup-turns" className="text-xs">
              {tr("agentEditor.wrapup.turnsLabel", { count: wrapupTurnsDefault })}
            </Label>
            <Input id="wrapup-turns" type="number" min={0} className="h-8 w-32"
              value={wrapupTurns} onChange={(e) => setWrapupTurns(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={saveWrapup}>{tr("common.save")}</Button>
            <Button size="sm" variant="outline" onClick={resetWrapup}>{tr("agentEditor.resetDefault")}</Button>
          </div>
          {wrapupDefault && (
            <>
              <Separator />
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground text-xs">{tr("agentEditor.builtinDefaultReadonly")}</Label>
                <pre className="text-muted-foreground max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-2 text-xs whitespace-pre-wrap">
                  {wrapupDefault}
                </pre>
              </div>
            </>
          )}

          {ttSupported && (
            <>
              <Separator className="my-2" />
              <p className="text-muted-foreground text-xs leading-relaxed">
                <b>{tr("agentEditor.tt.introTitle")}</b>{tr("agentEditor.tt.introRest")}
              </p>
              <div className="flex items-center gap-2">
                <Label className="text-xs">{tr("agentEditor.tt.bodyLabel")}</Label>
                {ttWrapup.trim() ? (
                  <Badge variant="secondary" className="px-1.5 py-0">{tr("agentEditor.badge.custom")}</Badge>
                ) : (
                  <Badge variant="outline" className="px-1.5 py-0">{tr("agentEditor.badge.builtinDefault")}</Badge>
                )}
              </div>
              <Textarea
                className="font-mono text-xs"
                rows={10}
                value={ttWrapup}
                placeholder={ttWrapupDefault || tr("agentEditor.tt.bodyPlaceholder")}
                onChange={(e) => setTtWrapup(e.target.value)}
              />
              <div className="grid gap-1.5">
                <Label htmlFor="tt-turns" className="text-xs">
                  {tr("agentEditor.tt.turnsLabel", { count: ttTurnsDefault })}
                </Label>
                <Input id="tt-turns" type="number" min={0} className="h-8 w-32"
                  value={ttTurns} onChange={(e) => setTtTurns(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveTaskTimeoutWrapup}>{tr("common.save")}</Button>
                <Button size="sm" variant="outline" onClick={resetTaskTimeoutWrapup}>{tr("agentEditor.resetDefault")}</Button>
              </div>
              {ttWrapupDefault && (
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground text-xs">{tr("agentEditor.builtinDefaultReadonly")}</Label>
                  <pre className="text-muted-foreground max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-2 text-xs whitespace-pre-wrap">
                    {ttWrapupDefault}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </TabsContent>

      {/* MCP 可见性 */}
      <TabsContent value="mcp" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <p className="text-muted-foreground mb-3 text-xs">{tr("agentEditor.mcp.hint")}</p>
        <div className="grid gap-2">
          {mcp.map((m) => (
            <label key={m.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <Checkbox checked={mcpVisible.includes(m.id)} onCheckedChange={() => toggleMcp(m.id)} />
              {m.name}
              <span className="text-muted-foreground ml-auto text-xs">{m.transport}</span>
            </label>
          ))}
          {mcp.length === 0 && <span className="text-muted-foreground text-xs">{tr("agentEditor.mcp.empty")}</span>}
        </div>
      </TabsContent>

      {/* Skill 可见性 */}
      <TabsContent value="skill" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <p className="text-muted-foreground mb-3 text-xs">{tr("agentEditor.skill.hint")}</p>
        <div className="grid gap-2">
          {skills.map((s) => (
            <label key={s.name} className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <Checkbox checked={skillVisible.includes(s.name)} onCheckedChange={() => toggleSkill(s.name)} />
              <span className="font-mono text-xs">{s.name}</span>
              {s.description && <span className="text-muted-foreground ml-auto truncate text-xs">{s.description}</span>}
            </label>
          ))}
          {skills.length === 0 && <span className="text-muted-foreground text-xs">{tr("agentEditor.skill.empty")}</span>}
        </div>
      </TabsContent>

      {/* Tools 绑定 */}
      <TabsContent value="tools" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <p className="text-muted-foreground mb-3 text-xs">{tr("agentEditor.tools.hint")}</p>
        <div className="grid gap-2">
          {tools.map((t) => {
            const isTraffic = TRAFFIC_TOOL_KEYS.has(t.key);
            const gated = isTraffic && !captureOn; // traffic tools need 流量捕获 on
            return (
              <label
                key={t.key}
                className={cn(
                  "flex items-center gap-2 rounded-md border p-2 text-sm",
                  gated && "opacity-60",
                )}
              >
                <Checkbox
                  checked={t.agents.includes(agentKey)}
                  disabled={gated}
                  onCheckedChange={() => toggleTool(t)}
                />
                <span className="font-mono text-xs">{t.key}</span>
                {isTraffic && (
                  <Badge variant="secondary" className="px-1 py-0 text-[9px]">{tr("agentEditor.tools.trafficBadge")}</Badge>
                )}
                {!t.enabled && (
                  <Badge variant="outline" className="text-destructive px-1 py-0 text-[9px]">{tr("agentEditor.disabledBadge")}</Badge>
                )}
                {gated ? (
                  <span className="text-muted-foreground ml-auto text-xs">{tr("agentEditor.tools.needCapture")}</span>
                ) : (
                  t.description && (
                    <span className="text-muted-foreground ml-auto line-clamp-1 max-w-[55%] text-xs">
                      {t.description}
                    </span>
                  )
                )}
              </label>
            );
          })}
          {tools.length === 0 && <span className="text-muted-foreground text-xs">{tr("agentEditor.tools.empty")}</span>}
        </div>
      </TabsContent>

      {/* 触发(P3, 仅自定义 agent) */}
      {isCustom && (
        <TabsContent value="triggers" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <AgentTriggersTab agentKey={agentKey} />
        </TabsContent>
      )}
    </Tabs>
  );
}

// ---------- Diff helpers ----------

type DiffLine = { type: "same" | "add" | "del"; text: string };

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const result: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: "same", text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "add", text: b[j - 1] });
      j--;
    } else {
      result.unshift({ type: "del", text: a[i - 1] });
      i--;
    }
  }
  return result;
}

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = React.useMemo(() => computeDiff(oldText, newText), [oldText, newText]);
  return (
    <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-5">
      {lines.map((l, idx) => (
        <div
          key={idx}
          className={cn(
            "whitespace-pre-wrap px-1",
            l.type === "del" && "bg-red-500/15 text-red-700 dark:text-red-400",
            l.type === "add" && "bg-green-500/15 text-green-700 dark:text-green-400",
            l.type === "same" && "text-muted-foreground",
          )}
        >
          <span className="select-none mr-1 opacity-50">{l.type === "del" ? "-" : l.type === "add" ? "+" : " "}</span>
          {l.text}
        </div>
      ))}
    </pre>
  );
}

// AgentTriggersTab manages a custom agent's P3 triggers: list + add + delete.
// Each trigger fires (定时/发现finding/目标达成，可多选) → a new conversation runs
// in parallel with the base user message + auto context appended by the backend.
function AgentTriggersTab({ agentKey }: { agentKey: string }) {
  const { t: tr } = useTranslation();
  const [triggers, setTriggers] = React.useState<AgentTrigger[]>([]);
  const [intervalSec, setIntervalSec] = React.useState("0");
  const [onFinding, setOnFinding] = React.useState(false);
  const [onGoalMet, setOnGoalMet] = React.useState(false);
  const [onTaskTimeout, setOnTaskTimeout] = React.useState(false);
  const [intervalMsg, setIntervalMsg] = React.useState("");
  const [findingMsg, setFindingMsg] = React.useState("");
  const [goalMsg, setGoalMsg] = React.useState("");
  const [taskTimeoutMsg, setTaskTimeoutMsg] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const reload = React.useCallback(() => {
    api.agentTriggers(agentKey).then(setTriggers).catch(() => setTriggers([]));
  }, [agentKey]);
  React.useEffect(() => {
    reload();
  }, [reload]);

  async function create() {
    const n = Math.max(0, Math.floor(Number(intervalSec) || 0));
    if (n === 0 && !onFinding && !onGoalMet && !onTaskTimeout) {
      toast.error(tr("agentEditor.triggers.errNoCondition"));
      return;
    }
    setSaving(true);
    try {
      await api.createTrigger(agentKey, {
        enabled: true,
        interval_sec: n,
        on_finding: onFinding,
        on_goal_met: onGoalMet,
        on_task_timeout: onTaskTimeout,
        interval_message: intervalMsg.trim(),
        finding_message: findingMsg.trim(),
        goal_message: goalMsg.trim(),
        task_timeout_message: taskTimeoutMsg.trim(),
      });
      toast.success(tr("agentEditor.triggers.added"));
      setIntervalSec("0");
      setOnFinding(false);
      setOnGoalMet(false);
      setOnTaskTimeout(false);
      setIntervalMsg("");
      setFindingMsg("");
      setGoalMsg("");
      setTaskTimeoutMsg("");
      reload();
    } catch (e) {
      toast.error(tr("agentEditor.triggers.addFailed", { msg: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }
  async function toggleEnabled(t: AgentTrigger) {
    try {
      await api.updateTrigger(t.id, {
        enabled: !t.enabled,
        interval_sec: t.interval_sec,
        on_finding: t.on_finding,
        on_goal_met: t.on_goal_met,
        on_task_timeout: t.on_task_timeout,
        interval_message: t.interval_message,
        finding_message: t.finding_message,
        goal_message: t.goal_message,
        task_timeout_message: t.task_timeout_message,
      });
      reload();
    } catch (e) {
      toast.error(tr("agentEditor.toast.saveFailed", { msg: (e as Error).message }));
    }
  }
  async function del(id: number) {
    try {
      await api.deleteTrigger(id);
      reload();
    } catch (e) {
      toast.error(tr("agentEditor.toast.deleteFailed", { msg: (e as Error).message }));
    }
  }

  function condLabel(t: AgentTrigger): string {
    const parts: string[] = [];
    if (t.interval_sec > 0) parts.push(tr("agentEditor.triggers.everyNs", { sec: t.interval_sec }));
    if (t.on_finding) parts.push(tr("agentEditor.triggers.condFinding"));
    if (t.on_goal_met) parts.push(tr("agentEditor.triggers.condGoalMet"));
    if (t.on_task_timeout) parts.push(tr("agentEditor.triggers.condTaskTimeout"));
    return parts.join(" · ") || tr("agentEditor.triggers.condNone");
  }

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-xs">
        {tr("agentEditor.triggers.introPre")}
        <b>{tr("agentEditor.triggers.introBold")}</b>
        {tr("agentEditor.triggers.introPost")}
      </p>

      {/* 新增触发器 */}
      <div className="grid gap-3 rounded-md border p-3">
        <Label className="text-muted-foreground text-xs">{tr("agentEditor.triggers.addLabel")}</Label>

        {/* 定时 */}
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <Label htmlFor="tr-interval" className="text-xs">{tr("agentEditor.triggers.intervalPrefix")}</Label>
            <Input id="tr-interval" type="number" min={0} className="h-8 w-24"
              value={intervalSec} onChange={(e) => setIntervalSec(e.target.value)} />
            <span className="text-muted-foreground text-xs">{tr("agentEditor.triggers.intervalSuffix")}</span>
          </div>
          {Number(intervalSec) > 0 && (
            <Textarea className="text-xs" rows={2} value={intervalMsg}
              placeholder={tr("agentEditor.triggers.intervalMsgPlaceholder")} onChange={(e) => setIntervalMsg(e.target.value)} />
          )}
        </div>

        {/* finding */}
        <div className="grid gap-1.5">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onFinding} onCheckedChange={(v) => setOnFinding(!!v)} /> {tr("agentEditor.triggers.onFindingLabel")}
          </label>
          {onFinding && (
            <Textarea className="text-xs" rows={2} value={findingMsg}
              placeholder={tr("agentEditor.triggers.findingMsgPlaceholder")} onChange={(e) => setFindingMsg(e.target.value)} />
          )}
        </div>

        {/* 目标达成 */}
        <div className="grid gap-1.5">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onGoalMet} onCheckedChange={(v) => setOnGoalMet(!!v)} /> {tr("agentEditor.triggers.onGoalMetLabel")}
          </label>
          {onGoalMet && (
            <Textarea className="text-xs" rows={2} value={goalMsg}
              placeholder={tr("agentEditor.triggers.goalMsgPlaceholder")} onChange={(e) => setGoalMsg(e.target.value)} />
          )}
        </div>

        {/* 任务超时 */}
        <div className="grid gap-1.5">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onTaskTimeout} onCheckedChange={(v) => setOnTaskTimeout(!!v)} /> {tr("agentEditor.triggers.onTaskTimeoutLabel")}
          </label>
          {onTaskTimeout && (
            <Textarea className="text-xs" rows={2} value={taskTimeoutMsg}
              placeholder={tr("agentEditor.triggers.taskTimeoutMsgPlaceholder")} onChange={(e) => setTaskTimeoutMsg(e.target.value)} />
          )}
        </div>

        <div>
          <Button size="sm" onClick={create} disabled={saving}>
            <SaveIcon /> {tr("agentEditor.triggers.addButton")}
          </Button>
        </div>
      </div>

      {/* 已有触发器 */}
      <div className="grid gap-2">
        <Label className="text-muted-foreground text-xs">{tr("agentEditor.triggers.existing")}</Label>
        {triggers.length === 0 && <span className="text-muted-foreground text-xs">{tr("agentEditor.triggers.none")}</span>}
        {triggers.map((t) => (
          <div key={t.id} className="flex items-start gap-2 rounded-md border p-2 text-sm">
            <Switch checked={t.enabled} onCheckedChange={() => toggleEnabled(t)} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{condLabel(t)}</span>
                {!t.enabled && (
                  <Badge variant="outline" className="text-destructive px-1 py-0 text-[9px]">{tr("agentEditor.disabledBadge")}</Badge>
                )}
              </div>
              <div className="text-muted-foreground grid gap-0.5 text-xs">
                {t.interval_sec > 0 && t.interval_message && <div className="line-clamp-1">{tr("agentEditor.triggers.rowInterval", { msg: t.interval_message })}</div>}
                {t.on_finding && t.finding_message && <div className="line-clamp-1">{tr("agentEditor.triggers.rowFinding", { msg: t.finding_message })}</div>}
                {t.on_goal_met && t.goal_message && <div className="line-clamp-1">{tr("agentEditor.triggers.rowGoal", { msg: t.goal_message })}</div>}
                {t.on_task_timeout && t.task_timeout_message && <div className="line-clamp-1">{tr("agentEditor.triggers.rowTimeout", { msg: t.task_timeout_message })}</div>}
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive"
              onClick={() => del(t.id)}>
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
