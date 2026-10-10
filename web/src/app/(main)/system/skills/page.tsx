"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  BarChart3Icon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FileTextIcon,
  FilePlusIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { Agent, SkillItem, SkillStat, SkillStatsResp, MCPServer } from "@/lib/types";

// ── Tree node ──────────────────────────────────────────────────────────────
interface TreeNode {
  name: string;
  path: string;   // relative to skill root, dirs WITHOUT trailing slash
  type: "file" | "dir";
  children: TreeNode[];
}

// Backend returns dirs as "scripts/" (trailing slash) and files as "scripts/a.py".
function buildTree(entries: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  function ensureDir(dirPath: string, parentNodes: TreeNode[]): TreeNode[] {
    if (dirMap.has(dirPath)) return dirMap.get(dirPath)!.children;
    const parts = dirPath.split("/");
    let nodes = root;
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!dirMap.has(cur)) {
        const d: TreeNode = { name: part, path: cur, type: "dir", children: [] };
        nodes.push(d);
        dirMap.set(cur, d);
      }
      nodes = dirMap.get(cur)!.children;
    }
    return nodes;
  }

  for (const entry of [...entries].sort()) {
    if (entry.endsWith("/")) {
      // Explicit directory entry — ensure the node exists (may already be created)
      ensureDir(entry.slice(0, -1), root);
    } else {
      // File — ensure parent dirs exist, then push file node
      const parts = entry.split("/");
      let nodes = root;
      let cur = "";
      for (let i = 0; i < parts.length - 1; i++) {
        cur = cur ? `${cur}/${parts[i]}` : parts[i];
        if (!dirMap.has(cur)) {
          const d: TreeNode = { name: parts[i], path: cur, type: "dir", children: [] };
          nodes.push(d);
          dirMap.set(cur, d);
        }
        nodes = dirMap.get(cur)!.children;
      }
      const fname = parts[parts.length - 1];
      if (fname) nodes.push({ name: fname, path: entry, type: "file", children: [] });
    }
  }
  return root;
}

// ── State types ───────────────────────────────────────────────────────────
type Selected =
  | { skill: string; path: null }
  | { skill: string; path: string };

type Creating = {
  skill: string;
  inDir: string;
  kind: "file" | "dir";
} | null;

