"use client";

import * as React from "react";

import { CameraIcon, CheckIcon, ExternalLinkIcon, ImagePlusIcon, Link2Icon, Loader2Icon, PencilIcon, ShieldAlertIcon, SparklesIcon, Trash2Icon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { PacketShotModal } from "@/components/packet-shot-modal";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { Enrichment, Finding, FindingEvidenceItem, FindingStatus, Reproduction, TrafficExchange } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUSES: FindingStatus[] = ["open", "confirmed", "fixed", "false_positive", "ignored"];
const SEVERITIES = ["critical", "high", "medium", "low"];

// openPacket opens the exact recorded packet in the 流量 page in a NEW TAB (so the
// finding stays open for side-by-side screenshotting).
function openPacket(exchangeId: string) {
  window.open(`/function/traffic?exchange=${encodeURIComponent(exchangeId)}`, "_blank", "noopener");
}

// FindingDetail is the shared rich body for a finding — used by both the global
// findings page and the task-detail findings tab. It lazy-loads the enrichment,
// offers "AI 分析", editable name/target/severity/status, and renders the
// structured sections (description / risk / remediation / evidence).
export function FindingDetail({ finding, onChanged }: { finding: Finding; onChanged?: () => void }) {
  const { t, i18n } = useTranslation();
  const nodeId = finding.node_id || finding.id;
  const [enr, setEnr] = React.useState<Enrichment | null>(null);
  const [repro, setRepro] = React.useState<Reproduction | null>(null);
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
      .then((r) => {
        if (!alive) return;
        setEnr(r.enrichment);
        setRepro(r.reproduction ?? null);
      })
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

      {/* ── 复现过程：有结构化 reproduction 时显式分步 + 每步证据；否则平铺 test_process + 单一证据区 ── */}
      <ReproductionSection nodeId={String(nodeId)} repro={repro} blocks={enr?.test_process ?? []} />

      {/* ── raw evidence / PoC ── 当有结构化复现步骤时，步骤+请求/响应+截图已是实打实的证据，
           原始 PoC 折叠成"来源/原始"审计项；无结构化时它仍是主证据，照常展开。 */}
      {(() => {
        const hasRepro = (repro?.steps?.length ?? 0) > 0 || !!repro?.entry_point;
        const pre = (
          <pre className="max-w-full min-w-0 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
            {finding.evidence || "—"}
          </pre>
        );
        if (hasRepro) {
          return (
            <details className="min-w-0">
              <summary className="cursor-pointer text-muted-foreground text-xs font-medium hover:text-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <ShieldAlertIcon className="size-3.5" />
                  {t("findings.rawEvidence")}
                  {finding.param_id && <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{finding.param_id}</code>}
                </span>
              </summary>
              <div className="mt-1">{pre}</div>
            </details>
          );
        }
        return (
          <Section
            label={
              <span className="inline-flex items-center gap-1.5">
                <ShieldAlertIcon className="size-3.5" />
                {t("findings.evidence")}
                {finding.param_id && <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{finding.param_id}</code>}
              </span>
            }
          >
            {pre}
          </Section>
        );
      })()}

      {/* ── 关联流量（手动/引擎自动记录的证据来源；可一键进截图模式截图）── */}
      <TrafficLinksSection nodeId={String(nodeId)} />
    </div>
  );
}

