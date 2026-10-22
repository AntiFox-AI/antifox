"use client";

import * as React from "react";

import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { Finding } from "@/lib/types";
import { taskLabel } from "@/lib/task-label";

// LinkTrafficDialog：把勾选的流量 exchange 关到某个漏洞（作证据来源）。
// 数据只写 PG 的 finding_traffic（关联），报文仍留在流量库，供后续截图自动化取用。
export function LinkTrafficDialog({
  open,
  exchangeIds,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  exchangeIds: string[];
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [findings, setFindings] = React.useState<Finding[]>([]);
  const [nodeId, setNodeId] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    api.findings().then(setFindings).catch(() => {});
  }, [open]);

  function save() {
    if (!nodeId) return;
    setSaving(true);
    api
      .findingTrafficLink(nodeId, exchangeIds)
      .then(() => {
        toast.success(t("traffic.linked", { count: exchangeIds.length }));
        onDone();
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setSaving(false));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("traffic.linkToFinding")}</DialogTitle>
          <DialogDescription>{t("traffic.linkToFindingHint", { count: exchangeIds.length })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Select value={nodeId} onValueChange={setNodeId}>
            <SelectTrigger className="w-full min-w-0">
              <SelectValue placeholder={t("traffic.selectFinding")} />
            </SelectTrigger>
            <SelectContent>
              {findings.map((f) => {
                const nid = f.node_id ?? f.id;
                const name = f.enr_name || f.vulnclass || nid;
                return (
                  <SelectItem key={nid} value={nid}>
                    <span className="block max-w-[22rem] truncate">
                      {f.task_id ? `${taskLabel({ id: f.task_id, description: f.task_description ?? "" })} · ` : ""}
                      {name}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!nodeId || saving} onClick={save}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
