"use client";

import * as React from "react";

import { CheckIcon, Loader2Icon, PencilIcon, ShieldAlertIcon, SparklesIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { Enrichment, Finding, FindingStatus } from "@/lib/types";

const STATUSES: FindingStatus[] = ["open", "confirmed", "fixed", "false_positive", "ignored"];
const SEVERITIES = ["critical", "high", "medium", "low"];

// FindingDetail is the shared rich body for a finding — used by both the global
// findings page and the task-detail findings tab. It lazy-loads the enrichment,
// offers "AI 分析", editable name/target/severity/status, and renders the
// structured sections (description / risk / remediation / evidence).
export function FindingDetail({ finding, onChanged }: { finding: Finding; onChanged?: () => void }) {
  const { t, i18n } = useTranslation();
  const nodeId = finding.node_id || finding.id;
  const [enr, setEnr] = React.useState<Enrichment | null>(null);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", target: "", severity: "", status: "open" });

  // Load persisted enrichment; also detect an in-flight AI-分析 job so returning to
  // this finding mid-analysis resumes the spinner (the job runs server-side and is
  // never lost to a page switch).
  React.useEffect(() => {
    let alive = true;
    api
      .findingDetail(nodeId)
      .then((r) => alive && setEnr(r.enrichment))
      .catch(() => {});
    api
      .findingEnrichStatus(nodeId)
      .then((j) => {
        if (alive && j.status === "analyzing") setAnalyzing(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [nodeId]);

  // While a job is analyzing, poll status until it terminates. Runs whether the job
  // was started here (button) or detected on mount (resume). The generation can take
  // minutes for stored findings; polling keeps the UI honest without holding a request.
  React.useEffect(() => {
    if (!analyzing) return;
    let alive = true;
    const iv = setInterval(() => {
      api
        .findingEnrichStatus(nodeId)
        .then((j) => {
          if (!alive) return;
          if (j.status === "done") {
            if (j.enrichment) setEnr(j.enrichment);
            setAnalyzing(false);
            toast.success(t("findings.analyzeDone"));
            onChanged?.();
          } else if (j.status === "failed") {
            setAnalyzing(false);
            toast.error(t("findings.analyzeFailed", { msg: j.error || "" }));
          } else if (j.status === "idle") {
            setAnalyzing(false); // job dropped (e.g. server restart) — stop the spinner
          }
        })
        .catch(() => {});
    }, 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [analyzing, nodeId, t, onChanged]);

  const name = enr?.name || finding.enr_name || finding.vulnclass;
  const target = enr?.target || finding.enr_target || "";
  const severity = enr?.severity || finding.severity;
  const status = (enr?.status || finding.status || "open") as FindingStatus;

  // Kick off async AI 分析. Returns immediately; the polling effect (driven by the
  // analyzing flag) picks up the result — so switching pages can't abort it.
  function analyze() {
    setAnalyzing(true);
    api.findingEnrich(nodeId, i18n.language).catch((err) => {
      setAnalyzing(false);
      toast.error(t("findings.analyzeFailed", { msg: (err as Error).message }));
    });
  }

  function startEdit() {
    setForm({ name, target, severity, status });
    setEditing(true);
  }
  function save() {
    api
      .findingUpdate(nodeId, form)
      .then((e) => {
        setEnr(e);
        setEditing(false);
        toast.success(t("findings.saved"));
        onChanged?.();
      })
      .catch((err) => toast.error((err as Error).message));
  }

  return (
    <div className="min-w-0 space-y-3 px-2 py-2">
      {/* ── header: name + badges + actions ── */}
      {editing ? (
        <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("findings.colName")} />
          <div className="flex flex-wrap gap-2">
            <Input
              value={form.target}
              onChange={(e) => setForm({ ...form, target: e.target.value })}
              placeholder={t("findings.colTarget")}
              className="w-56"
            />
            <Select value={form.severity} onValueChange={(v) => setForm({ ...form, severity: v })}>
              <SelectTrigger size="sm" className="w-28">
                <SelectValue placeholder={t("findings.colSeverity")} />
              </SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`status.severity.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
              <SelectTrigger size="sm" className="w-32">
                <SelectValue placeholder={t("findings.statusLabel")} />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`status.findingStatus.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={save}>
              <CheckIcon /> {t("common.save")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
              <XIcon /> {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {/* row 1: name + badges + actions (actions never pushed off-screen) */}
          <div className="flex items-center gap-2.5">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={name}>
              {name}
            </span>
            <StatusBadge domain="severity" value={severity} dot />
            <StatusBadge domain="findingStatus" value={status} dot />
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" onClick={startEdit}>
                <PencilIcon /> {t("findings.edit")}
              </Button>
              <Button size="sm" onClick={analyze} disabled={analyzing}>
                {analyzing ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
                {analyzing ? t("findings.analyzing") : enr ? t("findings.reanalyze") : t("findings.aiAnalyze")}
              </Button>
            </div>
          </div>
          {/* row 2: target + CVSS (wraps freely, never affects the actions) */}
          {(target || (enr && enr.cvss_score > 0)) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {target && <code className="max-w-full break-all rounded bg-muted px-1.5 py-0.5 font-mono">{target}</code>}
              {enr && enr.cvss_score > 0 && (
                <span className="break-all">
                  {t("findings.cvss")} {enr.cvss_score.toFixed(1)}
                  {enr.cvss_vector ? ` · ${enr.cvss_vector}` : ""}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── analyzing / not-analyzed hint ── */}
      {analyzing && (
        <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <Loader2Icon className="size-3 animate-spin" /> {t("findings.analyzingHint")}
        </p>
      )}
      {!enr && !analyzing && !editing && <p className="text-muted-foreground text-xs">{t("findings.analyzeHint")}</p>}

      {/* ── description (enriched) or raw summary ── */}
      {(enr?.description?.length ? enr.description : finding.summary ? [finding.summary] : []).length > 0 && (
        <Section label={t("findings.descLabel")}>
          {(enr?.description?.length ? enr.description : [finding.summary]).map((p, i) => (
            <p key={i} className="text-sm leading-relaxed break-words">
              {p}
            </p>
          ))}
        </Section>
      )}

      {enr?.module && <Meta label={t("findings.module")}>{enr.module}</Meta>}

      {/* ── risk analysis ── */}
      {enr?.risk_analysis?.length ? (
        <Section label={t("findings.riskAnalysis")}>
          <ol className="ml-4 list-decimal space-y-1 text-sm break-words">
            {enr.risk_analysis.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ol>
        </Section>
      ) : null}

      {/* ── remediation ── */}
      {enr?.remediation?.length ? (
        <Section label={t("findings.remediation")}>
          <ol className="ml-4 list-decimal space-y-1 text-sm break-words">
            {enr.remediation.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ol>
        </Section>
      ) : null}

      {/* ── test process (enriched, formatted) ── */}
      {enr?.test_process?.length ? (
        <Section label={t("findings.testProcess")}>
          <div className="min-w-0 space-y-1.5">
            {enr.test_process.map((b, i) =>
              b.type === "code" ? (
                <pre key={i} className="max-w-full min-w-0 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
                  {b.content}
                </pre>
              ) : (
                <p key={i} className="text-sm leading-relaxed break-words">
                  {b.content}
                </p>
              ),
            )}
          </div>
        </Section>
      ) : null}

      {/* ── raw evidence / PoC (always available) ── */}
      <Section
        label={
          <span className="inline-flex items-center gap-1.5">
            <ShieldAlertIcon className="size-3.5" />
            {t("findings.evidence")}
            {finding.param_id && <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{finding.param_id}</code>}
          </span>
        }
      >
        <pre className="max-w-full min-w-0 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
          {finding.evidence || "—"}
        </pre>
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-muted-foreground text-xs font-medium">{label}</div>
      {children}
    </div>
  );
}
function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}
