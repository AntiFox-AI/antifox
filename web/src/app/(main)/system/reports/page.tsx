"use client";

import * as React from "react";

import { DownloadIcon, FileTextIcon, ImageIcon, Loader2Icon, PencilIcon, PlusIcon, SparklesIcon, TrashIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import type { Finding, Personnel, ReportRecord, ReportSettings, ReportTemplate, Task } from "@/lib/types";
import { taskLabel, taskMap } from "@/lib/task-label";

function localeName(t: TFunction, locale: string): string {
  if (locale === "zh-TW") return t("reports.langZhTW");
  if (locale === "en-US") return t("reports.langEnUS");
  return t("reports.langZhCN");
}

function emptyTemplate(): ReportTemplate {
  return {
    id: 0,
    name: "",
    company_name: "",
    company_name_en: "",
    logo_path: "",
    personnel: [],
    cvss_version: "3.1",
    locale: "zh-CN",
  };
}

function logoUrl(path: string): string {
  if (!path) return "";
  return `/api/report-assets/${path.split("/").pop()}`;
}
function fmtSize(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtTime(ts: string) {
  return new Date(ts).toLocaleString("zh-CN");
}

export default function ReportsPage() {
  const { t } = useTranslation();
  const [s, setS] = React.useState<ReportSettings>({
    company_name: "",
    company_name_en: "",
    logo_path: "",
    personnel: [],
    cvss_version: "3.1",
  });
  const [reports, setReports] = React.useState<ReportRecord[]>([]);
  const [saving, setSaving] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // 新建报告（按任务）
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [selTask, setSelTask] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [client, setClient] = React.useState("");
  const [locale, setLocale] = React.useState("zh-CN");
  const [format, setFormat] = React.useState("docx"); // docx | md
  const [taskFindings, setTaskFindings] = React.useState<Finding[]>([]);
  const [selFindings, setSelFindings] = React.useState<Set<string>>(new Set());
  const [loadingFindings, setLoadingFindings] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);
  const [selTemplate, setSelTemplate] = React.useState("");

  // 报告模版（命名预设）
  const [templates, setTemplates] = React.useState<ReportTemplate[]>([]);
  const [tplOpen, setTplOpen] = React.useState(false);
  const [tplForm, setTplForm] = React.useState<ReportTemplate>(emptyTemplate());

  const loadReports = React.useCallback(() => {
    api.reports().then(setReports).catch(() => {});
  }, []);
  // resolve the unified task label (名称优先→#id·描述) for the list, consistent
  // with findings/dashboard/assets; falls back to the stored task_desc.
  const tmap = React.useMemo(() => taskMap(tasks), [tasks]);
  const reportTaskLabel = React.useCallback(
    (r: ReportRecord) =>
      r.task_id != null
        ? taskLabel(tmap.get(String(r.task_id)) ?? { id: String(r.task_id), description: r.task_desc })
        : r.task_desc || "—",
    [tmap],
  );
  function deleteReport(r: ReportRecord) {
    if (!window.confirm(t("reports.deleteConfirm", { name: r.filename }))) return;
    api
      .deleteReport(r.id)
      .then(() => {
        toast.success(t("reports.deleted"));
        loadReports();
      })
      .catch((e) => toast.error((e as Error).message));
  }
  const loadTemplates = React.useCallback(() => {
    api.reportTemplates().then(setTemplates).catch(() => {});
  }, []);

  React.useEffect(() => {
    api.reportSettings().then((r) => setS({ ...r, personnel: r.personnel ?? [] })).catch(() => {});
    loadReports();
    loadTemplates();
  }, [loadReports, loadTemplates]);

  // Stop polling if the user leaves the page mid-generation (avoid a stray
  // interval + a "report done" toast popping up on some other page).
  React.useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  // ── report templates ──
  function openNewTemplate() {
    setTplForm(emptyTemplate());
    setTplOpen(true);
  }
  function openEditTemplate(tpl: ReportTemplate) {
    setTplForm({ ...tpl, personnel: tpl.personnel ?? [] });
    setTplOpen(true);
  }
  function saveTemplate() {
    if (!tplForm.name.trim()) {
      toast.error(t("reports.templateName"));
      return;
    }
    const p = tplForm.id > 0 ? api.updateReportTemplate(tplForm.id, tplForm) : api.createReportTemplate(tplForm);
    p.then(() => {
      toast.success(t("reports.templateSaved"));
      setTplOpen(false);
      loadTemplates();
    }).catch((e) => toast.error((e as Error).message));
  }
  function delTemplate(id: number) {
    if (!window.confirm(t("reports.deleteTemplateConfirm"))) return;
    api
      .deleteReportTemplate(id)
      .then(() => {
        toast.success(t("reports.templateDeleted"));
        loadTemplates();
      })
      .catch((e) => toast.error((e as Error).message));
  }
  function setTplPerson(i: number, patch: Partial<Personnel>) {
    setTplForm((prev) => ({ ...prev, personnel: prev.personnel.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  }
  function addTplPerson() {
    setTplForm((prev) => ({ ...prev, personnel: [...prev.personnel, { name: "", role: "", contact: "" }] }));
  }
  function removeTplPerson(i: number) {
    setTplForm((prev) => ({ ...prev, personnel: prev.personnel.filter((_, j) => j !== i) }));
  }
  // Selecting a template in the new-report dialog pre-fills the language.
  function pickTemplate(v: string) {
    setSelTemplate(v);
    const tpl = templates.find((x) => String(x.id) === v);
    if (tpl?.locale) setLocale(tpl.locale);
  }

  function openDialog() {
    setSelTask("");
    setTitle("");
    setClient("");
    setLocale("zh-CN");
    setSelTemplate("");
    setTaskFindings([]);
    setSelFindings(new Set());
    api.tasks().then((r) => setTasks(r.tasks)).catch(() => {});
    setDialogOpen(true);
  }

  // Load the selected task's findings (default: all selected) so the user can
  // pick a subset for the report.
  React.useEffect(() => {
    if (!dialogOpen || !selTask) {
      setTaskFindings([]);
      setSelFindings(new Set());
      return;
    }
    setLoadingFindings(true);
    api
      .findings(selTask)
      .then((fs) => {
        setTaskFindings(fs);
        setSelFindings(new Set(fs.map((f) => f.node_id ?? f.id)));
      })
      .catch(() => {
        setTaskFindings([]);
        setSelFindings(new Set());
      })
      .finally(() => setLoadingFindings(false));
  }, [dialogOpen, selTask]);

  function toggleFinding(key: string) {
    setSelFindings((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function pollReport(taskId: string) {
    let n = 0;
    const stop = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    stop(); // never run two pollers at once
    pollRef.current = setInterval(() => {
      n += 1;
      if (n > 60) {
        stop();
        setGenerating(false);
        return;
      }
      api
        .reportStatus(taskId)
        .then((j) => {
          if (j.status === "done") {
            stop();
            setGenerating(false);
            loadReports();
            toast.success(t("reports.genDone"));
          } else if (j.status === "failed") {
            stop();
            setGenerating(false);
            toast.error(t("reports.genFailed", { msg: j.error ?? "" }));
          }
        })
        .catch(() => {});
    }, 5000);
  }

  function startGenerate() {
    if (!selTask) return;
    setGenerating(true);
    // Only send finding_ids when a strict subset is selected; empty/all → omit
    // (server uses all findings).
    const allKeys = taskFindings.map((f) => f.node_id ?? f.id);
    const isSubset = selFindings.size > 0 && selFindings.size < allKeys.length;
    api
      .reportGenerate(selTask, {
        title: title || undefined,
        client: client || undefined,
        locale,
        format,
        findingIds: isSubset ? allKeys.filter((k) => selFindings.has(k)) : undefined,
        templateId: selTemplate ? Number(selTemplate) : undefined,
      })
      .then(() => {
        toast.success(t("reports.genStarted"));
        setDialogOpen(false);
        pollReport(selTask);
      })
      .catch((e) => {
        toast.error((e as Error).message);
        setGenerating(false);
      });
  }

  function setPerson(i: number, patch: Partial<Personnel>) {
    setS((prev) => ({ ...prev, personnel: prev.personnel.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  }
  function addPerson() {
    setS((prev) => ({ ...prev, personnel: [...prev.personnel, { name: "", role: "", contact: "" }] }));
  }
  function removePerson(i: number) {
    setS((prev) => ({ ...prev, personnel: prev.personnel.filter((_, j) => j !== i) }));
  }

  function onLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    api
      .uploadReportLogo(f)
      .then((res) => {
        setS((prev) => ({ ...prev, logo_path: res.logo_path }));
        toast.success(t("reports.logoUploaded"));
      })
      .catch((err) => toast.error((err as Error).message));
  }

  function save() {
    setSaving(true);
    api
      .saveReportSettings(s)
      .then((r) => {
        setS({ ...r, personnel: r.personnel ?? [] });
        toast.success(t("reports.saved"));
      })
      .catch((err) => toast.error((err as Error).message))
      .finally(() => setSaving(false));
  }

  return (
    <div className="flex flex-1 flex-col gap-4 md:gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("reports.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("reports.subtitle")}</p>
      </div>

      {/* ── report settings ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("reports.settingsTitle")}</CardTitle>
          <CardDescription>{t("reports.settingsHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <Label>{t("reports.company")}</Label>
              <Input
                value={s.company_name}
                onChange={(e) => setS({ ...s, company_name: e.target.value })}
                placeholder={t("reports.companyPlaceholder")}
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label>{t("reports.companyEn")}</Label>
              <Input value={s.company_name_en} onChange={(e) => setS({ ...s, company_name_en: e.target.value })} />
            </div>
          </div>

          {/* logo */}
          <div className="min-w-0 space-y-1.5">
            <Label>{t("reports.logo")}</Label>
            <div className="flex items-center gap-3">
              <div className="flex size-16 items-center justify-center overflow-hidden rounded-md border bg-muted/40">
                {s.logo_path ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoUrl(s.logo_path)} alt="logo" className="max-h-full max-w-full object-contain" />
                ) : (
                  <ImageIcon className="size-6 text-muted-foreground/50" />
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={onLogo} />
                <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                  {t("reports.uploadLogo")}
                </Button>
                {s.logo_path && (
                  <button
                    className="text-muted-foreground hover:text-destructive text-left text-xs"
                    onClick={() => setS({ ...s, logo_path: "" })}
                  >
                    {t("reports.clearLogo")}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* personnel */}
          <div className="space-y-2">
            <Label>{t("reports.personnel")}</Label>
            <div className="flex flex-col gap-2">
              {s.personnel.map((p, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Input
                    value={p.name}
                    onChange={(e) => setPerson(i, { name: e.target.value })}
                    placeholder={t("reports.personName")}
                    className="w-40"
                  />
                  <Input
                    value={p.role}
                    onChange={(e) => setPerson(i, { role: e.target.value })}
                    placeholder={t("reports.personRole")}
                    className="w-44"
                  />
                  <Input
                    value={p.contact}
                    onChange={(e) => setPerson(i, { contact: e.target.value })}
                    placeholder={t("reports.personContact")}
                    className="w-48"
                  />
                  <Button size="icon" variant="ghost" onClick={() => removePerson(i)}>
                    <TrashIcon className="text-muted-foreground" />
                  </Button>
                </div>
              ))}
              <Button size="sm" variant="outline" className="w-fit" onClick={addPerson}>
                <PlusIcon /> {t("reports.addPerson")}
              </Button>
            </div>
          </div>

          <div className="flex items-end gap-3">
            <Button onClick={save} disabled={saving}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── report templates ── */}
      <Card className="py-0">
        <CardHeader className="flex-row items-center justify-between px-6 pt-6">
          <div>
            <CardTitle className="text-base">{t("reports.templatesTitle")}</CardTitle>
            <CardDescription>{t("reports.templatesHint")}</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={openNewTemplate}>
            <PlusIcon /> {t("reports.newTemplate")}
          </Button>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("reports.templateColName")}</TableHead>
                <TableHead className="w-48">{t("reports.company")}</TableHead>
                <TableHead className="w-36">{t("reports.templateColLang")}</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((tpl) => (
                <TableRow key={tpl.id}>
                  <TableCell className="font-medium">{tpl.name}</TableCell>
                  <TableCell className="text-muted-foreground">{tpl.company_name || "—"}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{localeName(t, tpl.locale)}</TableCell>
                  <TableCell className="text-right">
                    <Button size="icon" variant="ghost" onClick={() => openEditTemplate(tpl)}>
                      <PencilIcon className="text-muted-foreground size-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => delTemplate(tpl.id)}>
                      <TrashIcon className="text-muted-foreground size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {templates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground py-8 text-center text-sm">
                    {t("reports.templatesEmpty")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── generated reports ── */}
      <Card className="py-0">
        <CardHeader className="flex-row items-center justify-between px-6 pt-6">
          <div>
            <CardTitle className="text-base">{t("reports.listTitle")}</CardTitle>
            <CardDescription>{t("reports.listHint")}</CardDescription>
          </div>
          <Button size="sm" onClick={openDialog} disabled={generating}>
            {generating ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
            {generating ? t("reports.generating") : t("reports.newReport")}
          </Button>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("reports.colTask")}</TableHead>
                <TableHead>{t("reports.colFile")}</TableHead>
                <TableHead className="w-40">{t("reports.colCompany")}</TableHead>
                <TableHead className="w-24">{t("reports.colSize")}</TableHead>
                <TableHead className="w-40">{t("reports.colTime")}</TableHead>
                <TableHead className="w-36" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-xs truncate" title={reportTaskLabel(r)}>{reportTaskLabel(r)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.filename}</TableCell>
                  <TableCell className="text-muted-foreground">{r.company || "—"}</TableCell>
                  <TableCell className="tabular-nums text-xs">{fmtSize(r.size)}</TableCell>
                  <TableCell className="text-muted-foreground text-xs tabular-nums">{fmtTime(r.created_at)}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button size="sm" variant="outline" asChild>
                        <a href={api.reportRecordDownloadUrl(r.id)}>
                          <DownloadIcon /> {t("reports.download")}
                        </a>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => deleteReport(r)}
                        title={t("reports.delete")}
                      >
                        <TrashIcon />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {reports.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-12 text-center text-sm">
                    <FileTextIcon className="mx-auto mb-2 size-8 opacity-40" />
                    {t("reports.empty")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── new report by task ── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("reports.newReport")}</DialogTitle>
            <DialogDescription>{t("reports.newReportHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            {templates.length > 0 && (
              <div className="min-w-0 space-y-1.5">
                <Label>{t("reports.useTemplate")}</Label>
                <Select value={selTemplate || "none"} onValueChange={(v) => pickTemplate(v === "none" ? "" : v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("reports.templateNone")}</SelectItem>
                    {templates.map((tpl) => (
                      <SelectItem key={tpl.id} value={String(tpl.id)}>
                        {tpl.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <Label>{t("reports.selectTask")}</Label>
                <Select value={selTask} onValueChange={setSelTask}>
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue placeholder={t("reports.selectTaskPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {tasks.map((tk) => (
                      <SelectItem key={tk.id} value={tk.id}>
                        <span className="block max-w-[26rem] truncate">{taskLabel(tk)}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label>{t("reports.language")}</Label>
                <Select value={locale} onValueChange={setLocale}>
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="zh-CN">{t("reports.langZhCN")}</SelectItem>
                    <SelectItem value="zh-TW">{t("reports.langZhTW")}</SelectItem>
                    <SelectItem value="en-US">{t("reports.langEnUS")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label>{t("reports.format")}</Label>
                <Select value={format} onValueChange={setFormat}>
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="docx">{t("reports.formatDocx")}</SelectItem>
                    <SelectItem value="md">{t("reports.formatMd")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label>{t("reports.reportTitle")}</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("reports.reportTitlePlaceholder")} />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label>{t("reports.clientName")}</Label>
              <Input value={client} onChange={(e) => setClient(e.target.value)} placeholder={t("reports.clientPlaceholder")} />
            </div>
            {/* findings selector */}
            {selTask && (
              <div className="min-w-0 space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>{t("reports.selectFindings")}</Label>
                  {taskFindings.length > 0 && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{t("reports.findingsSelected", { n: selFindings.size, total: taskFindings.length })}</span>
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => setSelFindings(new Set(taskFindings.map((f) => f.node_id ?? f.id)))}
                      >
                        {t("reports.findingsAll")}
                      </button>
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => setSelFindings(new Set())}
                      >
                        {t("reports.findingsNone")}
                      </button>
                    </div>
                  )}
                </div>
                {loadingFindings ? (
                  <div className="text-sm text-muted-foreground py-2">{t("reports.findingsLoading")}</div>
                ) : taskFindings.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-2">{t("reports.findingsEmpty")}</div>
                ) : (
                  <ScrollArea className="h-40 rounded-md border">
                    <div className="p-1">
                      {taskFindings.map((f) => {
                        const key = f.node_id ?? f.id;
                        return (
                          <label
                            key={key}
                            className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50 cursor-pointer"
                          >
                            <Checkbox checked={selFindings.has(key)} onCheckedChange={() => toggleFinding(key)} />
                            <Badge variant="outline" className="shrink-0 uppercase text-[10px]">
                              {f.severity}
                            </Badge>
                            <span className="truncate">{f.enr_name || f.vulnclass || f.summary}</span>
                          </label>
                        );
                      })}
                    </div>
                  </ScrollArea>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={startGenerate}
              disabled={!selTask || (taskFindings.length > 0 && selFindings.size === 0)}
            >
              <SparklesIcon /> {t("reports.generate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── template editor ── */}
      <Dialog open={tplOpen} onOpenChange={setTplOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{tplForm.id > 0 ? t("reports.editTemplate") : t("reports.newTemplate")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0 space-y-1.5">
                <Label>{t("reports.templateName")}</Label>
                <Input
                  value={tplForm.name}
                  onChange={(e) => setTplForm({ ...tplForm, name: e.target.value })}
                  placeholder={t("reports.templateNamePlaceholder")}
                />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label>{t("reports.language")}</Label>
                <Select value={tplForm.locale} onValueChange={(v) => setTplForm({ ...tplForm, locale: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="zh-CN">{t("reports.langZhCN")}</SelectItem>
                    <SelectItem value="zh-TW">{t("reports.langZhTW")}</SelectItem>
                    <SelectItem value="en-US">{t("reports.langEnUS")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0 space-y-1.5">
                <Label>{t("reports.company")}</Label>
                <Input
                  value={tplForm.company_name}
                  onChange={(e) => setTplForm({ ...tplForm, company_name: e.target.value })}
                />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label>{t("reports.companyEn")}</Label>
                <Input
                  value={tplForm.company_name_en}
                  onChange={(e) => setTplForm({ ...tplForm, company_name_en: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("reports.personnel")}</Label>
              <div className="flex flex-col gap-2">
                {tplForm.personnel.map((p, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input
                      value={p.name}
                      onChange={(e) => setTplPerson(i, { name: e.target.value })}
                      placeholder={t("reports.personName")}
                      className="w-36"
                    />
                    <Input
                      value={p.role}
                      onChange={(e) => setTplPerson(i, { role: e.target.value })}
                      placeholder={t("reports.personRole")}
                      className="w-40"
                    />
                    <Input
                      value={p.contact}
                      onChange={(e) => setTplPerson(i, { contact: e.target.value })}
                      placeholder={t("reports.personContact")}
                      className="w-44"
                    />
                    <Button size="icon" variant="ghost" onClick={() => removeTplPerson(i)}>
                      <TrashIcon className="text-muted-foreground" />
                    </Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" className="w-fit" onClick={addTplPerson}>
                  <PlusIcon /> {t("reports.addPerson")}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTplOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={saveTemplate} disabled={!tplForm.name.trim()}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
