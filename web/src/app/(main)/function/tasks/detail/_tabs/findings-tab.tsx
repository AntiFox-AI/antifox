"use client";

import * as React from "react";

import { ChevronRightIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { FindingDetail } from "@/components/finding-detail";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import type { Finding } from "@/lib/types";
import { cn } from "@/lib/utils";

function Row({ f, onChanged }: { f: Finding; onChanged: () => void }) {
  const [open, setOpen] = React.useState(false);
  const name = f.enr_name || f.vulnclass;
  return (
    <div className="border-b last:border-b-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-accent/40"
      >
        <ChevronRightIcon
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <StatusBadge domain="severity" value={f.severity} dot />
        {f.status && <StatusBadge domain="findingStatus" value={f.status} />}
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{name}</span>
          <span className="text-muted-foreground ml-2 text-xs">{f.summary}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{new Date(f.ts).toLocaleString("zh-CN")}</span>
      </button>
      {open && (
        <div className="bg-muted/30 px-4 pb-4 pl-11">
          <FindingDetail finding={f} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

export function FindingsTab({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const [findings, setFindings] = React.useState<Finding[]>([]);
  const [extracting, setExtracting] = React.useState(false);
  const [enriching, setEnriching] = React.useState(false);
  const [enrProgress, setEnrProgress] = React.useState({ done: 0, total: 0 });

  const reload = React.useCallback(() => {
    api
      .findings(taskId)
      .then(setFindings)
      .catch(() => {});
  }, [taskId]);

  React.useEffect(() => {
    reload();
    // pause the 3s poll while batch-enriching so a mid-flight reload doesn't drop
    // rows the user is watching fill in.
    if (enriching) return;
    const iv = setInterval(reload, 3000);
    return () => clearInterval(iv);
  }, [reload, enriching]);

  function extract() {
    setExtracting(true);
    api
      .extractFindings(taskId)
      .then((r) => {
        toast.success(t("taskDetail.findings.extractDone", { created: r.created, extracted: r.extracted }));
        reload();
      })
      .catch((e) => toast.error(t("taskDetail.findings.extractFailed", { msg: (e as Error).message })))
      .finally(() => setExtracting(false));
  }

  // Batch AI-enrich: transcript-grounded enrichment for every un-enriched finding,
  // via the same per-finding endpoint, a few in parallel with a live progress count.
  async function enrichAll() {
    const targets = items.filter((f) => !f.enr_name);
    if (targets.length === 0) {
      toast.info(t("taskDetail.findings.enrichAllNone"));
      return;
    }
    setEnriching(true);
    setEnrProgress({ done: 0, total: targets.length });
    const queue = [...targets];
    let done = 0;
    let failed = 0;
    const worker = async () => {
      for (;;) {
        const f = queue.shift();
        if (!f) return;
        try {
          await api.findingEnrich(f.node_id || f.id);
        } catch {
          failed++;
        }
        done++;
        setEnrProgress({ done, total: targets.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
    setEnriching(false);
    toast.success(t("taskDetail.findings.enrichAllDone", { done: done - failed, failed }));
    reload();
  }

  const items = findings
    .filter((f) => f.task_id === taskId)
    .sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
    });

  return (
    <Card className="overflow-hidden py-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <span className="text-muted-foreground text-xs">{t("taskDetail.findings.extractHint")}</span>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={enrichAll} disabled={enriching || extracting} title={t("taskDetail.findings.enrichAllHint")}>
            {enriching ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
            {enriching
              ? t("taskDetail.findings.enrichingAll", { done: enrProgress.done, total: enrProgress.total })
              : t("taskDetail.findings.enrichAllBtn")}
          </Button>
          <Button size="sm" variant="outline" onClick={extract} disabled={extracting || enriching}>
            {extracting ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
            {extracting ? t("taskDetail.findings.extracting") : t("taskDetail.findings.extractBtn")}
          </Button>
        </div>
      </div>
      <CardContent className="px-0">
        {items.map((f) => (
          <Row key={f.id} f={f} onChanged={reload} />
        ))}
        {items.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("taskDetail.findings.empty")}</p>
        )}
      </CardContent>
    </Card>
  );
}
