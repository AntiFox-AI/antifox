"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LLMProfile } from "@/lib/types";

// ACTIVE_PROFILE is the sentinel Select value for "use the global active profile".
export const ACTIVE_PROFILE = "__active__";

// TaskFormValues is the shared shape edited by both the create-task and edit-task
// dialogs (task list + task detail). timeoutMin is the task-level timeout in
// minutes as a raw string (""/"0" = 不限时).
export interface TaskFormValues {
  name: string;
  description: string;
  goal: string;
  llmProfile: string; // ACTIVE_PROFILE sentinel or a profile id string
  timeoutMin: string;
  egress: string; // ""=跟随全局 | "proxy"=走全局代理 | "direct"=直连
}

export const BLANK_TASK_FORM: TaskFormValues = {
  name: "",
  description: "",
  goal: "",
  llmProfile: ACTIVE_PROFILE,
  timeoutMin: "",
  egress: "",
};

// taskFormFromTask seeds the form from an existing task (edit flow). timeout is not
// serialized by the task-list endpoint, so timeoutMin falls back to "" when absent.
export function taskFormFromTask(task: {
  name?: string;
  description?: string;
  goal?: string;
  llm_profile_id?: number;
  timeout_seconds?: number;
  egress?: string;
}): TaskFormValues {
  return {
    name: task.name ?? "",
    description: task.description ?? "",
    goal: task.goal ?? "",
    llmProfile: task.llm_profile_id ? String(task.llm_profile_id) : ACTIVE_PROFILE,
    timeoutMin: task.timeout_seconds ? String(Math.floor(task.timeout_seconds / 60)) : "",
    egress: task.egress ?? "",
  };
}

// taskFormToApi maps form values to the create/update API payload pieces.
export function taskFormToApi(v: TaskFormValues): {
  name: string;
  description: string;
  goal: string;
  timeoutSeconds: number;
  llmProfileId: number | undefined;
  egress: string;
} {
  return {
    name: v.name.trim(),
    description: v.description.trim(),
    goal: v.goal.trim(),
    timeoutSeconds: Math.max(0, Math.floor(Number(v.timeoutMin) || 0)) * 60,
    llmProfileId: v.llmProfile === ACTIVE_PROFILE ? undefined : Number(v.llmProfile),
    egress: v.egress,
  };
}

interface Props {
  values: TaskFormValues;
  onChange: (patch: Partial<TaskFormValues>) => void;
  profiles: LLMProfile[];
  // idPrefix keeps DOM ids unique when more than one form is mounted.
  idPrefix?: string;
  // showGoalHint surfaces the "changing the goal steers subsequent planning" note
  // (edit flows only — pointless on create).
  showGoalHint?: boolean;
}

// TaskFormFields renders the shared task field set (name/description/goal/LLM/timeout)
// used by the create-task and edit-task dialogs.
export function TaskFormFields({ values, onChange, profiles, idPrefix = "task", showGoalHint }: Props) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 py-2">
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-name`}>{t("tasks.name")}</Label>
        <Input
          id={`${idPrefix}-name`}
          placeholder={t("tasks.namePlaceholder")}
          value={values.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-description`}>{t("tasks.description")}</Label>
        <Textarea
          id={`${idPrefix}-description`}
          className="max-h-40 overflow-y-auto"
          placeholder={t("tasks.descPlaceholder")}
          value={values.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-goal`}>{t("tasks.goal")}</Label>
        <Textarea
          id={`${idPrefix}-goal`}
          className="max-h-40 overflow-y-auto"
          placeholder={t("tasks.goalPlaceholder")}
          value={values.goal}
          onChange={(e) => onChange({ goal: e.target.value })}
        />
        {showGoalHint && (
          <p className="text-muted-foreground text-xs">{t("tasks.goalEditHint")}</p>
        )}
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-llm-profile`}>{t("tasks.llmProfile")}</Label>
        <Select value={values.llmProfile} onValueChange={(v) => onChange({ llmProfile: v })}>
          <SelectTrigger id={`${idPrefix}-llm-profile`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ACTIVE_PROFILE}>{t("tasks.useActiveProfile")}</SelectItem>
            {profiles.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
                {p.is_default ? t("tasks.activeSuffix") : ""} · {p.model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{t("tasks.llmProfileHint")}</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-timeout-min`}>{t("tasks.timeoutLabel")}</Label>
        <Input
          id={`${idPrefix}-timeout-min`}
          type="number"
          min={0}
          className="w-40"
          placeholder={t("tasks.timeoutPlaceholder")}
          value={values.timeoutMin}
          onChange={(e) => onChange({ timeoutMin: e.target.value })}
        />
        <p className="text-muted-foreground text-xs">{t("tasks.timeoutHint")}</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-egress`}>{t("tasks.egressLabel")}</Label>
        <Select value={values.egress || "follow"} onValueChange={(v) => onChange({ egress: v === "follow" ? "" : v })}>
          <SelectTrigger id={`${idPrefix}-egress`} className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="follow">{t("tasks.egressFollow")}</SelectItem>
            <SelectItem value="proxy">{t("tasks.egressProxy")}</SelectItem>
            <SelectItem value="direct">{t("tasks.egressDirect")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
