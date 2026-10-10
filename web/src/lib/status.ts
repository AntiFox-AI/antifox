// Centralised status → color/label semantics, reused across the whole app.
// Spec §8.3: 意图 / 覆盖 / 任务 / 严重度 each have a consistent color set.

import i18n from "@/i18n/config";

export type Tone =
  | "neutral"
  | "blue"
  | "green"
  | "amber"
  | "red"
  | "crimson"
  | "violet"
  | "slate";

export const toneClasses: Record<Tone, string> = {
  neutral:
    "bg-muted text-muted-foreground border-transparent",
  blue: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20",
  green:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  amber:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20",
  red: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20",
  // critical: solid deep red so it clearly outranks high's light-red tint.
  crimson: "bg-red-600 text-white border-red-700 dark:bg-red-600 dark:text-white dark:border-red-500",
  violet:
    "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/20",
  slate:
    "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/20",
};

export const toneDot: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  crimson: "bg-red-600",
  violet: "bg-violet-500",
  slate: "bg-slate-500",
};

interface StatusMeta {
  label: string;
  tone: Tone;
}

// 每个 domain 的 key → tone 映射；label 文案改由 i18n 提供（status.<domain>.<key>），
// 在 statusMeta() 访问时经 i18n.t() 取译文 → 消费端零改动，切换语言随组件重渲染即时更新。
const tones = {
  intent: { open: "slate", running: "blue", done: "green", blocked: "red", exhausted: "violet" },
  task: { created: "slate", running: "blue", paused: "amber", done: "green", failed: "red", timeout: "amber" },
  severity: { critical: "crimson", high: "red", medium: "amber", low: "slate" },
  engine: { exploring: "blue", paused: "amber", stalled: "red", idle: "neutral" },
  goal: { open: "blue", met: "green", abandoned: "slate" },
  audit: { allow: "green", block: "red" },
  node: { observed: "slate", confirmed: "green", tombstoned: "neutral" },
  findingStatus: { open: "amber", confirmed: "red", fixed: "green", false_positive: "slate", ignored: "neutral" },
} as const satisfies Record<string, Record<string, Tone>>;

const maps = tones;

export type StatusDomain = keyof typeof maps;

export function statusMeta(domain: StatusDomain, key: string): StatusMeta {
  const tone: Tone = (maps[domain] as Record<string, Tone>)[key] ?? "neutral";
  return { label: i18n.t(`status.${domain}.${key}`, { defaultValue: key }), tone };
}
