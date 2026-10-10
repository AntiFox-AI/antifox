"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  PlusIcon,
  Trash2Icon,
  ArrowRightIcon,
  StarIcon,
  SearchIcon,
  XIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PencilIcon,
  RotateCwIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TablePagination } from "@/components/table-pagination";
import {
  TaskFormFields,
  BLANK_TASK_FORM,
  taskFormFromTask,
  taskFormToApi,
  type TaskFormValues,
} from "@/components/task-form-fields";
import { api } from "@/lib/api";
import type { Task, TaskStatus, LLMProfile } from "@/lib/types";

// fmtTokens renders a compact token count (1234 → 1.2k, 2_000_000 → 2M).
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

// fmtDuration renders a run duration in seconds as a compact human string.
function fmtDuration(sec: number): string {
  if (sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// taskDuration is the task's run duration in seconds: created → now while running,
// created → completion for a finished task, else created → last activity. 0 when it
// never ran (no activity yet).
function taskDuration(task: Task, nowSec: number): number {
  const start = task.created_unix ?? 0;
  if (!start) return 0;
  const end =
    task.status === "running"
      ? nowSec
      : task.completed_unix && task.completed_unix > 0
        ? task.completed_unix
        : task.last_activity_unix ?? 0;
  return end > start ? end - start : 0;
}

// fmtDateTime renders a unix-seconds timestamp as a compact local date-time
// (MM-DD HH:mm), or "—" when unset.
function fmtDateTime(unix?: number): string {
  if (!unix || unix <= 0) return "—";
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STATUS_VALUES: TaskStatus[] = [
  "created",
  "running",
  "paused",
  "done",
  "failed",
  "timeout",
];

export default function TasksPage() {
  const { t } = useTranslation();
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [profiles, setProfiles] = React.useState<LLMProfile[]>([]);
  // form is shared by the create dialog and the edit dialog (only one open at a time).
  const [form, setForm] = React.useState<TaskFormValues>(BLANK_TASK_FORM);
  const patchForm = React.useCallback(
    (p: Partial<TaskFormValues>) => setForm((f) => ({ ...f, ...p })),
    [],
  );
  const [open, setOpen] = React.useState(false); // create dialog
  const [editing, setEditing] = React.useState<Task | null>(null); // edit dialog target
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<TaskStatus | "all">("all");
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const [nowSec, setNowSec] = React.useState(() => Math.floor(Date.now() / 1000));

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (!q) return true;
      return (
        t.description.toLowerCase().includes(q) ||
        t.goal.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q)
      );
    });
  }, [tasks, query, statusFilter]);

  // reset to page 1 whenever filters change
  React.useEffect(() => { setPage(1); }, [query, statusFilter]);

  const paginated = React.useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  );

  const load = React.useCallback(() => {
    api.tasks()
      .then((r) => {
        setTasks(r.tasks.map((t) => (t.id === r.active ? { ...t, active: true } : t)));
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    load();
    const i = setInterval(load, 3000);
    return () => clearInterval(i);
  }, [load]);

  // load LLM profiles once for the create-task profile picker.
  React.useEffect(() => {
    api.llmProfiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  // tick every second so running tasks' 运行时长 counts up live.
  React.useEffect(() => {
    const i = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(i);
  }, []);

  async function createTask() {
    const v = taskFormToApi(form);
    if (!v.description || !v.goal) {
      toast.error(t("tasks.toast.fillDescGoal"));
      return;
    }
    try {
      await api.createTask(v.name, v.description, v.goal, v.llmProfileId, v.timeoutSeconds);
      toast.success(t("tasks.toast.created"));
      setForm(BLANK_TASK_FORM);
      setOpen(false);
      load();
    } catch (e) {
      toast.error(t("tasks.toast.createFailed", { msg: (e as Error).message }));
    }
  }

  function openEdit(task: Task) {
    setForm(taskFormFromTask(task));
    setEditing(task);
  }

  async function saveEdit() {
    if (!editing) return;
    const v = taskFormToApi(form);
    if (!v.description || !v.goal) {
      toast.error(t("tasks.toast.fillDescGoal"));
      return;
    }
    try {
      await api.updateTask(editing.id, {
        name: v.name,
        description: v.description,
        goal: v.goal,
        timeout_seconds: v.timeoutSeconds,
        llm_profile_id: v.llmProfileId ?? null,
      });
      toast.success(t("tasks.saved"));
      setEditing(null);
      load();
    } catch (e) {
      toast.error(t("tasks.saveFailed", { msg: (e as Error).message }));
    }
  }

  async function control(id: string, action: "pause" | "resume" | "rerun") {
    try {
      await api.controlTask(id, action);
      toast.success(
        action === "rerun"
          ? t("tasks.rerunToast")
          : action === "pause"
            ? t("tasks.pauseToast")
            : t("tasks.resumeToast"),
      );
      load();
    } catch (e) {
      toast.error(t("tasks.opFailed", { msg: (e as Error).message }));
    }
  }

  async function deleteTask(id: string) {
    try {
      await api.deleteTask(id);
      toast.success(t("tasks.toast.deleted"));
      load();
    } catch (e) {
      toast.error(t("tasks.toast.deleteFailed", { msg: (e as Error).message }));
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 px-0 pt-6">
        <div className="flex flex-wrap items-center gap-2 px-4 lg:px-6">
          <div className="relative w-full sm:max-w-xs">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              placeholder={t("tasks.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("tasks.clearSearch")}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
              >
                <XIcon className="size-4" />
              </button>
            )}
          </div>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as TaskStatus | "all")}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder={t("common.status")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("tasks.allStatus")}</SelectItem>
              {STATUS_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`status.task.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("tasks.filterCount", { filtered: filtered.length, total: tasks.length })}
          </span>
          <Dialog
            open={open}
            onOpenChange={(o) => {
              if (o) setForm(BLANK_TASK_FORM); // fresh form each time create opens
              setOpen(o);
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" className="ml-auto">
                <PlusIcon /> {t("tasks.newTask")}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{t("tasks.newTask")}</DialogTitle>
                <DialogDescription>
                  {t("tasks.dialogDesc")}
                </DialogDescription>
              </DialogHeader>
              <TaskFormFields
                idPrefix="create"
                values={form}
                onChange={patchForm}
                profiles={profiles}
              />
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">{t("common.cancel")}</Button>
                </DialogClose>
                <Button onClick={createTask}>{t("common.create")}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {tasks.length === 0 ? (
          <div className="text-muted-foreground mx-4 flex items-center justify-center rounded-lg border border-dashed py-20 text-sm lg:mx-6">
            {t("tasks.emptyNoTasks")}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-muted-foreground mx-4 flex items-center justify-center rounded-lg border border-dashed py-20 text-sm lg:mx-6">
            {t("tasks.emptyNoMatch")}
          </div>
        ) : (
          <Table className="**:data-[slot='table-cell']:px-4 **:data-[slot='table-head']:px-4">
            <TableHeader className="[&_tr]:border-t">
              <TableRow>
                <TableHead className="font-mono">ID</TableHead>
                <TableHead>{t("tasks.description")}</TableHead>
                <TableHead>{t("tasks.goal")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead className="text-center">{t("tasks.goalProgress")}</TableHead>
                <TableHead className="text-right">{t("common.createdAt")}</TableHead>
                <TableHead className="text-right">{t("tasks.duration")}</TableHead>
                <TableHead className="text-right">Token</TableHead>
                <TableHead className="sticky right-0 z-10 bg-card text-right shadow-[-1px_0_0_0_hsl(var(--border))]">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginated.map((task) => (
                <TableRow key={task.id} className="group border-border/60">
                  <TableCell>
                    <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{task.id}</code>
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex max-w-xs items-center gap-2">
                      <span className="truncate" title={task.description}>
                        {task.description}
                      </span>
                      {task.active && (
                        <StarIcon className="size-4 shrink-0 fill-amber-400 text-amber-400" />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-xs truncate">{task.goal}</TableCell>
                  <TableCell>
                    <StatusBadge domain="task" value={task.status} dot />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-center text-xs tabular-nums">
                    {typeof task.goals_total === "number" && task.goals_total > 0
                      ? `${task.goals_met}/${task.goals_total}`
                      : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-xs whitespace-nowrap tabular-nums">
                    {fmtDateTime(task.created_unix)}
                  </TableCell>
                  <TableCell className="text-right text-xs whitespace-nowrap tabular-nums">
                    {(() => {
                      const secs = taskDuration(task, nowSec);
                      if (secs <= 0) return <span className="text-muted-foreground">—</span>;
                      return (
                        <span className={task.status === "running" ? "text-foreground" : "text-muted-foreground"}>
                          {fmtDuration(secs)}
                        </span>
                      );
                    })()}
                  </TableCell>
                  <TableCell
                    className="text-right text-xs whitespace-nowrap tabular-nums"
                    title={
                      task.tokens
                        ? t("tasks.tokenTooltip", {
                            input: task.tokens.input_tokens,
                            cache: task.tokens.cache_read_tokens,
                            output: task.tokens.output_tokens,
                          })
                        : undefined
                    }
                  >
                    {task.tokens ? (
                      <span className="text-muted-foreground">
                        {t("tasks.tokenIn")} <span className="text-foreground">{fmtTokens(task.tokens.input_tokens)}</span>
                        {` · ${t("tasks.tokenCache")} `}
                        <span className="text-foreground">{fmtTokens(task.tokens.cache_read_tokens)}</span>
                        {` · ${t("tasks.tokenOut")} `}
                        <span className="text-foreground">{fmtTokens(task.tokens.output_tokens)}</span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="sticky right-0 z-10 bg-card text-right shadow-[-1px_0_0_0_hsl(var(--border))] group-hover:bg-muted/50">
                    {(() => {
                      const terminal = ["done", "failed", "timeout"].includes(task.status);
                      const paused = !!task.paused;
                      const stalled = !!task.stalled || task.engine_mode === "stalled";
                      const stopped = terminal || stalled;
                      return (
                        <div className="flex items-center justify-end gap-2">
                          <Button asChild size="sm">
                            <Link href={`/function/tasks/detail?id=${task.id}`}>
                              {t("tasks.enter")} <ArrowRightIcon />
                            </Link>
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="icon" variant="outline" aria-label={t("common.actions")}>
                                <MoreHorizontalIcon />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {!terminal && (
                                <DropdownMenuItem
                                  onSelect={() => control(task.id, paused ? "resume" : "pause")}
                                >
                                  {paused ? <PlayIcon /> : <PauseIcon />}
                                  {paused ? t("tasks.resume") : t("tasks.pause")}
                                </DropdownMenuItem>
                              )}
                              {stopped && (
                                <DropdownMenuItem onSelect={() => control(task.id, "rerun")}>
                                  <RotateCwIcon /> {t("tasks.rerun")}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onSelect={() => openEdit(task)}>
                                <PencilIcon /> {t("tasks.edit")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => deleteTask(task.id)}
                              >
                                <Trash2Icon /> {t("common.delete")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      );
                    })()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={filtered.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </CardContent>

      {/* Edit task dialog — shares the create form fields + state. */}
      <Dialog open={editing !== null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("tasks.editTitle")}</DialogTitle>
            <DialogDescription>{t("tasks.editDialogDesc")}</DialogDescription>
          </DialogHeader>
          <TaskFormFields
            idPrefix="edit"
            values={form}
            onChange={patchForm}
            profiles={profiles}
            showGoalHint
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={saveEdit}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