// ── Page ──────────────────────────────────────────────────────────────────
export default function SkillsPage() {
  const { t } = useTranslation();
  const [skills, setSkills] = React.useState<SkillItem[]>([]);
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [selected, setSelected] = React.useState<Selected | null>(null);
  const [visibility, setVisibility] = React.useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  // file editor
  const [fileContent, setFileContent] = React.useState("");
  const [fileLoading, setFileLoading] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // inline create — using a ref to avoid stale closure in onBlur
  const [creating, setCreating] = React.useState<Creating>(null);
  const [newEntryName, setNewEntryName] = React.useState("");
  const inlineRef = React.useRef<HTMLInputElement>(null);
  // cancelRef prevents onBlur from committing when Escape was pressed
  const cancelRef = React.useRef(false);

  // new skill dialog
  const [newOpen, setNewOpen] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newDesc, setNewDesc] = React.useState("");
  const [newLicense, setNewLicense] = React.useState("");
  const [newCompat, setNewCompat] = React.useState("");
  const [newInst, setNewInst] = React.useState("");
  const [newMcps, setNewMcps] = React.useState<string[]>([]);
  const [newVisibility, setNewVisibility] = React.useState<string[]>([]);
  const [mcpOptions, setMcpOptions] = React.useState<MCPServer[]>([]);
  const [creatingSkill, setCreatingSkill] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const uploadRef = React.useRef<HTMLInputElement>(null);

  // skill detail — MCP edit state (optimistic, rolls back on error)
  const [detailMcps, setDetailMcps] = React.useState<string[]>([]);

  // 调用统计（复用可观测性）
  const [stats, setStats] = React.useState<SkillStatsResp | null>(null);
  const [statsOpen, setStatsOpen] = React.useState(false);
  const statByName = React.useMemo(() => {
    const m: Record<string, SkillStat> = {};
    stats?.skills.forEach((s) => { m[s.skill_name] = s; });
    return m;
  }, [stats]);
  const loadStats = React.useCallback(() => {
    api.skillStats().then(setStats).catch(() => {});
  }, []);

  // ── Data ──────────────────────────────────────────────────────────────────
  const load = React.useCallback(() => {
    api.agents().then(setAgents).catch(() => {});
    api.mcpServers().then(setMcpOptions).catch(() => {});
    api.skillStats().then(setStats).catch(() => {});
    api.skills().then((ss) => {
      setSkills(ss);
      ss.forEach((s) =>
        api.skillVisibility(s.name)
          .then((ids) => setVisibility((v) => ({ ...v, [s.name]: ids })))
          .catch(() => {}),
      );
    }).catch(() => {});
  }, []);

  React.useEffect(() => { load(); }, [load]);

  // ── Upload a .zip skill ───────────────────────────────────────────────────
  async function uploadZip(file: File, overwrite = false) {
    setUploading(true);
    try {
      const r = await api.uploadSkill(file, overwrite);
      toast.success(t("skills.toast.installed", { name: r.name, count: r.files }));
      load();
    } catch (e) {
      const msg = (e as Error).message;
      // offer overwrite when the skill already exists
      if (!overwrite && msg.includes("已存在")) {
        if (window.confirm(`${msg}\n\n${t("skills.confirmOverwrite")}`)) {
          await uploadZip(file, true);
          return;
        }
      } else {
        toast.error(t("skills.toast.uploadFailed", { msg }));
      }
    } finally {
      setUploading(false);
    }
  }
  function onUploadPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // reset so picking the same file again re-fires
    if (f) uploadZip(f);
  }

  React.useEffect(() => {
    if (creating) {
      // Small timeout so the element is actually in the DOM before focusing
      setTimeout(() => inlineRef.current?.focus(), 20);
    }
  }, [creating]);

  // Sync detail-panel MCP state when the selected skill changes.
  React.useEffect(() => {
    if (!selected || selected.path !== null) return;
    const sk = skills.find((s) => s.name === selected.skill);
    setDetailMcps(sk?.mcps ?? []);
  }, [selected, skills]);

  React.useEffect(() => {
    if (!selected || selected.path === null) { setFileContent(""); setDirty(false); return; }
    setFileLoading(true);
    api.readSkillFile(selected.skill, selected.path)
      .then((c) => { setFileContent(c); setDirty(false); })
      .catch(() => toast.error(t("skills.toast.readFailed")))
      .finally(() => setFileLoading(false));
  }, [selected]);

  // ── Expand helpers ────────────────────────────────────────────────────────
  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function ensureExpanded(skill: string, dirPath: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(skill);
      if (dirPath) {
        let cur = "";
        for (const part of dirPath.split("/")) {
          cur = cur ? `${cur}/${part}` : part;
          next.add(`${skill}:${cur}`);
        }
      }
      return next;
    });
  }

  // ── Inline create ─────────────────────────────────────────────────────────
  function startCreate(skill: string, inDir: string, kind: "file" | "dir") {
    cancelRef.current = false;
    ensureExpanded(skill, inDir);
    setCreating({ skill, inDir, kind });
    setNewEntryName("");
  }

  // Use a ref snapshot so commitCreate reads the latest creating value
  // without depending on potentially stale closure state.
  const creatingRef = React.useRef<Creating>(null);
  React.useEffect(() => { creatingRef.current = creating; }, [creating]);
  const newEntryRef = React.useRef("");
  React.useEffect(() => { newEntryRef.current = newEntryName; }, [newEntryName]);

  async function commitCreate() {
    if (cancelRef.current) { cancelRef.current = false; return; }
    const c = creatingRef.current;
    const name = newEntryRef.current.trim();
    setCreating(null);
    setNewEntryName("");
    if (!c || !name) return;

    const fullPath = c.inDir ? `${c.inDir}/${name}` : name;
    try {
      if (c.kind === "dir") {
        await api.createSkillDir(c.skill, fullPath);
        toast.success(t("skills.toast.folderCreated", { path: fullPath }));
        ensureExpanded(c.skill, fullPath);
      } else {
        await api.writeSkillFile(c.skill, fullPath, "");
        toast.success(t("skills.toast.fileCreated", { path: fullPath }));
        setSelected({ skill: c.skill, path: fullPath });
        ensureExpanded(c.skill, c.inDir);
      }
      load();
    } catch (e) {
      toast.error(t("skills.toast.createFailed", { msg: (e as Error).message }));
    }
  }

  function cancelCreate() {
    cancelRef.current = true;
    setCreating(null);
    setNewEntryName("");
  }

  async function deletePath(skill: string, path: string) {
    try {
      await api.deleteSkillPath(skill, path);
      toast.success(t("skills.toast.deleted", { path }));
      if (selected?.skill === skill && selected.path === path) setSelected(null);
      load();
    } catch (e) {
      toast.error(t("skills.toast.deleteFailed", { msg: (e as Error).message }));
    }
  }

  async function deleteSkill(name: string) {
    try {
      await api.deleteSkill(name);
      toast.success(t("skills.toast.skillDeleted", { name }));
      if (selected?.skill === name) setSelected(null);
      load();
    } catch (e) {
      toast.error(t("skills.toast.deleteFailed", { msg: (e as Error).message }));
    }
  }

  async function saveFile() {
    if (!selected || selected.path === null) return;
    setSaving(true);
    try {
      await api.writeSkillFile(selected.skill, selected.path, fileContent);
      toast.success(t("skills.toast.saved"));
      setDirty(false);
    } catch (e) {
      toast.error(t("skills.toast.saveFailed", { msg: (e as Error).message }));
    } finally { setSaving(false); }
  }

  async function toggleSkillMcp(skillName: string, mcpName: string, mcpOn: boolean) {
    const next = mcpOn
      ? [...detailMcps, mcpName]
      : detailMcps.filter((n) => n !== mcpName);
    setDetailMcps(next);
    try {
      await api.updateSkillMeta(skillName, { mcps: next });
      toast.success(mcpOn
        ? t("skills.toast.mcpLinked", { name: mcpName })
        : t("skills.toast.mcpUnlinked", { name: mcpName }));
      load();
    } catch (e) {
      // roll back on error
      setDetailMcps(detailMcps);
      toast.error(t("skills.toast.actionFailed", { msg: (e as Error).message }));
    }
  }

  async function toggleVisibility(skillName: string, agentId: string, agentName: string) {
    const on = (visibility[skillName] ?? []).includes(agentId);
    try {
      await api.toggleSkillVisibility(agentId, skillName, !on);
      toast.success(on
        ? t("skills.toast.visibilityRevoked", { name: agentName })
        : t("skills.toast.visibilityGranted", { name: agentName }));
      const ids = await api.skillVisibility(skillName);
      setVisibility((v) => ({ ...v, [skillName]: ids }));
    } catch (e) {
      toast.error(t("skills.toast.actionFailed", { msg: (e as Error).message }));
    }
  }

  async function createNewSkill() {
    if (!newName.trim()) { toast.error(t("skills.toast.nameRequired")); return; }
    if (!newDesc.trim()) { toast.error(t("skills.toast.descRequired")); return; }
    setCreatingSkill(true);
    try {
      const name = newName.trim();
      await api.createSkill({
        name, description: newDesc.trim(),
        license: newLicense.trim() || undefined,
        compatibility: newCompat.trim() || undefined,
        mcps: newMcps.length ? newMcps : undefined,
        instructions: newInst.trim() || undefined,
      });
      // apply initial visibility (fire-and-forget per agent; best-effort)
      await Promise.all(newVisibility.map((id) => api.toggleSkillVisibility(id, name, true)));
      toast.success(t("skills.toast.skillCreated"));
      setNewOpen(false);
      setNewName(""); setNewDesc(""); setNewLicense(""); setNewCompat(""); setNewInst("");
      setNewMcps([]); setNewVisibility([]);
      load();
    } catch (e) {
      toast.error(t("skills.toast.createFailed", { msg: (e as Error).message }));
    } finally { setCreatingSkill(false); }
  }

  // ── Inline input JSX helper (NOT a React component — avoids remount on re-render) ──
  // Defined as a plain function returning JSX so React never sees a new component type.
  function inlineInputJSX(indent: number) {
    return (
      <div
        key="__inline_create__"
        className="flex items-center gap-1 py-0.5 pr-2"
        style={{ paddingLeft: indent }}
      >
        {creating?.kind === "dir"
          ? <FolderIcon className="size-3.5 shrink-0 text-amber-500" />
          : <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
        }
        <Input
          ref={inlineRef}
          className="h-6 flex-1 px-1 py-0 font-mono text-xs"
          placeholder={creating?.kind === "dir" ? "folder-name" : "filename.py"}
          value={newEntryName}
          onChange={(e) => setNewEntryName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { cancelRef.current = false; void commitCreate(); }
            if (e.key === "Escape") cancelCreate();
          }}
          onBlur={() => { void commitCreate(); }}
        />
      </div>
    );
  }

  // ── Recursive tree renderer ───────────────────────────────────────────────
  function renderTree(nodes: TreeNode[], skill: string, depth: number): React.ReactNode {
    const baseIndent = 8 + depth * 14;
    return nodes.map((node) => {
      if (node.type === "dir") {
        const key = `${skill}:${node.path}`;
        const open = expanded.has(key);
        return (
          <div key={node.path}>
            <div
              className="group flex cursor-pointer select-none items-center gap-1 rounded py-0.5 pr-1 text-sm hover:bg-muted"
              style={{ paddingLeft: baseIndent }}
              onClick={() => toggleExpanded(key)}
            >
              <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
              {open
                ? <FolderOpenIcon className="size-3.5 shrink-0 text-amber-500" />
                : <FolderIcon className="size-3.5 shrink-0 text-amber-500" />
              }
              <span className="flex-1 truncate">{node.name}</span>
              <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
                <Button size="icon" variant="ghost" className="size-5" title={t("skills.newFile")}
                  onClick={(e) => { e.stopPropagation(); startCreate(skill, node.path, "file"); }}>
                  <FilePlusIcon className="size-3 text-muted-foreground" />
                </Button>
                <Button size="icon" variant="ghost" className="size-5" title={t("skills.newFolder")}
                  onClick={(e) => { e.stopPropagation(); startCreate(skill, node.path, "dir"); }}>
                  <FolderPlusIcon className="size-3 text-muted-foreground" />
                </Button>
                <Button size="icon" variant="ghost" className="size-5" title={t("skills.deleteFolder")}
                  onClick={(e) => { e.stopPropagation(); deletePath(skill, node.path); }}>
                  <Trash2Icon className="size-3 text-destructive" />
                </Button>
              </span>
            </div>
            {open && (
              <>
                {renderTree(node.children, skill, depth + 1)}
                {creating?.skill === skill && creating.inDir === node.path &&
                  inlineInputJSX(baseIndent + 14)}
              </>
            )}
          </div>
        );
      }

      // file node
      const isSelected = selected?.skill === skill && selected.path === node.path;
      return (
        <div
          key={node.path}
          className={cn(
            "group flex cursor-pointer select-none items-center gap-1 rounded py-0.5 pr-1 text-sm",
            isSelected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
          )}
          style={{ paddingLeft: baseIndent + 16 }}
          onClick={() => setSelected({ skill, path: node.path })}
        >
          <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate font-mono text-xs">{node.name}</span>
          <Button size="icon" variant="ghost" className="ml-auto hidden size-5 group-hover:flex"
            title={t("skills.deleteFile")}
            onClick={(e) => { e.stopPropagation(); deletePath(skill, node.path); }}>
            <Trash2Icon className="size-3 text-destructive" />
          </Button>
        </div>
      );
    });
  }

  const selectedSkill = selected
    ? skills.find((s) => s.name === selected.skill) ?? null
    : null;

  return (
    <div data-content-padding="false" className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-2.5 lg:px-6">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-sm font-semibold leading-tight">Skill</h1>
          <p className="text-muted-foreground text-xs">{t("skills.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          {stats && (
            <span className="text-muted-foreground hidden text-xs sm:inline">
              {t("skills.stats.summaryChip", {
                invoked: stats.invoked_count,
                installed: stats.installed_count,
                calls: stats.total_calls,
              })}
            </span>
          )}
          <Button size="sm" variant="outline" onClick={() => { loadStats(); setStatsOpen(true); }}>
            <BarChart3Icon className="size-3.5" />{t("skills.stats.button")}
          </Button>
        </div>
      </div>
      <div className="flex flex-1 overflow-hidden">
        {/* ── 左侧文件树 ── */}
        <div className="flex w-64 shrink-0 flex-col border-r">
          <div className="flex flex-col gap-2 border-b p-2">
            <Button size="sm" variant="outline" className="w-full" onClick={() => setNewOpen(true)}>
              <PlusIcon className="size-3.5" />{t("skills.newSkill")}
            </Button>
            <input
              ref={uploadRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={onUploadPick}
            />
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={uploading}
              onClick={() => uploadRef.current?.click()}
              title={t("skills.uploadZipTitle")}
            >
              <UploadIcon className="size-3.5" />
              {uploading ? t("skills.uploading") : t("skills.uploadZip")}
            </Button>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-1">
              {skills.map((s) => {
                const isOpen = expanded.has(s.name);
                const tree = buildTree(s.files);
                const isSkillSelected = selected?.skill === s.name && selected.path === null;
                return (
                  <div key={s.name}>
                    {/* skill 根节点 */}
                    <div
                      className={cn(
                        "group flex cursor-pointer select-none items-center gap-1 rounded px-2 py-1 text-sm",
                        isSkillSelected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                      )}
                      onClick={() => {
                        toggleExpanded(s.name);
                        setSelected({ skill: s.name, path: null });
                      }}
                    >
                      <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", isOpen && "rotate-90")} />
                      {isOpen
                        ? <FolderOpenIcon className="size-3.5 shrink-0 text-blue-500" />
                        : <FolderIcon className="size-3.5 shrink-0 text-blue-500" />
                      }
                      <span className="flex-1 truncate font-semibold">{s.name}</span>
                      {(statByName[s.name]?.calls ?? 0) > 0 && (
                        <Badge
                          variant="secondary"
                          className="shrink-0 px-1.5 py-0 text-[10px] tabular-nums group-hover:hidden"
                          title={t("skills.stats.callsTitle", { n: statByName[s.name].calls })}
                        >
                          {statByName[s.name].calls}
                        </Badge>
                      )}
                      <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
                        <Button size="icon" variant="ghost" className="size-5" title={t("skills.newFile")}
                          onClick={(e) => { e.stopPropagation(); startCreate(s.name, "", "file"); }}>
                          <FilePlusIcon className="size-3 text-muted-foreground" />
                        </Button>
                        <Button size="icon" variant="ghost" className="size-5" title={t("skills.newFolder")}
                          onClick={(e) => { e.stopPropagation(); startCreate(s.name, "", "dir"); }}>
                          <FolderPlusIcon className="size-3 text-muted-foreground" />
                        </Button>
                        <Button size="icon" variant="ghost" className="size-5" title={t("skills.deleteSkill")}
                          onClick={(e) => { e.stopPropagation(); deleteSkill(s.name); }}>
                          <Trash2Icon className="size-3 text-destructive" />
                        </Button>
                      </span>
                    </div>

                    {/* 展开：递归文件树 */}
                    {isOpen && (
                      <>
                        {renderTree(tree, s.name, 0)}
                        {creating?.skill === s.name && creating.inDir === "" &&
                          inlineInputJSX(22)}
                      </>
                    )}
                  </div>
                );
              })}

              {skills.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">{t("skills.emptyTree")}</p>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* ── 右侧面板 ── */}
        <div className="flex flex-1 flex-col overflow-auto p-4">
          {!selected && (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">{t("skills.selectHint")}</p>
            </div>
          )}

          {selected && selected.path === null && selectedSkill && (
            <div className="max-w-xl space-y-5">
              <div>
                <h2 className="font-mono text-base font-semibold">{selectedSkill.name}</h2>
                {selectedSkill.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{selectedSkill.description}</p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedSkill.license && (
                    <Badge variant="outline" className="text-xs font-normal">License: {selectedSkill.license}</Badge>
                  )}
                  {selectedSkill.compatibility && (
                    <Badge variant="secondary" className="text-xs font-normal">{selectedSkill.compatibility}</Badge>
                  )}
                </div>
              </div>

              {/* ── 关联 MCP ── */}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  {t("skills.linkMcp")}
                  <span className="ml-1 font-normal">{t("skills.linkMcpHint")}</span>
                </Label>
                {mcpOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("skills.noMcp")}</p>
                ) : (
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {mcpOptions.map((m) => (
                      <label key={m.id} className="flex cursor-pointer items-center gap-2 text-sm">
                        <Checkbox
                          checked={detailMcps.includes(m.name)}
                          onCheckedChange={(on) => toggleSkillMcp(selectedSkill.name, m.name, !!on)}
                        />
                        {m.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* ── 可见性 ── */}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">{t("skills.visibilityLabel")}</Label>
                <div className="space-y-2">
                  {agents.map((a) => (
                    <label key={a.key} className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={(visibility[selectedSkill.name] ?? []).includes(a.id)}
                        onCheckedChange={() => toggleVisibility(selectedSkill.name, a.id, a.name)}
                      />
                      {a.name}
                    </label>
                  ))}
                  {agents.length === 0 && (
                    <span className="text-xs text-muted-foreground">{t("skills.noAgent")}</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {selected && selected.path !== null && (
            <div className="flex h-full flex-col gap-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{selected.skill}</span>
                <span>/</span>
                <span className="font-mono">{selected.path}</span>
                <Button size="sm" className="ml-auto" onClick={saveFile} disabled={!dirty || saving}>
                  {saving ? t("common.saving") : t("common.save")}
                </Button>
              </div>
              {fileLoading ? (
                <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
              ) : (
                <Textarea
                  className="flex-1 resize-none font-mono text-xs"
                  value={fileContent}
                  onChange={(e) => { setFileContent(e.target.value); setDirty(true); }}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── 调用统计（复用可观测性）── */}
      <Sheet open={statsOpen} onOpenChange={setStatsOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 data-[side=right]:sm:max-w-xl">
          <SheetHeader className="px-4 pt-4">
            <SheetTitle className="flex items-center gap-2">
              <BarChart3Icon className="size-4" />{t("skills.stats.title")}
            </SheetTitle>
            <p className="text-muted-foreground text-xs">{t("skills.stats.hint")}</p>
          </SheetHeader>
          <div className="grid grid-cols-3 gap-2 px-4 py-3">
            {[
              { label: t("skills.stats.installed"), value: stats?.installed_count ?? 0 },
              { label: t("skills.stats.invoked"), value: stats?.invoked_count ?? 0 },
              { label: t("skills.stats.totalCalls"), value: stats?.total_calls ?? 0 },
            ].map((m) => (
              <div key={m.label} className="rounded-md border p-2 text-center">
                <div className="text-lg font-semibold tabular-nums">{m.value}</div>
                <div className="text-muted-foreground text-[11px]">{m.label}</div>
              </div>
            ))}
          </div>
          <ScrollArea className="flex-1 px-4 pb-4">
            {stats && stats.skills.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {[...stats.skills].sort((a, b) => b.calls - a.calls).map((st) => (
                  <div key={st.skill_name} className="rounded-md border p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-sm">{st.skill_name}</span>
                      <Badge variant="secondary" className="shrink-0 tabular-nums">
                        {t("skills.stats.callsN", { n: st.calls })}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
                      <span>{t("skills.stats.lastAt")}: {st.last_at ? new Date(st.last_at).toLocaleString() : "—"}</span>
                    </div>
                    {Object.keys(st.by_agent).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {Object.entries(st.by_agent)
                          .sort((a, b) => b[1] - a[1])
                          .map(([agentKey, n]) => (
                            <Badge key={agentKey} variant="outline" className="px-1.5 py-0 text-[10px]">
                              {agentKey} · {n}
                            </Badge>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground py-8 text-center text-sm">{t("skills.stats.empty")}</p>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* ── 新建 Skill 对话框 ── */}
      <Sheet open={newOpen} onOpenChange={setNewOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 data-[side=right]:sm:max-w-xl">
          <SheetHeader className="px-4 pt-4">
            <SheetTitle>{t("skills.newSkill")}</SheetTitle>
          </SheetHeader>
          <Tabs defaultValue="basic" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-4 mt-3 shrink-0 justify-start">
              <TabsTrigger value="basic">{t("skills.tabBasic")}</TabsTrigger>
              <TabsTrigger value="mcp">
                {t("skills.linkMcp")}
                {newMcps.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
                    {newMcps.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="visibility">
                {t("skills.visibility")}
                {newVisibility.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
                    {newVisibility.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            {/* 基本信息 */}
            <TabsContent value="basic" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4 pt-4 data-[state=inactive]:hidden">
              <div className="grid gap-1.5">
                <Label htmlFor="sk-name">{t("common.name")} <span className="text-destructive">*</span></Label>
                <Input id="sk-name" placeholder="sqli-deepdive" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <p className="text-muted-foreground text-xs">{t("skills.nameHint")}</p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sk-desc">{t("skills.description")} <span className="text-destructive">*</span></Label>
                <Textarea id="sk-desc" rows={2} className="resize-none"
                  placeholder={t("skills.descPlaceholder")}
                  value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground text-xs">license</Label>
                  <Input placeholder="MIT / Proprietary" value={newLicense} onChange={(e) => setNewLicense(e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground text-xs">compatibility</Label>
                  <Input placeholder={t("skills.compatPlaceholder")} value={newCompat} onChange={(e) => setNewCompat(e.target.value)} />
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-1.5">
                <Label htmlFor="sk-inst">{t("skills.body")} <span className="text-muted-foreground text-xs font-normal">{t("skills.bodyHint")}</span></Label>
                <Textarea id="sk-inst"
                  className="min-h-40 flex-1 resize-none font-mono text-sm leading-relaxed"
                  placeholder={t("skills.bodyPlaceholder")}
                  value={newInst} onChange={(e) => setNewInst(e.target.value)} />
              </div>
            </TabsContent>

            {/* 关联 MCP */}
            <TabsContent value="mcp" className="overflow-y-auto px-4 pb-4 pt-4 data-[state=inactive]:hidden">
              <p className="mb-3 text-xs text-muted-foreground">{t("skills.linkMcpHint2")}</p>
              {mcpOptions.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("skills.noMcp")}</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {mcpOptions.map((m) => (
                    <label key={m.id} className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={newMcps.includes(m.name)}
                        onCheckedChange={(on) =>
                          setNewMcps((cur) => on ? [...cur, m.name] : cur.filter((n) => n !== m.name))
                        }
                      />
                      {m.name}
                    </label>
                  ))}
                </div>
              )}
            </TabsContent>

            {/* 可见性 */}
            <TabsContent value="visibility" className="overflow-y-auto px-4 pb-4 pt-4 data-[state=inactive]:hidden">
              <p className="mb-3 text-xs text-muted-foreground">{t("skills.visibilityHint")}</p>
              {agents.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("skills.noAgent")}</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {agents.map((a) => (
                    <label key={a.key} className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={newVisibility.includes(a.id)}
                        onCheckedChange={(on) =>
                          setNewVisibility((cur) => on ? [...cur, a.id] : cur.filter((id) => id !== a.id))
                        }
                      />
                      {a.name}
                    </label>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>

          <SheetFooter className="flex-row justify-end gap-2 border-t px-4 py-3">
            <Button variant="outline" onClick={() => setNewOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={createNewSkill} disabled={creatingSkill}>{creatingSkill ? t("skills.creating") : t("common.create")}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
