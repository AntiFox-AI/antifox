"use client";

import * as React from "react";

import { AlertTriangleIcon, CheckCircle2Icon, DownloadIcon, Loader2Icon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import type { UpdateCheck, UpdateProgress } from "@/lib/types";

function humanSize(n?: number): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function UpdateCard() {
  const { t } = useTranslation();
  const [info, setInfo] = React.useState<UpdateCheck | null>(null);
  const [checking, setChecking] = React.useState(true);
  const [progress, setProgress] = React.useState<UpdateProgress | null>(null);
  const [busy, setBusy] = React.useState(false); // apply/rollback in flight
  const [restarting, setRestarting] = React.useState(false);
  const esRef = React.useRef<EventSource | null>(null);

  const check = React.useCallback(
    async (force: boolean) => {
      setChecking(true);
      try {
        const r = await api.updateCheck(force);
        setInfo(r);
        if (force) {
          if (r.error) toast.error(t("update.checkFailed", { msg: r.error }));
          else if (r.has_update) toast.success(t("update.foundNew", { version: r.latest }));
          else if (r.comparable) toast.success(t("update.upToDate"));
        }
      } catch (e) {
        if (force) toast.error(t("update.checkFailed", { msg: (e as Error).message }));
      } finally {
        setChecking(false);
      }
    },
    [t],
  );

  React.useEffect(() => {
    check(false);
    return () => esRef.current?.close();
  }, [check]);

  // Poll /api/health until the reported version changes (the swap completed), then reload.
  const waitForRestart = React.useCallback(
    async (prevVersion: string) => {
      setRestarting(true);
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await sleep(2000);
        try {
          const r = await fetch("/api/health", { cache: "no-store" });
          if (r.ok) {
            const j = (await r.json()) as { version?: string };
            if (j.version && j.version !== prevVersion) {
              toast.success(t("update.updated", { version: j.version }));
              await sleep(1200);
              window.location.reload();
              return;
            }
          }
        } catch {
          /* server down mid-restart — keep polling */
        }
      }
      setRestarting(false);
      toast.error(t("update.restartTimeout"));
    },
    [t],
  );

  function openStream(prevVersion: string) {
    esRef.current?.close();
    const es = new EventSource(api.updateStreamUrl());
    esRef.current = es;
    es.onmessage = (ev) => {
      let p: UpdateProgress;
      try {
        p = JSON.parse(ev.data);
      } catch {
        return;
      }
      setProgress(p);
      if (p.phase === "staged") {
        es.close();
        waitForRestart(prevVersion); // server exits ~1.5s after staging
      } else if (p.phase === "failed") {
        es.close();
        setBusy(false);
        toast.error(t("update.failed", { msg: p.error || p.message }));
      }
    };
    es.onerror = () => {
      // Benign once staged (the server is restarting). Otherwise EventSource auto-retries.
    };
  }

  async function doApply() {
    if (!info?.latest) return;
    setBusy(true);
    setProgress({ phase: "downloading", percent: 0, message: t("update.starting") });
    try {
      await api.updateApply();
      openStream(info.current);
    } catch (e) {
      setBusy(false);
      setProgress(null);
      toast.error(t("update.startFailed", { msg: (e as Error).message }));
    }
  }

  async function doRollback() {
    if (!window.confirm(t("update.rollbackConfirm"))) return;
    setBusy(true);
    try {
      const prev = info?.current ?? "";
      await api.updateRollback();
      toast.success(t("update.rollingBack"));
      waitForRestart(prev);
    } catch (e) {
      setBusy(false);
      toast.error(t("update.rollbackFailed", { msg: (e as Error).message }));
    }
  }

  const isDocker = info?.mode === "docker";
  const devBuild = info && !info.comparable;
  const pct = progress && progress.percent >= 0 ? progress.percent : null;

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <DownloadIcon className="size-4" />
          {t("update.title")}
        </CardTitle>
        <CardDescription>{t("update.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* 版本行 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          <span className="text-muted-foreground">{t("update.current")}</span>
          <Badge variant="secondary" className="font-mono">{info?.current ?? "…"}</Badge>
          {info?.has_update && info.latest && (
            <>
              <span className="text-muted-foreground">→</span>
              <Badge className="bg-emerald-600 font-mono hover:bg-emerald-600">{info.latest}</Badge>
            </>
          )}
          <Badge variant="outline" className="text-xs">
            {isDocker ? t("update.modeDocker") : t("update.modeBinary")}
          </Badge>
          {info && !info.has_update && info.comparable && !info.error && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
              <CheckCircle2Icon className="size-3.5" /> {t("update.upToDate")}
            </span>
          )}
        </div>

        {/* 上次升级结果 / 回滚提示 */}
        {info?.boot_notice && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{info.boot_notice}</span>
          </div>
        )}

        {/* 检查错误（GitHub 不可达/限流） */}
        {info?.error && (
          <p className="text-xs text-destructive">{t("update.checkFailed", { msg: info.error })}</p>
        )}

        {/* 开发构建：禁用一键更新 */}
        {devBuild && <p className="text-xs text-muted-foreground">{info?.reason || t("update.devBuild")}</p>}

        {/* Docker：提示拉镜像 */}
        {isDocker && info?.has_update && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
            {t("update.dockerHint")}
            <code className="mt-1 block font-mono text-[11px]">docker compose pull &amp;&amp; docker compose up -d</code>
          </div>
        )}

        {/* 有新版本：changelog + 大小 */}
        {info?.has_update && info.notes && (
          <details className="rounded-md border px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium">
              {t("update.releaseNotes", { version: info.latest })}
              {info.size ? ` · ${humanSize(info.size)}` : ""}
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-muted-foreground">
              {info.notes}
            </pre>
          </details>
        )}

        {/* 进度条 */}
        {(busy || restarting) && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Loader2Icon className="size-3.5 animate-spin" />
                {restarting ? t("update.restarting") : progress?.message || t("update.working")}
              </span>
              {pct !== null && <span className="tabular-nums">{pct}%</span>}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: pct !== null ? `${pct}%` : restarting ? "100%" : "40%" }}
              />
            </div>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => check(true)} disabled={checking || busy || restarting}>
            {checking ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            {t("update.checkNow")}
          </Button>
          <Button
            size="sm"
            onClick={doApply}
            disabled={busy || restarting || checking || !info?.has_update || !info?.asset_available || isDocker || !!devBuild}
          >
            {busy && !restarting ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
            {t("update.applyNow")}
          </Button>
          {info?.has_backup && (
            <Button variant="ghost" size="sm" onClick={doRollback} disabled={busy || restarting}>
              <RotateCcwIcon /> {t("update.rollback")}
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">{t("update.supervisorHint")}</p>
      </CardContent>
    </Card>
  );
}
