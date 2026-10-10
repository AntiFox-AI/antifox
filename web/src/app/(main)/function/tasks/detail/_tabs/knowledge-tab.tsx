"use client";

import * as React from "react";

import { BrainIcon, FileUpIcon, Loader2Icon, PlusIcon, TrashIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { KnowledgeDoc } from "@/lib/types";

function fmtSize(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// KnowledgeTab manages THIS task's knowledge library (scope=task): upload the
// engagement's background (授权书/评分规则/范围/检查项) so the agents auto-retrieve
// it alongside the global library while working this task.
export function KnowledgeTab({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const tid = Number(taskId);
  const [docs, setDocs] = React.useState<KnowledgeDoc[]>([]);
  const [upOpen, setUpOpen] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(false);
  const [category, setCategory] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const [form, setForm] = React.useState({ category: "", title: "", content: "" });
  const fileRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(() => {
    api.knowledgeDocs("task", tid).then(setDocs).catch(() => {});
  }, [tid]);
  React.useEffect(() => { load(); }, [load]);

  function doUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    api
      .uploadKnowledgeDoc(f, "task", tid, category)
      .then(() => { toast.success(t("knowledge.uploadDone")); setUpOpen(false); load(); })
      .catch((err) => toast.error((err as Error).message))
      .finally(() => { setUploading(false); if (fileRef.current) fileRef.current.value = ""; });
  }
  function saveNew() {
    if (!form.title.trim()) { toast.error(t("knowledge.titleRequired")); return; }
    api
      .createKnowledgeDoc({ scope: "task", task_id: tid, category: form.category, title: form.title, content: form.content })
      .then(() => { toast.success(t("knowledge.saved")); setNewOpen(false); setForm({ category: "", title: "", content: "" }); load(); })
      .catch((e) => toast.error((e as Error).message));
  }
  function del(id: number) {
    if (!window.confirm(t("knowledge.deleteConfirm"))) return;
    api.deleteKnowledgeDoc(id).then(() => { toast.success(t("knowledge.deleted")); load(); }).catch((e) => toast.error((e as Error).message));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">{t("taskDetail.knowledge.hint")}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setUpOpen(true)}><FileUpIcon /> {t("knowledge.upload")}</Button>
          <Button size="sm" onClick={() => setNewOpen(true)}><PlusIcon /> {t("knowledge.newDoc")}</Button>
        </div>
      </div>

      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("knowledge.colTitle")}</TableHead>
                <TableHead className="w-40">{t("knowledge.colCategory")}</TableHead>
                <TableHead className="w-24">{t("knowledge.colChunks")}</TableHead>
                <TableHead className="w-24">{t("knowledge.colSize")}</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="max-w-xs truncate font-medium">{d.title}</TableCell>
                  <TableCell className="text-muted-foreground">{d.category || "—"}</TableCell>
                  <TableCell className="text-muted-foreground text-xs tabular-nums">
                    {d.indexed ? d.chunks : <span className="text-amber-600">{t("knowledge.indexedNo")}</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs tabular-nums">{fmtSize(d.bytes)}</TableCell>
                  <TableCell className="text-right">
                    <Button size="icon" variant="ghost" onClick={() => del(d.id)}>
                      <TrashIcon className="text-muted-foreground size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {docs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-12 text-center text-sm">
                    <BrainIcon className="mx-auto mb-2 size-8 opacity-40" />
                    {t("taskDetail.knowledge.empty")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* upload */}
      <Dialog open={upOpen} onOpenChange={setUpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("knowledge.uploadTitle")}</DialogTitle>
            <DialogDescription>{t("knowledge.uploadFormats")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="space-y-1.5">
              <Label>{t("knowledge.docCategory")}</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t("knowledge.docCategoryPlaceholder")} />
            </div>
            <input ref={fileRef} type="file" accept=".md,.markdown,.txt,.csv,.json,.docx,.pdf" hidden onChange={doUpload} />
            <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? <Loader2Icon className="animate-spin" /> : <FileUpIcon />} {t("knowledge.uploadFile")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* new (paste text) */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("knowledge.newDoc")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="space-y-1.5">
              <Label>{t("knowledge.docCategory")}</Label>
              <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder={t("knowledge.docCategoryPlaceholder")} />
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
            <Button variant="outline" onClick={() => setNewOpen(false)}>{t("knowledge.cancel")}</Button>
            <Button onClick={saveNew} disabled={!form.title.trim()}>{t("knowledge.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
