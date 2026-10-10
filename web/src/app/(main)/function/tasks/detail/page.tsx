"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftIcon,
  PauseIcon,
  PlayIcon,
  BrainIcon,
  PencilIcon,
  RotateCwIcon,
} from "lucide-react";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/status-badge";
import {
  TaskFormFields,
  BLANK_TASK_FORM,
  taskFormFromTask,
  taskFormToApi,
  type TaskFormValues,
} from "@/components/task-form-fields";
import { api } from "@/lib/api";
import type { Task, LLMProfile } from "@/lib/types";

import { SessionsTab } from "./_tabs/sessions-tab";
import { OverviewTab } from "./_tabs/overview-tab";
import { GraphTab } from "./_tabs/graph-tab";
import { FindingsTab } from "./_tabs/findings-tab";
import { ReportTab } from "./_tabs/report-tab";
import { InterceptTab } from "./_tabs/intercept-tab";
import { AssetsTab } from "./_tabs/assets-tab";
import { KnowledgeTab } from "./_tabs/knowledge-tab";

const TAB_VALUES = [
  "sessions",
  "overview",
  "graph",
  "findings",
  "assets",
  "knowledge",
  "intercept",
  "report",
] as const;

function TaskDetailInner() {
  const { t: tr } = useTranslation();
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const [task, setTask] = React.useState<Task | null>(null);
  const [paused, setPaused] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [tab, setTab] = React.useState("sessions");
  const [interceptPendingCount, setInterceptPendingCount] = React.useState(0);
  const [profiles, setProfiles] = React.useState<LLMProfile[]>([]);
  const [editOpen, setEditOpen] = React.useState(false);
  const [form, setForm] = React.useState<TaskFormValues>(BLANK_TASK_FORM);
  const patchForm = React.useCallback(
    (p: Partial<TaskFormValues>) => setForm((f) => ({ ...f, ...p })),
    [],
  );

  React.useEffect(() => {
    let alive = true;
    const load = () =>
      api.interceptTask(id)
        .then((rows) => { if (alive) setInterceptPendingCount(rows.filter((r) => r.status === "pending").length); })
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);

  const load = React.useCallback(() => {
    Promise.all([
      api.tasks(),
      api.stats(id).catch(() => null),
    ])
      .then(([r, s]) => {
        const base = r.tasks.find((t) => t.id === id) ?? null;
        const at = (s as { active_task?: Partial<Task> & { paused?: boolean } } | null)?.active_task;
        if (base && at) {
          base.in_flight = at.in_flight;
          base.goals_total = at.goals_total;
          base.goals_met = at.goals_met;
          base.engine_mode = at.engine_mode;
          base.paused = at.paused;
        }
        setTask(base);
        setPaused(at?.paused ?? base?.paused ?? false);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [id]);
  React.useEffect(() => { load(); }, [load]);

  // load LLM profiles once for the edit dialog's profile picker.
  React.useEffect(() => {
    api.llmProfiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  async function togglePause() {
    const next = !paused;
    try {
      await api.controlTask(id, next ? "pause" : "resume");
      setPaused(next);
      toast.success(next ? tr("taskDetail.toast.paused") : tr("taskDetail.toast.resumed"));
    } catch (e) {
      toast.error(tr("taskDetail.toast.opFailed", { msg: (e as Error).message }));
    }
  }

  async function rerun() {
    try {
      await api.controlTask(id, "rerun");
      setPaused(false);
      toast.success(tr("taskDetail.toast.rerun"));
      load();
    } catch (e) {
      toast.error(tr("taskDetail.toast.opFailed", { msg: (e as Error).message }));
    }
  }

  function openEdit() {
    if (task) setForm(taskFormFromTask(task));
    setEditOpen(true);
  }

  async function saveEdit() {
    const v = taskFormToApi(form);
    if (!v.description || !v.goal) {
      toast.error(tr("tasks.toast.fillDescGoal"));
      return;
    }
    try {
      await api.updateTask(id, {
        name: v.name,
        description: v.description,
        goal: v.goal,
        timeout_seconds: v.timeoutSeconds,
        llm_profile_id: v.llmProfileId ?? null,
      });
      toast.success(tr("taskDetail.toast.saved"));
      setEditOpen(false);
      load();
    } catch (e) {
      toast.error(tr("taskDetail.toast.opFailed", { msg: (e as Error).message }));
    }
  }

  if (!task) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
        <p className="text-muted-foreground">{loaded ? tr("taskDetail.notFound", { id }) : tr("common.loading")}</p>
        {loaded && (
          <Button asChild variant="outline">
            <Link href="/function/tasks">
              <ArrowLeftIcon /> {tr("taskDetail.backToList")}
            </Link>
          </Button>
        )}
      </div>
    );
  }

  const engineMode = paused ? "paused" : task.engine_mode ?? "idle";
  // 停机态 = 终态(done/failed/timeout) 或 stalled → 可「继续运行」。
  const terminal = ["done", "failed", "timeout"].includes(task.status);
  const stopped = terminal || !!task.stalled || task.engine_mode === "stalled";

  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="flex flex-1 flex-col gap-0"
    >
      {/* Top fixed area */}
      <header className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-background/95 px-4 py-2.5 backdrop-blur lg:px-6">
        <div className="flex items-center gap-2">
          <SidebarTrigger className="-ml-1" />
          <Button asChild variant="ghost" size="icon" className="size-7">
            <Link href="/function/tasks">
              <ArrowLeftIcon />
            </Link>
          </Button>
          <h1 className="max-w-md truncate text-sm font-semibold" title={task.description}>
            {task.description}
          </h1>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {task.id}
          </code>
          <Separator orientation="vertical" className="mx-1 h-4" />
          {/* status pills */}
          <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
            <BrainIcon className="size-3.5 text-emerald-500" /> {tr("taskDetail.header.llmConfigured")}
          </span>
          <StatusBadge domain="engine" value={engineMode} dot />
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={openEdit}>
              <PencilIcon /> {tr("taskDetail.header.edit")}
            </Button>
            {stopped && (
              <Button size="sm" variant="default" onClick={rerun}>
                <RotateCwIcon /> {tr("taskDetail.header.rerun")}
              </Button>
            )}
            {!terminal && (
              <Button
                size="sm"
                variant={paused ? "default" : "outline"}
                onClick={togglePause}
              >
                {paused ? <PlayIcon /> : <PauseIcon />}
                {paused ? tr("taskDetail.header.resume") : tr("taskDetail.header.pause")}
              </Button>
            )}
          </div>
        </div>
        <p className="truncate text-xs text-muted-foreground">{task.goal}</p>
        {/* Tabs */}
        <TabsList variant="default">
          {TAB_VALUES.map((v) => (
            <TabsTrigger key={v} value={v}>
              {tr(`taskDetail.tabs.${v}`)}
              {v === "intercept" && interceptPendingCount > 0 && (
                <span className="ml-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white">
                  {interceptPendingCount > 99 ? "99+" : interceptPendingCount}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </header>

      {/* Tab content */}
      <div className="flex-1 p-4 lg:p-6">
        <TabsContent value="sessions" className="mt-0">
          <SessionsTab taskId={id} />
        </TabsContent>
        <TabsContent value="overview" className="mt-0">
          <OverviewTab taskId={id} />
        </TabsContent>
        <TabsContent value="graph" className="mt-0">
          <GraphTab taskId={id} />
        </TabsContent>
        <TabsContent value="findings" className="mt-0">
          <FindingsTab taskId={id} />
        </TabsContent>
        <TabsContent value="assets" className="mt-0">
          <AssetsTab taskId={id} />
        </TabsContent>
        <TabsContent value="knowledge" className="mt-0">
          <KnowledgeTab taskId={id} />
        </TabsContent>
        <TabsContent value="intercept" className="mt-0">
          <InterceptTab taskId={id} />
        </TabsContent>
        <TabsContent value="report" className="mt-0">
          <ReportTab taskId={id} />
        </TabsContent>
      </div>

      {/* Edit task dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{tr("tasks.editTitle")}</DialogTitle>
            <DialogDescription>{tr("tasks.editDialogDesc")}</DialogDescription>
          </DialogHeader>
          <TaskFormFields
            idPrefix="detail-edit"
            values={form}
            onChange={patchForm}
            profiles={profiles}
            showGoalHint
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              {tr("common.cancel")}
            </Button>
            <Button onClick={saveEdit}>{tr("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}

// useSearchParams must sit under a Suspense boundary for static export.
export default function TaskDetailPage() {
  return (
    <React.Suspense fallback={null}>
      <TaskDetailInner />
    </React.Suspense>
  );
}
