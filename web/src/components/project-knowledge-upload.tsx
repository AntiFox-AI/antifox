"use client";

import * as React from "react";

import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import type { ProjectDocCard } from "@/lib/types";

// ProjectKnowledgeUpload is the 「项目知识」 area in the new-task dialog: upload the
// engagement's authorization letter / test scope / scoring rules / obtained credentials.
// Files are text-extracted and staged under a draft id (returned on first upload),
// then bound to the task on create and injected into the planner/worker SYSTEM as
// must-read context. Checking "to RAG" also pushes a file into the task's semantic KB.
export function ProjectKnowledgeUpload({
  draftId,
  onDraftChange,
}: {
  readonly draftId: string;
  readonly onDraftChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [docs, setDocs] = React.useState<ProjectDocCard[]>([]);
  const [toRag, setToRag] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Dialog reset (draftId cleared) → clear the staged list.
  React.useEffect(() => {
    if (!draftId) setDocs([]);
  }, [draftId]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    let did = draftId;
    try {
      for (const f of files) {
        const r = await api.uploadProjectDoc(f, did, toRag);
        if (!did) {
          did = r.draft_id;
          onDraftChange(did);
        }
      }
      setDocs(await api.listDraftProjectDocs(did));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    try {
      await api.deleteDraftProjectDoc(draftId, id);
      setDocs(await api.listDraftProjectDocs(draftId));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="grid gap-2">
      <Label>{t("projectKnowledge.label")}</Label>
      <p className="text-muted-foreground text-xs">{t("projectKnowledge.hint")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          accept=".md,.txt,.pdf,.docx"
          onChange={onPick}
        />
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? t("projectKnowledge.uploading") : t("projectKnowledge.upload")}
        </Button>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={toRag} onChange={(e) => setToRag(e.target.checked)} />
          {t("projectKnowledge.toRag")}
        </label>
      </div>
      <p className="text-muted-foreground text-xs">{t("projectKnowledge.formats")}</p>
      {docs.length > 0 && (
        <ul className="flex flex-col gap-1">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-2 rounded border px-2 py-1 text-xs">
              <span className="truncate font-medium">{d.name}</span>
              <span className="text-muted-foreground shrink-0">{t("projectKnowledge.chars", { n: d.chars })}</span>
              <button type="button" className="text-destructive ml-auto shrink-0" onClick={() => remove(d.id)}>
                {t("common.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
