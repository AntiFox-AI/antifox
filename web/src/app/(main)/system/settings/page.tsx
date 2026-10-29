"use client";

import * as React from "react";

import { CpuIcon, RadioTowerIcon, SearchIcon } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { UpdateCard } from "@/app/(main)/system/settings/_components/update-card";
import { api } from "@/lib/api";
import type { Settings } from "@/lib/types";

export default function SystemSettingsPage() {
  const { t } = useTranslation();
  const [trafficCapture, setTrafficCapture] = React.useState(false);
  const [webSearch, setWebSearch] = React.useState(false);
  const [backend, setBackend] = React.useState("ddgs");
  const [braveKeySet, setBraveKeySet] = React.useState(false);
  const [braveKeyInput, setBraveKeyInput] = React.useState("");
  const [tavilyKeySet, setTavilyKeySet] = React.useState(false);
  const [tavilyKeyInput, setTavilyKeyInput] = React.useState("");
  const [savingTavilyKey, setSavingTavilyKey] = React.useState(false);
  const [proxyInput, setProxyInput] = React.useState("");
  const [savingProxy, setSavingProxy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [savingKey, setSavingKey] = React.useState(false);
  const [pyInterp, setPyInterp] = React.useState("");
  const [workers, setWorkers] = React.useState("3");
  const [savingWorkers, setSavingWorkers] = React.useState(false);

  const apply = React.useCallback((s: Settings) => {
    setTrafficCapture(!!s.traffic_capture);
    setWebSearch(!!s.web_search_enabled);
    setBackend(s.web_search_backend || "ddgs");
    setBraveKeySet(!!s.brave_key_set);
    setTavilyKeySet(!!s.tavily_key_set);
    setProxyInput(s.web_search_proxy || "");
    setPyInterp(s.python_interpreter || "");
    setWorkers(String(s.workers ?? 3));
  }, []);

  const saveWorkers = () => {
    const n = Number(workers);
    if (!Number.isInteger(n) || n <= 0) {
      toast.error(t("settings.workers.errInvalid"));
      return;
    }
    setSavingWorkers(true);
    api
      .setSettings({ workers: n })
      .then((s) => {
        apply(s);
        toast.success(t("settings.workers.saved"));
      })
      .catch((e) => toast.error(t("settings.saveFailed", { msg: (e as Error).message })))
      .finally(() => setSavingWorkers(false));
  };

  const savePython = () => {
    setSaving(true);
    api
      .setSettings({ python_interpreter: pyInterp.trim() })
      .then((s) => {
        apply(s);
        toast.success(t("settings.python.saved"));
      })
      .catch((e) => toast.error(t("settings.saveFailed", { msg: (e as Error).message })))
      .finally(() => setSaving(false));
  };
  const detectPython = () => {
    setSaving(true);
    api.detectPython().then((r) => setPyInterp(r.python_interpreter)).catch(() => undefined).finally(() => setSaving(false));
  };

  React.useEffect(() => {
    api
      .settings()
      .then(apply)
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [apply]);

  const toggleTraffic = (v: boolean) => {
    setTrafficCapture(v); // optimistic
    setSaving(true);
    api
      .setSettings({ traffic_capture: v })
      .then(apply)
      .catch(() => setTrafficCapture(!v)) // revert on failure
      .finally(() => setSaving(false));
  };

  // Persist a web-search patch (enable and/or backend). Optimistic with refetch.
  const saveWebSearch = (patch: Partial<Settings>) => {
    setSaving(true);
    api
      .setSettings(patch)
      .then((s) => {
        apply(s);
        toast.success(t("settings.webSearch.saved"));
      })
      .catch((e) => {
        toast.error(t("settings.saveFailed", { msg: (e as Error).message }));
        api
          .settings()
          .then(apply)
          .catch(() => undefined);
      })
      .finally(() => setSaving(false));
  };

  const saveBraveKey = () => {
    setSavingKey(true);
    api
      .setSettings({ brave_search_api_key: braveKeyInput })
      .then((s) => {
        apply(s);
        setBraveKeyInput("");
        toast.success(t("settings.webSearch.braveSaved"));
      })
      .catch((e) => toast.error(t("settings.saveFailed", { msg: (e as Error).message })))
      .finally(() => setSavingKey(false));
  };

  const saveTavilyKey = () => {
    setSavingTavilyKey(true);
    api
      .setSettings({ tavily_search_api_key: tavilyKeyInput })
      .then((s) => {
        apply(s);
        setTavilyKeyInput("");
        toast.success(t("settings.webSearch.tavilySaved"));
      })
      .catch((e) => toast.error(t("settings.saveFailed", { msg: (e as Error).message })))
      .finally(() => setSavingTavilyKey(false));
  };

  const saveProxy = () => {
    setSavingProxy(true);
    api
      .setSettings({ web_search_proxy: proxyInput.trim() })
      .then((s) => {
        apply(s);
        toast.success(proxyInput.trim() ? t("settings.webSearch.proxySaved") : t("settings.webSearch.proxyCleared"));
      })
      .catch((e) => toast.error(t("settings.saveFailed", { msg: (e as Error).message })))
      .finally(() => setSavingProxy(false));
  };

  // Run a real "test" search ("test") against the CURRENT form values (backend +
  // proxy + entered key), falling back to saved values server-side. Toasts result.
  const runTest = () => {
    setTesting(true);
    api
      .testWebSearch({
        web_search_backend: backend,
        web_search_proxy: proxyInput.trim(),
        brave_search_api_key: braveKeyInput,
        tavily_search_api_key: tavilyKeyInput,
      })
      .then((r) => {
        if (r.ok) toast.success(t("settings.webSearch.testOk", { backend: r.backend, count: r.count }));
        else toast.error(t("settings.webSearch.testFailed", { msg: r.error || t("settings.webSearch.unknownError") }));
      })
      .catch((e) => toast.error(t("settings.webSearch.testFailed", { msg: (e as Error).message })))
      .finally(() => setTesting(false));
  };

  // brave-free selected but no key stored and none being entered → tool stays off.
  const braveNeedsKey = webSearch && backend === "brave-free" && !braveKeySet;

  return (
    <div className="flex flex-1 flex-col gap-4 md:gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("settings.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("settings.subtitle")}</p>
      </div>

      <UpdateCard />

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RadioTowerIcon className="size-4" />
            {t("settings.traffic.title")}
          </CardTitle>
          <CardDescription>
            {t("settings.traffic.desc1")}
            <br />
            <Trans i18nKey="settings.traffic.desc2" components={{ b: <b /> }} />
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <Label htmlFor="traffic-capture" className="text-sm font-normal text-muted-foreground">
            {trafficCapture ? t("settings.traffic.on") : t("settings.traffic.off")}
          </Label>
          <Switch
            id="traffic-capture"
            checked={trafficCapture}
            disabled={!loaded || saving}
            onCheckedChange={toggleTraffic}
          />
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SearchIcon className="size-4" />
            {t("settings.webSearch.title")}
          </CardTitle>
          <CardDescription>
            <Trans i18nKey="settings.webSearch.desc1" components={{ b: <b /> }} />
            <br />
            <Trans i18nKey="settings.webSearch.desc2" components={{ b: <b /> }} />
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="web-search" className="text-sm font-normal text-muted-foreground">
              {webSearch ? t("settings.webSearch.on") : t("settings.webSearch.off")}
            </Label>
            <Switch
              id="web-search"
              checked={webSearch}
              disabled={!loaded || saving}
              onCheckedChange={(v) => {
                setWebSearch(v); // optimistic
                saveWebSearch({ web_search_enabled: v });
              }}
            />
          </div>

          {webSearch && (
            <div className="flex items-center justify-between gap-4">
              <Label className="text-sm font-normal text-muted-foreground">{t("settings.webSearch.source")}</Label>
              <Select
                value={backend}
                disabled={!loaded || saving}
                onValueChange={(v) => {
                  setBackend(v); // optimistic
                  saveWebSearch({ web_search_backend: v });
                }}
              >
                <SelectTrigger className="w-48 shrink-0">
                  <SelectValue placeholder={t("settings.webSearch.selectSource")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ddgs">{t("settings.webSearch.sourceDdgs")}</SelectItem>
                  <SelectItem value="brave-free">{t("settings.webSearch.sourceBrave")}</SelectItem>
                  <SelectItem value="tavily">{t("settings.webSearch.sourceTavily")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {webSearch && backend === "brave-free" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="brave-key" className="text-sm font-normal text-muted-foreground">
                Brave Search API Key
                {braveKeySet && <span className="ml-2 text-xs text-emerald-500">{t("settings.webSearch.keySet")}</span>}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="brave-key"
                  type="password"
                  autoComplete="off"
                  placeholder={braveKeySet ? t("settings.webSearch.keySetPlaceholder") : t("settings.webSearch.braveKeyPlaceholder")}
                  value={braveKeyInput}
                  disabled={!loaded || savingKey}
                  onChange={(e) => setBraveKeyInput(e.target.value)}
                />
                <Button
                  type="button"
                  onClick={saveBraveKey}
                  disabled={!loaded || savingKey || braveKeyInput.trim() === ""}
                >
                  {t("common.save")}
                </Button>
              </div>
              {braveNeedsKey && (
                <p className="text-xs text-amber-500">
                  {t("settings.webSearch.braveNeedsKey")}
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                {t("settings.webSearch.braveHint")}
              </p>
            </div>
          )}

          {webSearch && backend === "tavily" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="tavily-key" className="text-sm font-normal text-muted-foreground">
                Tavily Search API Key
                {tavilyKeySet && <span className="ml-2 text-xs text-emerald-500">{t("settings.webSearch.keySet")}</span>}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="tavily-key"
                  type="password"
                  autoComplete="off"
                  placeholder={tavilyKeySet ? t("settings.webSearch.keySetPlaceholder") : t("settings.webSearch.tavilyKeyPlaceholder")}
                  value={tavilyKeyInput}
                  disabled={!loaded || savingTavilyKey}
                  onChange={(e) => setTavilyKeyInput(e.target.value)}
                />
                <Button
                  type="button"
                  onClick={saveTavilyKey}
                  disabled={!loaded || savingTavilyKey || tavilyKeyInput.trim() === ""}
                >
                  {t("common.save")}
                </Button>
              </div>
              {webSearch && backend === "tavily" && !tavilyKeySet && (
                <p className="text-xs text-amber-500">
                  {t("settings.webSearch.tavilyNeedsKey")}
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                {t("settings.webSearch.tavilyHint")}
              </p>
            </div>
          )}

          {webSearch && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="ws-proxy" className="text-sm font-normal text-muted-foreground">
                {t("settings.webSearch.proxyLabel")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="ws-proxy"
                  autoComplete="off"
                  placeholder={t("settings.webSearch.proxyPlaceholder")}
                  value={proxyInput}
                  disabled={!loaded || savingProxy}
                  onChange={(e) => setProxyInput(e.target.value)}
                />
                <Button type="button" onClick={saveProxy} disabled={!loaded || savingProxy}>
                  {t("common.save")}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                {t("settings.webSearch.proxyHint")}
              </p>
            </div>
          )}

          {webSearch && (
            <div className="flex items-center justify-between gap-4 border-t pt-4">
              <p className="text-muted-foreground text-xs">
                {t("settings.webSearch.testHint")}
              </p>
              <Button type="button" variant="outline" onClick={runTest} disabled={!loaded || testing} className="shrink-0">
                {testing ? t("settings.webSearch.testing") : t("settings.webSearch.testButton")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RadioTowerIcon className="size-4" />
            {t("settings.python.title")}
          </CardTitle>
          <CardDescription>
            <Trans i18nKey="settings.python.desc" components={{ b: <b /> }} />
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Input
              className="font-mono text-sm"
              placeholder={t("settings.python.placeholder")}
              value={pyInterp}
              disabled={!loaded || saving}
              onChange={(e) => setPyInterp(e.target.value)}
            />
            <Button variant="outline" onClick={detectPython} disabled={!loaded || saving}>
              {t("settings.python.detect")}
            </Button>
            <Button onClick={savePython} disabled={!loaded || saving}>
              {t("common.save")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CpuIcon className="size-4" />
            {t("settings.workers.title")}
          </CardTitle>
          <CardDescription>
            <Trans i18nKey="settings.workers.desc" components={{ b: <b /> }} />
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              className="w-32 font-mono text-sm"
              placeholder="3"
              value={workers}
              disabled={!loaded || savingWorkers}
              onChange={(e) => setWorkers(e.target.value)}
            />
            <Button onClick={saveWorkers} disabled={!loaded || savingWorkers}>
              {t("common.save")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
