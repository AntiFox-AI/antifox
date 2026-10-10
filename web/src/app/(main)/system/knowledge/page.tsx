"use client";

import * as React from "react";

import {
  BrainIcon,
  DatabaseIcon,
  FileUpIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  SearchIcon,
  Settings2Icon,
  TrashIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { taskLabel } from "@/lib/task-label";
import type { KnowledgeConfig, KnowledgeDoc, KnowledgeHit, KnowledgeLog, Task } from "@/lib/types";

function fmtSize(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function KnowledgePage() {
  const { t } = useTranslation();
  const [docs, setDocs] = React.useState<KnowledgeDoc[]>([]);
  const [cfg, setCfg] = React.useState<KnowledgeConfig | null>(null);
  const [scope, setScope] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  // search preview
  const [query, setQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [hits, setHits] = React.useState<KnowledgeHit[] | null>(null);
  const [searchMode, setSearchMode] = React.useState("");

  // doc dialog (create/edit)
  const [docOpen, setDocOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<KnowledgeDoc | null>(null);
  const [form, setForm] = React.useState({ scope: "global", category: "", title: "", content: "" });

  // upload dialog
  const [upOpen, setUpOpen] = React.useState(false);
  const [upScope, setUpScope] = React.useState("global");
  const [upTaskId, setUpTaskId] = React.useState(""); // required when upScope==="task"
  const [upCategory, setUpCategory] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  // task list for the task-scope picker (so 任务知识 lands on the right task, not global)
  const [tasks, setTasks] = React.useState<Task[]>([]);
  React.useEffect(() => { api.tasks().then((r) => setTasks(r.tasks)).catch(() => {}); }, []);

  // config dialog
  const [cfgOpen, setCfgOpen] = React.useState(false);
  const [cfgForm, setCfgForm] = React.useState({ enabled: false, base_url: "", model: "", api_key: "", dim: 1024 });
  const [testing, setTesting] = React.useState(false);
  const [reindexing, setReindexing] = React.useState(false);

  // logs dialog
  const [logsOpen, setLogsOpen] = React.useState(false);
  const [logs, setLogs] = React.useState<KnowledgeLog[]>([]);

  const loadDocs = React.useCallback(() => {
    setLoading(true);
    api.knowledgeDocs(scope, 0).then(setDocs).catch(() => {}).finally(() => setLoading(false));
  }, [scope]);
  const loadCfg = React.useCallback(() => {
    api.knowledgeConfig().then(setCfg).catch(() => {});
  }, []);

  React.useEffect(() => { loadDocs(); }, [loadDocs]);
  React.useEffect(() => { loadCfg(); }, [loadCfg]);

  function doSearch() {
    if (!query.trim()) return;
    setSearching(true);
    api.knowledgeSearch(query.trim(), 0, 5)
      .then((r) => { setHits(r.hits); setSearchMode(r.mode); })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setSearching(false));
  }

  function openNewDoc() {
    setEditing(null);
    setForm({ scope: "global", category: "", title: "", content: "" });
    setDocOpen(true);
  }
  function openEditDoc(d: KnowledgeDoc) {
    api.knowledgeDoc(d.id).then((full) => {
      setEditing(full);
      setForm({ scope: full.scope, category: full.category, title: full.title, content: full.content ?? "" });
      setDocOpen(true);
    });
  }
  function saveDoc() {
    if (!form.title.trim()) { toast.error(t("knowledge.titleRequired")); return; }
    const p = editing
      ? api.updateKnowledgeDoc(editing.id, { category: form.category, title: form.title, content: form.content })
      : api.createKnowledgeDoc({ scope: form.scope, category: form.category, title: form.title, content: form.content });
    p.then(() => { toast.success(t("knowledge.saved")); setDocOpen(false); loadDocs(); loadCfg(); })
      .catch((e) => toast.error((e as Error).message));
  }
  function delDoc(id: number) {
    if (!window.confirm(t("knowledge.deleteConfirm"))) return;
    api.deleteKnowledgeDoc(id).then(() => { toast.success(t("knowledge.deleted")); loadDocs(); loadCfg(); })
      .catch((e) => toast.error((e as Error).message));
  }

  function doUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    // Task-scope upload must name a task, else it lands as an orphan that reads back
    // as global — guard here so the file picker doesn't fire a doomed request.
    if (upScope === "task" && !upTaskId) {
      toast.error(t("knowledge.pickTaskFirst"));
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setUploading(true);
    api.uploadKnowledgeDoc(f, upScope, upScope === "task" ? Number(upTaskId) : 0, upCategory)
      .then(() => { toast.success(t("knowledge.uploadDone")); setUpOpen(false); loadDocs(); loadCfg(); })
      .catch((err) => toast.error((err as Error).message))
      .finally(() => { setUploading(false); if (fileRef.current) fileRef.current.value = ""; });
  }

  function openCfg() {
    if (cfg) setCfgForm({ enabled: cfg.enabled, base_url: cfg.base_url, model: cfg.model, api_key: "", dim: cfg.dim });
    setCfgOpen(true);
  }
  function saveCfg() {
    api.saveKnowledgeConfig(cfgForm)
      .then(() => { toast.success(t("knowledge.saved")); setCfgOpen(false); loadCfg(); })
      .catch((e) => toast.error((e as Error).message));
  }
  function testEmbedder() {
    setTesting(true);
    api.testKnowledgeEmbedder()
      .then((r) => toast.success(t("knowledge.testOk", { dim: r.dim })))
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setTesting(false));
  }
  function reindex() {
    setReindexing(true);
    api.reindexKnowledge()
      .then((r) => { toast.success(t("knowledge.reindexDone", { n: r.indexed })); loadDocs(); })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setReindexing(false));
  }

  function openLogs() {
    api.knowledgeLogs().then(setLogs).catch(() => {});
    setLogsOpen(true);
  }

  const statusBadge = cfg?.semantic_ready
    ? <Badge className="bg-emerald-600/15 text-emerald-600 border-emerald-600/30">{t("knowledge.statusSemantic")}</Badge>
    : cfg?.vector_available
      ? <Badge variant="outline" className="text-amber-600 border-amber-600/40">{t("knowledge.statusKeyword")}</Badge>
      : <Badge variant="outline" className="text-muted-foreground">{t("knowledge.statusVectorOff")}</Badge>;

  return (
    <div className="flex flex-1 flex-col gap-4 md:gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <BrainIcon className="size-5" /> {t("knowledge.title")}
          </h1>
          <p className="text-muted-foreground text-sm">{t("knowledge.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {statusBadge}
          <Button size="sm" variant="outline" onClick={openLogs}><ScrollTextIcon /> {t("knowledge.logsTitle")}</Button>
          <Button size="sm" variant="outline" onClick={openCfg}><Settings2Icon /> {t("knowledge.configTitle")}</Button>
        </div>
      </div>

      {/* stats */}
      <div className="flex flex-wrap gap-3">
        <StatCard icon={<DatabaseIcon className="size-4" />} label={t("knowledge.docsGlobal")} value={cfg?.docs_global ?? 0} />
        <StatCard icon={<DatabaseIcon className="size-4" />} label={t("knowledge.docsTask")} value={cfg?.docs_task ?? 0} />
      </div>

      {/* search preview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("knowledge.searchTitle")}</CardTitle>
          <CardDescription>{t("knowledge.searchHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
              placeholder={t("knowledge.searchPlaceholder")}
            />
            <Button onClick={doSearch} disabled={searching || !query.trim()}>
              {searching ? <Loader2Icon className="animate-spin" /> : <SearchIcon />} {t("knowledge.searchBtn")}
            </Button>
          </div>
          {hits !== null && (
            <div className="flex flex-col gap-2">
              <div className="text-muted-foreground text-xs">
                {t("knowledge.mode")}: <Badge variant="outline" className="ml-1">{searchMode}</Badge>
              </div>
              {hits.length === 0 ? (
                <div className="text-muted-foreground py-3 text-center text-sm">{t("knowledge.noHits")}</div>
              ) : (
                hits.map((h, i) => (
                  <div key={i} className="rounded-md border p-3 text-sm">
                    <div className="mb-1 flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px]">{h.category || "—"}</Badge>
                      <span className="font-medium">{h.title}</span>
                      <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                        {t("knowledge.score")} {(h.score * 100).toFixed(0)}%
                      </span>
                    </div>
                    <p className="text-muted-foreground line-clamp-3 whitespace-pre-wrap text-xs">{h.content}</p>
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* documents */}
      <Card className="py-0">
        <CardHeader className="flex-row items-center justify-between px-6 pt-6">
          <div>
            <CardTitle className="text-base">{t("knowledge.docsTitle")}</CardTitle>
            <CardDescription>{t("knowledge.docsHint")}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={scope || "all"} onValueChange={(v) => setScope(v === "all" ? "" : v)}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("knowledge.scopeAll")}</SelectItem>
                <SelectItem value="global">{t("knowledge.scopeGlobal")}</SelectItem>
                <SelectItem value="task">{t("knowledge.scopeTask")}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={() => setUpOpen(true)}><FileUpIcon /> {t("knowledge.upload")}</Button>
            <Button size="sm" onClick={openNewDoc}><PlusIcon /> {t("knowledge.newDoc")}</Button>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("knowledge.colTitle")}</TableHead>
                <TableHead className="w-40">{t("knowledge.colCategory")}</TableHead>
                <TableHead className="w-24">{t("knowledge.colScope")}</TableHead>
                <TableHead className="w-24">{t("knowledge.colChunks")}</TableHead>
                <TableHead className="w-24">{t("knowledge.colSize")}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="max-w-xs truncate font-medium">{d.title}</TableCell>
                  <TableCell className="text-muted-foreground">{d.category || "—"}</TableCell>
                  <TableCell>
                    <Badge variant={d.scope === "task" ? "default" : "secondary"} className="text-[10px]">
                      {d.scope === "task" ? t("knowledge.scopeTaskBadge") : t("knowledge.scopeGlobalBadge")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs tabular-nums">
                    {d.indexed ? d.chunks : <span className="text-amber-600">{t("knowledge.indexedNo")}</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs tabular-nums">{fmtSize(d.bytes)}</TableCell>
                  <TableCell className="text-right">
                    <Button size="icon" variant="ghost" onClick={() => openEditDoc(d)}>
                      <PencilIcon className="text-muted-foreground size-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => delDoc(d.id)}>
                      <TrashIcon className="text-muted-foreground size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!loading && docs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-12 text-center text-sm">
                    <BrainIcon className="mx-auto mb-2 size-8 opacity-40" />
                    {t("knowledge.empty")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* doc dialog */}
      <Dialog open={docOpen} onOpenChange={setDocOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? t("knowledge.editDoc") : t("knowledge.newDoc")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t("knowledge.docCategory")}</Label>
                <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder={t("knowledge.docCategoryPlaceholder")} />
              </div>
              {!editing && (
                <div className="space-y-1.5">
                  <Label>{t("knowledge.colScope")}</Label>
                  <Select value={form.scope} onValueChange={(v) => setForm({ ...form, scope: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="global">{t("knowledge.scopeGlobal")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>{t("knowledge.docTitle")}</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("knowledge.docContent")}</Label>
              <Textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={12} className="font-mono text-xs" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDocOpen(false)}>{t("knowledge.cancel")}</Button>
            <Button onClick={saveDoc} disabled={!form.title.trim()}>{t("knowledge.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* upload dialog */}
      <Dialog open={upOpen} onOpenChange={setUpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("knowledge.uploadTitle")}</DialogTitle>
            <DialogDescription>{t("knowledge.uploadFormats")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="space-y-1.5">
              <Label>{t("knowledge.scopeLabel")}</Label>
              <Select value={upScope} onValueChange={(v) => setUpScope(v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">{t("knowledge.scopeGlobal")}</SelectItem>
                  <SelectItem value="task">{t("knowledge.scopeTask")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {upScope === "task" && (
              <div className="space-y-1.5">
                <Label>{t("knowledge.taskLabel")}</Label>
                <Select value={upTaskId} onValueChange={(v) => setUpTaskId(v)}>
                  <SelectTrigger className="w-full"><SelectValue placeholder={t("knowledge.taskPlaceholder")} /></SelectTrigger>
                  <SelectContent>
                    {tasks.map((tk) => (
                      <SelectItem key={tk.id} value={tk.id}>{taskLabel(tk)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>{t("knowledge.docCategory")}</Label>
              <Input value={upCategory} onChange={(e) => setUpCategory(e.target.value)} placeholder={t("knowledge.docCategoryPlaceholder")} />
            </div>
            <input ref={fileRef} type="file" accept=".md,.markdown,.txt,.csv,.json,.docx,.pdf" hidden onChange={doUpload} />
            <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? <Loader2Icon className="animate-spin" /> : <FileUpIcon />} {t("knowledge.uploadFile")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* config dialog */}
      <Dialog open={cfgOpen} onOpenChange={setCfgOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("knowledge.configTitle")}</DialogTitle>
            <DialogDescription>{t("knowledge.configHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <div className="text-sm font-medium">{t("knowledge.enableSemantic")}</div>
                <div className="text-muted-foreground text-xs">
                  {cfg?.vector_available ? (cfg?.has_key ? t("knowledge.keySet") : t("knowledge.keyMissing")) : t("knowledge.statusVectorOff")}
                </div>
              </div>
              <Switch checked={cfgForm.enabled} onCheckedChange={(v) => setCfgForm({ ...cfgForm, enabled: v })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("knowledge.baseUrl")}</Label>
              <Input value={cfgForm.base_url} onChange={(e) => setCfgForm({ ...cfgForm, base_url: e.target.value })} className="font-mono text-xs" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t("knowledge.model")}</Label>
                <Input value={cfgForm.model} onChange={(e) => setCfgForm({ ...cfgForm, model: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>{t("knowledge.dim")}</Label>
                <Input type="number" value={cfgForm.dim} onChange={(e) => setCfgForm({ ...cfgForm, dim: Number(e.target.value) })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("knowledge.apiKey")}</Label>
              <Input type="password" value={cfgForm.api_key} onChange={(e) => setCfgForm({ ...cfgForm, api_key: e.target.value })} placeholder={t("knowledge.apiKeyHint")} />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={testEmbedder} disabled={testing}>
                {testing ? <Loader2Icon className="animate-spin" /> : null} {t("knowledge.testBtn")}
              </Button>
              <Button variant="outline" onClick={reindex} disabled={reindexing}>
                {reindexing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} {t("knowledge.reindexBtn")}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCfgOpen(false)}>{t("knowledge.cancel")}</Button>
            <Button onClick={saveCfg}>{t("knowledge.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* logs dialog */}
      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("knowledge.logsTitle")}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="h-96">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("knowledge.logQuery")}</TableHead>
                  <TableHead className="w-24">{t("knowledge.logMode")}</TableHead>
                  <TableHead className="w-16">{t("knowledge.logHits")}</TableHead>
                  <TableHead className="w-28">{t("knowledge.logAgent")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="max-w-xs truncate">{l.query}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[10px]">{l.mode}</Badge></TableCell>
                    <TableCell className="tabular-nums">{l.hits}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{l.agent_key}</TableCell>
                  </TableRow>
                ))}
                {logs.length === 0 && (
                  <TableRow><TableCell colSpan={4} className="text-muted-foreground py-8 text-center text-sm">{t("knowledge.logsEmpty")}</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-4 py-3">
      <div className="text-muted-foreground">{icon}</div>
      <div>
        <div className="text-lg font-semibold tabular-nums">{value}</div>
        <div className="text-muted-foreground text-xs">{label}</div>
      </div>
    </div>
  );
}
