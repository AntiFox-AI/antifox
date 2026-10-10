"use client";

import * as React from "react";

import { Loader2Icon, PlugZapIcon, PlusIcon, RotateCcwIcon, SaveIcon, StarIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import type { LLMProfile, LLMPoolStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

// 思考强度档位（仅在开关打开时生效）。
const EFFORT_LEVELS: { value: string; labelKey: string }[] = [
  { value: "low", labelKey: "llm.effort.low" },
  { value: "medium", labelKey: "llm.effort.medium" },
  { value: "high", labelKey: "llm.effort.high" },
  { value: "max", labelKey: "llm.effort.max" },
];
// 思考模式三态 ↔ 存库字符串 reasoning_effort：
//   none→""（thinking / reasoning_effort 两个字段都【不发送】，兼容不支持该字段的模型，如 MiniMax）
//   off →"off"（发送 thinking:{type:disabled}，用于默认开启思考、需要显式关闭的模型）
//   on  →强度值（发送 thinking:{enabled} + reasoning_effort）
type ThinkMode = "none" | "off" | "on";
const THINK_MODES: { value: ThinkMode; labelKey: string }[] = [
  { value: "none", labelKey: "llm.thinkMode.none" },
  { value: "off", labelKey: "llm.thinkMode.off" },
  { value: "on", labelKey: "llm.thinkMode.on" },
];
const toStore = (mode: ThinkMode, effort: string) => (mode === "on" ? effort : mode === "off" ? "off" : "");
const modeFromStore = (v?: string): ThinkMode => (!v ? "none" : v === "off" ? "off" : "on");
const effortFromStore = (v?: string) => (v && v !== "off" ? v : "high");

function NewProfileDialog({ onCreated }: { onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [format, setFormat] = React.useState<"anthropic" | "openai">("anthropic");
  const [model, setModel] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [proxy, setProxy] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [rps, setRps] = React.useState("0");
  const [rpm, setRpm] = React.useState("0");
  const [cw, setCw] = React.useState("0");
  const [thinkMode, setThinkMode] = React.useState<ThinkMode>("none");
  const [effort, setEffort] = React.useState("high");

  function reset() {
    setName("");
    setFormat("anthropic");
    setModel("");
    setBaseUrl("");
    setProxy("");
    setApiKey("");
    setRps("0");
    setRpm("0");
    setCw("0");
    setThinkMode("none");
    setEffort("high");
  }

  async function create() {
    if (!name.trim() || !model.trim()) {
      toast.error(t("llm.toast.fillNameModel"));
      return;
    }
    try {
      const { id } = await api.saveLLMProfile({
        name: name.trim(),
        format,
        model: model.trim(),
        base_url: baseUrl.trim(),
        proxy: proxy.trim(),
        api_key: apiKey,
        rate_per_second: Number(rps) || 0,
        rate_per_minute: Number(rpm) || 0,
        context_window_k: Number(cw) || 0,
        reasoning_effort: toStore(thinkMode, effort),
      });
      toast.success(t("llm.toast.created", { name: name.trim() }));
      reset();
      setOpen(false);
      onCreated(String(id));
    } catch (e) {
      toast.error(t("llm.toast.createFailed", { msg: (e as Error).message }));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <PlusIcon /> {t("llm.new")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("llm.newProfile")}</DialogTitle>
          <DialogDescription>{t("llm.newProfileDesc")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="np-name">{t("common.name")}</Label>
            <Input
              id="np-name"
              placeholder={t("llm.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>{t("llm.format")}</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as "anthropic" | "openai")}>
                <SelectTrigger>
                  <SelectValue placeholder={t("llm.selectFormat")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-model">{t("llm.model")}</Label>
              <Input
                id="np-model"
                className="font-mono"
                placeholder="claude-opus-4-8"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="np-base-url">{t("llm.baseUrlLabel")}</Label>
            <Input
              id="np-base-url"
              className="font-mono"
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="np-proxy">{t("llm.proxyLabel")}</Label>
            <Input
              id="np-proxy"
              className="font-mono"
              placeholder="http://127.0.0.1:8080 · socks5://127.0.0.1:1080"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="np-api-key">API Key</Label>
            <Input
              id="np-api-key"
              type="password"
              placeholder="sk-…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="np-rps">{t("llm.ratePerSecond")}</Label>
              <Input id="np-rps" type="number" min={0} value={rps} onChange={(e) => setRps(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-rpm">{t("llm.ratePerMinute")}</Label>
              <Input id="np-rpm" type="number" min={0} value={rpm} onChange={(e) => setRpm(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-cw">{t("llm.contextWindowShort")}</Label>
              <Input
                id="np-cw"
                type="number"
                min={0}
                max={1000}
                value={cw}
                onChange={(e) => setCw(e.target.value)}
                placeholder="200"
              />
            </div>
          </div>
          <div className="grid gap-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-4">
              <div className="grid gap-0.5">
                <Label className="text-sm">{t("llm.thinkingTitle")}</Label>
                <p className="text-muted-foreground text-xs">{t("llm.thinkingDesc")}</p>
              </div>
              <Select value={thinkMode} onValueChange={(v) => setThinkMode(v as ThinkMode)}>
                <SelectTrigger className="w-32 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THINK_MODES.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {t(o.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {thinkMode === "on" && (
              <div className="flex items-center justify-between gap-4 border-t pt-3">
                <div className="grid gap-0.5">
                  <Label className="text-sm">{t("llm.effortTitle")}</Label>
                  <p className="text-muted-foreground text-xs">{t("llm.effortDesc")}</p>
                </div>
                <Select value={effort} onValueChange={setEffort}>
                  <SelectTrigger className="w-28 shrink-0">
                    <SelectValue placeholder={t("llm.effortPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {EFFORT_LEVELS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {t(o.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("common.cancel")}</Button>
          </DialogClose>
          <Button onClick={create}>{t("llm.new")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function LLMPage() {
  const { t } = useTranslation();
  const [profiles, setProfiles] = React.useState<LLMProfile[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [format, setFormat] = React.useState<"anthropic" | "openai">("anthropic");
  const [name, setName] = React.useState("");
  const [model, setModel] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [proxy, setProxy] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [keyHint, setKeyHint] = React.useState("");
  const [rps, setRps] = React.useState("0");
  const [rpm, setRpm] = React.useState("0");
  const [cw, setCw] = React.useState("0"); // 上下文窗口(K tokens);0=默认200K
  const [thinkMode, setThinkMode] = React.useState<ThinkMode>("none");
  const [effort, setEffort] = React.useState("high");
  const [testing, setTesting] = React.useState(false);

  const [pool, setPool] = React.useState<LLMPoolStatus | null>(null);
  const [poolBusy, setPoolBusy] = React.useState(false);
  const [roles, setRoles] = React.useState<{ role: string; profile_id: string }[]>([]);
  const loadPool = React.useCallback(async () => {
    try {
      setPool(await api.llmPool());
    } catch {
      /* ignore */
    }
  }, []);
  const loadRoles = React.useCallback(async () => {
    try {
      setRoles(await api.llmRoles());
    } catch {
      /* ignore */
    }
  }, []);
  const load = React.useCallback(async () => {
    try {
      const ps = await api.llmProfiles();
      setProfiles(ps);
      setSelectedId((prev) => {
        if (prev && ps.some((p) => p.id === prev)) return prev;
        return ps.find((p) => p.is_default)?.id ?? ps[0]?.id ?? null;
      });
    } catch {
      /* ignore */
    }
    void loadPool();
    void loadRoles();
  }, [loadPool, loadRoles]);
  async function setRole(role: string, profileId: string) {
    try {
      await api.setLLMRole(role, profileId);
      await loadRoles();
      toast.success(t("llm.roles.saved"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  React.useEffect(() => {
    void load();
  }, [load]);

  async function togglePool(on: boolean) {
    setPoolBusy(true);
    try {
      await api.setLLMPool(on);
      await loadPool();
      toast.success(on ? t("llm.pool.enabled") : t("llm.pool.disabled"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPoolBusy(false);
    }
  }
  async function resetBreaker(profileId?: string) {
    try {
      await api.resetLLMPool(profileId);
      await loadPool();
      toast.success(t("llm.pool.resetDone"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function setProfilePool(id: string, priority: number, exclude: boolean) {
    try {
      await api.setProfilePool(id, priority, exclude);
      await Promise.all([load(), loadPool()]);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // Fill the editor from the selected profile. Runs only on explicit reloads /
  // selection changes (this page does not poll), so it never clobbers edits.
  const selected = React.useMemo(() => profiles.find((p) => p.id === selectedId) ?? null, [profiles, selectedId]);
  React.useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setFormat(selected.format === "anthropic" ? "anthropic" : "openai");
    setModel(selected.model);
    setBaseUrl(selected.base_url ?? "");
    setProxy(selected.proxy ?? "");
    setRps(String(selected.rate_per_second ?? 0));
    setRpm(String(selected.rate_per_minute ?? 0));
    setCw(String(selected.context_window_k ?? 0));
    setThinkMode(modeFromStore(selected.reasoning_effort));
    setEffort(effortFromStore(selected.reasoning_effort));
    setApiKey("");
    setKeyHint(selected.api_key_hint ?? "");
  }, [selected]);

  async function testConnection() {
    if (testing) return;
    setTesting(true);
    try {
      // test with the SAME thinking params the profile will run with, so an
      // unsupported reasoning field fails here instead of only at run time.
      // 传当前选中 profile 的 id：输入框留空时，后端用该 profile 已存的 key 测试。
      const r = await api.testLLM(
        format,
        model,
        baseUrl,
        apiKey,
        proxy,
        toStore(thinkMode, effort),
        selectedId ? Number(selectedId) : undefined,
      );
      if (r.ok) toast.success(t("llm.toast.connectOk", { latency: r.latency_ms ?? "?", model: r.model ?? model }));
      else toast.error(t("llm.toast.connectFailed", { error: r.error ?? t("llm.unknown") }));
    } catch (e) {
      toast.error(t("llm.toast.testError", { msg: (e as Error).message }));
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!selectedId) {
      toast.error(t("llm.toast.selectOrCreate"));
      return;
    }
    if (!name.trim() || !model.trim()) {
      toast.error(t("llm.toast.fillNameModel"));
      return;
    }
    try {
      await api.saveLLMProfile({
        id: Number(selectedId),
        name: name.trim(),
        format,
        model: model.trim(),
        base_url: baseUrl.trim(),
        proxy: proxy.trim(),
        api_key: apiKey,
        rate_per_second: Number(rps) || 0,
        rate_per_minute: Number(rpm) || 0,
        context_window_k: Number(cw) || 0,
        reasoning_effort: toStore(thinkMode, effort),
      });
      toast.success(selected?.is_default ? t("llm.toast.savedActive") : t("llm.toast.saved"));
      setApiKey("");
      await load();
    } catch (e) {
      toast.error(t("llm.toast.saveFailed", { msg: (e as Error).message }));
    }
  }

  async function activate(id: string) {
    try {
      await api.activateLLMProfile(id);
      const p = profiles.find((x) => x.id === id);
      toast.success(t("llm.toast.activated", { name: p?.name ?? id }));
      await load();
    } catch (e) {
      toast.error(t("llm.toast.activateFailed", { msg: (e as Error).message }));
    }
  }

  async function remove(p: LLMProfile) {
    if (p.is_default) {
      toast.error(t("llm.toast.cannotDeleteActive"));
      return;
    }
    try {
      await api.deleteLLMProfile(p.id);
      toast.success(t("llm.toast.deleted", { name: p.name }));
      await load();
    } catch (e) {
      toast.error(t("llm.toast.deleteFailed", { msg: (e as Error).message }));
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4 md:gap-6">
      <div>
        <h1 className="font-semibold text-xl tracking-tight">LLM</h1>
        <p className="text-muted-foreground text-sm">{t("llm.subtitle")}</p>
      </div>
      <div className="flex flex-1 flex-col gap-4 md:gap-6">
        {/* LLM 故障转移(轮询)：无规则命中的额度耗尽/坏网络时自动切下一个配置 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {t("llm.pool.title")}
              {pool?.enabled && (
                <Badge variant="outline" className="border-emerald-400/50 text-emerald-600">
                  {t("llm.pool.on")}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>{t("llm.pool.desc")}</CardDescription>
            <CardAction>
              <Switch checked={!!pool?.enabled} disabled={poolBusy} onCheckedChange={togglePool} />
            </CardAction>
          </CardHeader>
          <CardContent>
            {(pool?.chain?.length ?? 0) < 2 ? (
              <p className="text-sm text-muted-foreground">{t("llm.pool.needTwo")}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {pool!.chain.map((m, i) => (
                  <div
                    key={m.profile_id}
                    className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <span className="w-5 text-center font-mono text-xs text-muted-foreground">{i + 1}</span>
                    <span className="font-medium">{m.name}</span>
                    <span className="text-xs text-muted-foreground">{m.model}</span>
                    {m.active && (
                      <Badge variant="outline" className="border-amber-400/50 text-amber-500">
                        {t("llm.pool.active")}
                      </Badge>
                    )}
                    {m.excluded && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("llm.pool.excluded")}
                      </Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={cn(
                        m.state === "tripped"
                          ? "border-red-400/50 text-red-500"
                          : m.state === "degraded"
                            ? "border-amber-400/50 text-amber-500"
                            : "border-emerald-400/50 text-emerald-600",
                      )}
                    >
                      {t(`llm.pool.state_${m.state}`)}
                    </Badge>
                    {m.state === "tripped" && (
                      <span className="text-xs text-red-500">
                        {t("llm.pool.cooldown", { s: m.cooldown_secs })}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-3">
                      {!m.active && (
                        <label className="flex items-center gap-1 text-xs text-muted-foreground">
                          {t("llm.pool.priority")}
                          <Input
                            type="number"
                            defaultValue={m.priority}
                            className="h-7 w-16"
                            onBlur={(e) => setProfilePool(m.profile_id, Number(e.target.value) || 0, m.excluded)}
                          />
                        </label>
                      )}
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {t("llm.pool.exclude")}
                        <Switch checked={m.excluded} onCheckedChange={(v) => setProfilePool(m.profile_id, m.priority, v)} />
                      </label>
                      {m.state !== "ok" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => resetBreaker(m.profile_id)}
                          title={t("llm.pool.reset")}
                        >
                          <RotateCcwIcon className="size-3.5" />
                        </Button>
                      )}
                    </div>
                    {m.last_error && m.state !== "ok" && (
                      <span
                        className="w-full truncate text-[11px] text-muted-foreground"
                        title={m.last_error}
                      >
                        {m.last_error}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        {/* LLM 角色分工：各角色映射到某配置，各家 LLM 合理分工 */}
        <Card>
          <CardHeader>
            <CardTitle>{t("llm.roles.title")}</CardTitle>
            <CardDescription>{t("llm.roles.desc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2">
              {roles.map((r) => (
                <div key={r.role} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 text-sm font-medium">{t(`llm.roles.role_${r.role}`)}</span>
                  <Select value={r.profile_id} onValueChange={(v) => setRole(r.role, v)}>
                    <SelectTrigger className="h-8 flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">{t("llm.roles.followActive")}</SelectItem>
                      {profiles.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}{p.is_default ? " ★" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
          <Card className="lg:order-2 lg:col-span-2">
            <CardHeader>
              <CardTitle>
                {selected ? (
                  <span className="flex items-center gap-2">
                    {t("llm.editProfile", { name: selected.name })}
                    {selected.is_default && (
                      <Badge variant="outline" className="border-amber-400/50 text-amber-500">
                        {t("llm.active")}
                      </Badge>
                    )}
                  </span>
                ) : (
                  t("llm.formatConfig")
                )}
              </CardTitle>
              <CardDescription>
                {selected ? t("llm.editDescSelected") : t("llm.editDescEmpty")}
              </CardDescription>
            </CardHeader>
            {selected ? (
              <CardContent className="grid gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="name">{t("common.name")}</Label>
                    <Input
                      id="name"
                      placeholder={t("llm.profileNamePlaceholder")}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>{t("llm.format")}</Label>
                    <Select value={format} onValueChange={(v) => setFormat(v as "anthropic" | "openai")}>
                      <SelectTrigger>
                        <SelectValue placeholder={t("llm.selectFormat")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="anthropic">Anthropic</SelectItem>
                        <SelectItem value="openai">OpenAI</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="model">{t("llm.model")}</Label>
                  <Input
                    id="model"
                    className="font-mono"
                    placeholder="claude-opus-4-8"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="base-url">{t("llm.baseUrlLabel")}</Label>
                  <Input
                    id="base-url"
                    className="font-mono"
                    placeholder="https://api.openai.com/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="proxy">{t("llm.proxyLabel")}</Label>
                  <Input
                    id="proxy"
                    className="font-mono"
                    placeholder="http://127.0.0.1:8080 · socks5://127.0.0.1:1080"
                    value={proxy}
                    onChange={(e) => setProxy(e.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">{t("llm.proxyDesc")}</p>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="api-key">API Key</Label>
                  <Input
                    id="api-key"
                    type="password"
                    placeholder={keyHint ? t("llm.keySetHint", { hint: keyHint }) : "sk-…"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="rps">{t("llm.ratePerSecond")}</Label>
                    <Input id="rps" type="number" min={0} value={rps} onChange={(e) => setRps(e.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="rpm">{t("llm.ratePerMinute")}</Label>
                    <Input id="rpm" type="number" min={0} value={rpm} onChange={(e) => setRpm(e.target.value)} />
                    <p className="text-muted-foreground text-xs">{t("llm.noLimit")}</p>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="cw">{t("llm.contextWindow")}</Label>
                  <Input
                    id="cw"
                    type="number"
                    min={0}
                    max={1000}
                    value={cw}
                    onChange={(e) => setCw(e.target.value)}
                    placeholder="200"
                  />
                  <p className="text-muted-foreground text-xs">{t("llm.contextWindowDesc")}</p>
                </div>

                <div className="grid gap-3 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="grid gap-0.5">
                      <Label className="text-sm">{t("llm.thinkingTitle")}</Label>
                      <p className="text-muted-foreground text-xs">{t("llm.thinkingDesc")}</p>
                    </div>
                    <Select value={thinkMode} onValueChange={(v) => setThinkMode(v as ThinkMode)}>
                      <SelectTrigger className="w-32 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {THINK_MODES.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {t(o.labelKey)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {thinkMode === "on" && (
                    <div className="flex items-center justify-between gap-4 border-t pt-3">
                      <div className="grid gap-0.5">
                        <Label className="text-sm">{t("llm.effortTitle")}</Label>
                        <p className="text-muted-foreground text-xs">{t("llm.effortDescFull")}</p>
                      </div>
                      <Select value={effort} onValueChange={setEffort}>
                        <SelectTrigger className="w-28 shrink-0">
                          <SelectValue placeholder={t("llm.effortPlaceholder")} />
                        </SelectTrigger>
                        <SelectContent>
                          {EFFORT_LEVELS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {t(o.labelKey)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                <Separator />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={testConnection} disabled={testing}>
                    {testing ? <Loader2Icon className="animate-spin" /> : <PlugZapIcon />}
                    {testing ? t("llm.testing") : t("llm.testConnection")}
                  </Button>
                  <Button onClick={save}>
                    <SaveIcon /> {t("common.save")}
                  </Button>
                </div>
              </CardContent>
            ) : (
              <CardContent>
                <div className="flex items-center justify-center rounded-lg border border-dashed py-16 text-muted-foreground text-sm">
                  {t("llm.noProfileEditor")}
                </div>
              </CardContent>
            )}
          </Card>

          <Card className="lg:order-1">
            <CardHeader className="has-data-[slot=card-action]:grid-cols-[1fr_auto]">
              <CardTitle>Profiles</CardTitle>
              <CardDescription>{t("llm.profilesDesc")}</CardDescription>
              <CardAction className="self-center">
                <NewProfileDialog
                  onCreated={(id) => {
                    setSelectedId(id);
                    void load();
                  }}
                />
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-3">
              {profiles.map((p) => (
                // biome-ignore lint/a11y/useSemanticElements: row wraps its own action buttons, so a native <button> would nest buttons (invalid HTML)
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedId(p.id);
                    }
                  }}
                  aria-pressed={p.id === selectedId}
                  className={cn(
                    "cursor-pointer rounded-lg border p-3 text-left outline-none transition-colors",
                    p.is_default && "border-amber-400/50 bg-amber-400/5",
                    p.id === selectedId ? "ring-2 ring-primary" : "hover:border-foreground/30",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <StarIcon
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        p.is_default ? "fill-amber-400 text-amber-400" : "text-muted-foreground",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-sm">{p.name}</span>
                        <Badge variant="outline" className="uppercase">
                          {p.format}
                        </Badge>
                      </div>
                      <code className="mt-1 block truncate font-mono text-muted-foreground text-xs">{p.model}</code>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
                        <span>{p.api_key_hint}</span>
                        <span>
                          {p.rate_per_second}/s · {p.rate_per_minute}/min
                        </span>
                        {p.proxy && <span className="truncate">{t("llm.proxyShort", { proxy: p.proxy })}</span>}
                        {p.reasoning_effort && (
                          <span>
                            {t("llm.thinkingShort")} {p.reasoning_effort === "off" ? t("llm.off") : p.reasoning_effort}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      disabled={p.is_default}
                      onClick={(e) => {
                        e.stopPropagation();
                        void activate(p.id);
                      }}
                    >
                      {p.is_default ? t("llm.activated") : t("llm.setActive")}
                    </Button>
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label={t("llm.deleteProfile")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(p);
                      }}
                    >
                      <Trash2Icon className="text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
              {profiles.length === 0 && (
                <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
                  {t("llm.noProfile")}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