// TrafficLinksSection 展示该漏洞关联的真实流量（证据来源）：每条可「截图」进截图模式、可解除关联。
function TrafficLinksSection({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation();
  const [items, setItems] = React.useState<TrafficExchange[]>([]);
  const [shot, setShot] = React.useState<TrafficExchange | null>(null);

  const load = React.useCallback(() => {
    api.findingTrafficList(nodeId).then(setItems).catch(() => {});
  }, [nodeId]);
  React.useEffect(() => {
    load();
  }, [load]);

  if (items.length === 0) return null;

  function unlink(ex: TrafficExchange) {
    api.findingTrafficUnlink(nodeId, ex.id).then(load).catch((e) => toast.error((e as Error).message));
  }

  return (
    <Section
      label={
        <span className="inline-flex items-center gap-1.5">
          <Link2Icon className="size-3.5" />
          {t("findings.linkedTraffic")}
          <span className="tabular-nums">· {items.length}</span>
        </span>
      }
    >
      <div className="min-w-0 space-y-1">
        {items.map((ex) => (
          <div key={ex.id} className="group flex items-center gap-2 rounded-md border px-2 py-1.5">
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{ex.method}</span>
            <span
              className={cn(
                "shrink-0 font-mono text-xs font-semibold tabular-nums",
                ex.status >= 500 ? "text-red-500" : ex.status >= 400 ? "text-amber-500" : ex.status >= 300 ? "text-blue-500" : "text-emerald-500",
              )}
            >
              {ex.status}
            </span>
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
              title={t("findings.jumpTrafficHint")}
              onClick={() => openPacket(ex.id)}
            >
              {ex.url}
            </button>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1" onClick={() => openPacket(ex.id)}>
              <ExternalLinkIcon className="size-3.5" /> {t("findings.jumpTraffic")}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1" onClick={() => setShot(ex)}>
              <CameraIcon className="size-3.5" /> {t("traffic.shotMode")}
            </Button>
            <button
              type="button"
              aria-label={t("findings.unlinkTraffic")}
              className="shrink-0 rounded p-1 text-destructive opacity-0 transition group-hover:opacity-100 hover:bg-destructive/10"
              onClick={() => unlink(ex)}
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      {shot && <PacketShotModal exchange={shot} onClose={() => setShot(null)} />}
    </Section>
  );
}

// ReproductionSection 渲染复现过程并把证据截图按【步骤】归位：
//  - 有结构化 reproduction（agent 就地记录）→ 显式分步：入口/前置头 + 每步(说明+逐字请求) + 该步证据上传区 + 来源脚注 + 概览证据区。
//  - 否则 → 平铺 test_process（兼容旧富化）+ 单一证据区。
// 证据与步骤的对应：finding_evidence.step_index == 步骤号(1..N)，0 = 概览/未归属。
function ReproductionSection({
  nodeId,
  repro,
  blocks,
}: {
  nodeId: string;
  repro: Reproduction | null;
  blocks: { type: string; content: string }[];
}) {
  const { t } = useTranslation();
  const [items, setItems] = React.useState<FindingEvidenceItem[]>([]);
  const [lightbox, setLightbox] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    api.findingEvidenceList(nodeId).then(setItems).catch(() => {});
  }, [nodeId]);
  React.useEffect(() => {
    load();
  }, [load]);

  const byStep = React.useMemo(() => {
    const m = new Map<number, FindingEvidenceItem[]>();
    for (const it of items) {
      const k = it.evidence.step_index || 0;
      (m.get(k) ?? m.set(k, []).get(k)!).push(it);
    }
    return m;
  }, [items]);

  const steps = repro?.steps ?? [];
  const hasStructured = steps.length > 0 || !!repro?.entry_point;

  return (
    <Section label={t("findings.testProcess")}>
      <div className="min-w-0 space-y-3">
        {hasStructured ? (
          <>
            {/* 入口点 / 前置条件 */}
            {(repro?.entry_point || (repro?.prerequisites?.length ?? 0) > 0) && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                {repro?.entry_point && (
                  <p className="break-words">
                    <span className="text-muted-foreground">{t("findings.reproEntry")}：</span>
                    <code className="break-all font-mono">{repro.entry_point}</code>
                  </p>
                )}
                {(repro?.prerequisites?.length ?? 0) > 0 && (
                  <div className="mt-1">
                    <span className="text-muted-foreground">{t("findings.reproPrereq")}：</span>
                    <ul className="ml-4 list-disc break-words">
                      {repro!.prerequisites!.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {/* 分步：每步 说明 + 逐字请求 + 该步证据 */}
            {steps.map((st, i) => {
              const n = i + 1;
              const desc = [st.expected, st.proves].filter(Boolean).join(" ｜ ");
              return (
                <div key={n} className="rounded-md border px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary tabular-nums">
                      {t("findings.reproStep")} {n}
                    </span>
                    {desc && <span className="min-w-0 flex-1 text-sm break-words">{desc}</span>}
                    {st.exchange_id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto h-6 shrink-0 gap-1 self-start px-2 text-xs"
                        title={t("findings.jumpTrafficHint")}
                        onClick={() => openPacket(st.exchange_id!)}
                      >
                        <ExternalLinkIcon className="size-3.5" /> {t("findings.jumpTraffic")}
                      </Button>
                    )}
                  </div>
                  {/* 关键请求/响应（agent 记录的标准 HTTP 报文关键部分）；完整流量包靠步骤头部「查看流量包」跳转。 */}
                  {st.request?.trim() && (
                    <pre className="mt-1.5 max-w-full min-w-0 overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
                      {st.request}
                    </pre>
                  )}
                  {st.response?.trim() && (
                    <>
                      <div className="mt-1.5 text-[11px] font-medium text-muted-foreground">{t("findings.reproResponse")}</div>
                      <pre className="mt-0.5 max-w-full min-w-0 overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
                        {st.response}
                      </pre>
                    </>
                  )}
                  <EvidenceStrip
                    nodeId={nodeId}
                    stepIndex={n}
                    items={byStep.get(n) ?? []}
                    onZoom={setLightbox}
                    onChanged={load}
                  />
                </div>
              );
            })}
            {repro?.provenance && (
              <p className="text-xs text-muted-foreground break-words">
                {t("findings.reproProvenance")}：{repro.provenance}
              </p>
            )}
            {/* 概览/未归属证据 */}
            <div className="rounded-md border border-dashed px-3 py-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">{t("findings.reproOverviewShots")}</div>
              <EvidenceStrip nodeId={nodeId} stepIndex={0} items={byStep.get(0) ?? []} onZoom={setLightbox} onChanged={load} />
            </div>
          </>
        ) : (
          <>
            {/* 旧富化：平铺 test_process */}
            {blocks.length > 0 && (
              <div className="min-w-0 space-y-1.5">
                {blocks.map((b, i) =>
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
            )}
            <div className="rounded-md border border-dashed px-3 py-2">
              <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <ImagePlusIcon className="size-3.5" />
                {t("findings.evidenceShots")}
              </div>
              <EvidenceStrip nodeId={nodeId} stepIndex={0} items={byStep.get(0) ?? []} onZoom={setLightbox} onChanged={load} />
            </div>
          </>
        )}
      </div>

      {lightbox && (
        // biome-ignore lint/a11y/noStaticElementInteractions: click-anywhere to dismiss
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="evidence" className="max-h-full max-w-full rounded-md object-contain shadow-2xl" />
          <button
            type="button"
            aria-label={t("common.close")}
            className="absolute top-4 right-4 rounded-full bg-background/90 p-2 shadow"
            onClick={() => setLightbox(null)}
          >
            <XIcon className="size-5" />
          </button>
        </div>
      )}
    </Section>
  );
}

// EvidenceStrip 是一个步骤（或概览区）下的证据截图条：缩略图 + 图注(失焦存) + 删除 + 上传(绑定 stepIndex)。
function EvidenceStrip({
  nodeId,
  stepIndex,
  items,
  onZoom,
  onChanged,
}: {
  nodeId: string;
  stepIndex: number;
  items: FindingEvidenceItem[];
  onZoom: (url: string) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [uploading, setUploading] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function doUpload(files: File[]) {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const f of files) {
        await api.findingEvidenceUpload(nodeId, f, "", stepIndex);
      }
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  function onFiles(files: FileList | null) {
    if (files?.length) doUpload(Array.from(files));
  }
  // 粘贴截图：截图后直接 Ctrl/Cmd+V 粘到该步（聚焦上传区后粘贴），省去"先存盘再上传"。
  function onPaste(e: React.ClipboardEvent) {
    const imgs = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (imgs.length) {
      e.preventDefault();
      doUpload(imgs);
    }
  }
  function onDrop(e: React.DragEvent) {
    const imgs = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (imgs.length) {
      e.preventDefault();
      doUpload(imgs);
    }
  }

  function saveCaption(it: FindingEvidenceItem, caption: string) {
    if (caption === it.evidence.caption) return;
    api
      .findingEvidenceUpdate(nodeId, it.evidence.id, { caption, step_index: it.evidence.step_index, sort_order: it.evidence.sort_order })
      .then(onChanged)
      .catch((e) => toast.error((e as Error).message));
  }

  function remove(it: FindingEvidenceItem) {
    api.findingEvidenceDelete(nodeId, it.evidence.id).then(onChanged).catch((e) => toast.error((e as Error).message));
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2.5">
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      {items.map((it) => (
        <figure key={it.evidence.id} className="group relative w-40 overflow-hidden rounded-md border bg-card">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: click-to-zoom thumbnail */}
          <img
            src={it.url}
            alt={it.evidence.caption || "evidence"}
            className="h-24 w-full cursor-zoom-in bg-muted object-cover"
            onClick={() => onZoom(it.url)}
          />
          <button
            type="button"
            aria-label={t("findings.deleteShot")}
            className="absolute top-1 right-1 rounded bg-background/80 p-1 text-destructive opacity-0 shadow-sm transition group-hover:opacity-100 hover:bg-background"
            onClick={() => remove(it)}
          >
            <Trash2Icon className="size-3.5" />
          </button>
          <input
            defaultValue={it.evidence.caption}
            placeholder={t("findings.shotCaption")}
            className="w-full border-t bg-transparent px-2 py-1 text-[11px] outline-none placeholder:text-muted-foreground/60 focus:bg-muted/40"
            onBlur={(e) => saveCaption(it, e.target.value.trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </figure>
      ))}
      {/* 可点击/拖拽/粘贴 的上传区：点"选择文件"开文件框；聚焦此区后 Ctrl/Cmd+V 粘贴截图；或直接拖图进来 */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: focusable paste/drop zone */}
      <div
        tabIndex={0}
        onPaste={onPaste}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        aria-label={t("findings.uploadShot")}
        className="flex h-[116px] w-40 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-muted-foreground outline-none transition hover:border-primary hover:text-primary focus:border-primary focus:ring-2 focus:ring-primary/30 aria-disabled:opacity-60"
        aria-disabled={uploading}
      >
        {uploading ? <Loader2Icon className="size-4 animate-spin" /> : <ImagePlusIcon className="size-4" />}
        <span className="px-1 text-center text-[11px] leading-tight">
          {uploading ? t("findings.uploadingShot") : t("findings.pasteOrDrop")}
        </span>
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="text-[10px] text-primary underline-offset-2 hover:underline disabled:opacity-60"
        >
          {t("findings.chooseFile")}
        </button>
      </div>
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
