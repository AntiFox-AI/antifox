"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Pencil, Plus, Trash2, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { RBACRole, RBACUser } from "@/lib/types";

type TFn = ReturnType<typeof useTranslation>["t"];

const SCOPE_KEYS: Record<string, string> = { all: "rbac.scope.all", assigned: "rbac.scope.assigned", own: "rbac.scope.own" };

function scopeLabel(s: string, t: TFn) {
  return SCOPE_KEYS[s] ? t(SCOPE_KEYS[s]) : s;
}

// module display name — tech-term modules (Agent/MCP/Skill/LLM/RBAC) stay English via the catalog values.
function moduleLabel(m: string, t: TFn) {
  return t(`rbac.module.${m}`, { defaultValue: m });
}

// permission description — client-side i18n label, falling back to the server-provided description.
function permLabel(k: string, fallback: string, t: TFn) {
  return t(`rbac.perm.${k.split(":").join(".")}`, { defaultValue: fallback });
}

export default function RbacPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState("members");
  const [users, setUsers] = useState<RBACUser[]>([]);
  const [roles, setRoles] = useState<RBACRole[]>([]);
  const [permCatalog, setPermCatalog] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [u, r, meta] = await Promise.all([api.rbacUsers(), api.rbacRoles(), api.rbacMetadata()]);
      setUsers(u);
      setRoles(r);
      setPermCatalog(meta.permissions ?? {});
    } catch (e) {
      toast.error((e as Error)?.message ?? t("rbac.toast.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const roleName = useCallback((id: string) => roles.find((r) => r.id === id)?.name ?? id, [roles]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <div className="flex items-center gap-3">
        <UsersRound className="size-6" />
        <h1 className="text-xl font-semibold">{t("rbac.title")}</h1>
      </div>

      {/* 顶部汇总 */}
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-sm">
          <b className="text-blue-600 dark:text-blue-400">{users.length}</b> {t("rbac.summary.accounts")}
        </Badge>
        <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-sm">
          <b className="text-violet-600 dark:text-violet-400">{roles.length}</b> {t("rbac.summary.roles")}
        </Badge>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="members">{t("rbac.tab.members")}</TabsTrigger>
          <TabsTrigger value="roles">{t("rbac.tab.roles")}</TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="mt-4">
          <MembersTab users={users} roles={roles} roleName={roleName} loading={loading} reload={load} />
        </TabsContent>

        <TabsContent value="roles" className="mt-4">
          <RolesTab roles={roles} users={users} permCatalog={permCatalog} loading={loading} reload={load} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ============================ 成员管理 ============================ */

function MembersTab({
  users, roles, roleName, loading, reload,
}: {
  users: RBACUser[];
  roles: RBACRole[];
  roleName: (id: string) => string;
  loading: boolean;
  reload: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<RBACUser | null>(null);
  const [creating, setCreating] = useState(false);

  async function onDelete(u: RBACUser) {
    if (u.username === "admin") return;
    if (!confirm(t("rbac.member.confirmDelete", { name: u.username }))) return;
    try {
      await api.rbacDeleteUser(u.id);
      toast.success(t("rbac.toast.deleted"));
      await reload();
    } catch (e) {
      toast.error((e as Error)?.message ?? t("rbac.toast.deleteFailed"));
    }
  }

  return (
    <div className="rounded-xl border">
      <div className="flex items-center justify-end gap-2 border-b p-3">
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-4" /> {t("rbac.member.create")}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground">
            <tr className="border-b [&>th]:px-4 [&>th]:py-2.5 [&>th]:text-left [&>th]:font-medium">
              <th>{t("rbac.member.username")}</th>
              <th>{t("rbac.member.displayName")}</th>
              <th>{t("rbac.member.role")}</th>
              <th>{t("common.status")}</th>
              <th className="text-right">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="p-8 text-center text-muted-foreground">{t("common.loading")}</td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-8 text-center text-muted-foreground">{t("rbac.member.empty")}</td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="border-b last:border-0 [&>td]:px-4 [&>td]:py-2.5">
                  <td className="font-medium">
                    {u.username}
                    {u.is_builtin && <span title={t("rbac.member.builtin")}> 🛡️</span>}
                  </td>
                  <td className="text-muted-foreground">{u.display_name || "—"}</td>
                  <td>{(u.role_ids ?? []).map(roleName).join("、") || "—"}</td>
                  <td>
                    {u.enabled ? (
                      <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">{t("common.enabled")}</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">{t("rbac.member.disabled")}</Badge>
                    )}
                  </td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => setEditing(u)}>
                        <Pencil className="size-3.5" /> {t("common.edit")}
                      </Button>
                      {u.username !== "admin" && (
                        <Button size="sm" variant="outline" className="text-destructive" onClick={() => onDelete(u)}>
                          <Trash2 className="size-3.5" /> {t("common.delete")}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <UserDialog
          user={editing}
          roles={roles}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function UserDialog({
  user, roles, onClose, onSaved,
}: {
  user: RBACUser | null;
  roles: RBACRole[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const isEdit = !!user;
  const [username, setUsername] = useState(user?.username ?? "");
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(user?.enabled ?? true);
  const [roleId, setRoleId] = useState(user?.role_ids?.[0] ?? "viewer");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      if (isEdit) {
        await api.rbacUpdateUser(user!.id, {
          display_name: displayName,
          enabled,
          role_ids: [roleId],
          ...(password ? { password } : {}),
        });
      } else {
        if (username.trim().length === 0 || password.length < 8) {
          toast.error(t("rbac.userDialog.errValidation"));
          setSaving(false);
          return;
        }
        await api.rbacCreateUser({ username: username.trim(), display_name: displayName, password, enabled, role_ids: [roleId] });
      }
      toast.success(isEdit ? t("rbac.toast.updated") : t("rbac.toast.created"));
      await onSaved();
    } catch (e) {
      toast.error((e as Error)?.message ?? t("rbac.toast.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("rbac.userDialog.editTitle") : t("rbac.userDialog.createTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t("rbac.member.username")}</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} disabled={isEdit} placeholder={t("rbac.userDialog.usernamePlaceholder")} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("rbac.member.displayName")}</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{isEdit ? t("rbac.userDialog.newPasswordLabel") : t("rbac.userDialog.passwordLabel")}</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("rbac.member.role")}</Label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                    {r.is_system ? "" : t("rbac.role.customSuffix")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} id="u-enabled" />
            <Label htmlFor="u-enabled">{t("rbac.userDialog.enableAccount")}</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={save} disabled={saving}>{saving ? t("common.saving") : t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================ 角色管理 ============================ */

function RolesTab({
  roles, users, permCatalog, loading, reload,
}: {
  roles: RBACRole[];
  users: RBACUser[];
  permCatalog: Record<string, string>;
  loading: boolean;
  reload: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<RBACRole | null>(null);
  const [creating, setCreating] = useState(false);

  const memberCount = useCallback(
    (roleId: string) => users.filter((u) => (u.role_ids ?? []).includes(roleId)).length,
    [users],
  );

  async function onDelete(r: RBACRole) {
    if (r.is_system) return;
    if (!confirm(t("rbac.role.confirmDelete", { name: r.name }))) return;
    try {
      await api.rbacDeleteRole(r.id);
      toast.success(t("rbac.toast.deleted"));
      await reload();
    } catch (e) {
      toast.error((e as Error)?.message ?? t("rbac.toast.deleteFailed"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-4" /> {t("rbac.role.create")}
        </Button>
      </div>

      {loading ? (
        <p className="p-8 text-center text-muted-foreground">{t("common.loading")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {roles.map((r) => {
            const modules = [...new Set((r.permissions ?? []).map((k) => k.split(":")[0]))];
            return (
              <div key={r.id} className="flex flex-col rounded-xl border p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold">{r.name}</h3>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{r.description || t("rbac.role.noDesc")}</p>
                  </div>
                  <Badge variant="outline" className={r.is_system ? "" : "border-violet-500/40 text-violet-600 dark:text-violet-400"}>
                    {r.is_system ? t("rbac.role.system") : t("rbac.role.custom")}
                  </Badge>
                </div>
                <div className="my-3 grid grid-cols-3 gap-2">
                  {[
                    { v: (r.permissions ?? []).length, l: t("rbac.role.statPerms") },
                    { v: memberCount(r.id), l: t("rbac.role.statMembers") },
                    { v: scopeLabel(r.scope, t), l: t("rbac.role.statScope") },
                  ].map((s, i) => (
                    <div key={i} className="rounded-lg bg-muted/60 p-2">
                      <div className="truncate text-sm font-semibold">{s.v}</div>
                      <div className="mt-0.5 text-[0.68rem] text-muted-foreground">{s.l}</div>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {modules.slice(0, 6).map((m) => (
                    <span key={m} className="rounded bg-muted px-2 py-0.5 text-[0.7rem] text-muted-foreground">{moduleLabel(m, t)}</span>
                  ))}
                  {modules.length > 6 && (
                    <span className="rounded bg-muted px-2 py-0.5 text-[0.7rem] text-muted-foreground">+{modules.length - 6}</span>
                  )}
                </div>
                <div className="mt-auto flex justify-end gap-1.5 border-t pt-3">
                  <Button size="sm" variant="outline" onClick={() => setEditing(r)}>
                    {r.is_system ? t("rbac.role.view") : t("common.edit")}
                  </Button>
                  {!r.is_system && (
                    <Button size="sm" variant="outline" className="text-destructive" onClick={() => onDelete(r)}>{t("common.delete")}</Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(creating || editing) && (
        <RoleDialog
          role={editing}
          permCatalog={permCatalog}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function RoleDialog({
  role, permCatalog, onClose, onSaved,
}: {
  role: RBACRole | null;
  permCatalog: Record<string, string>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const readonly = role?.is_system ?? false;
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [scope, setScope] = useState(role?.scope ?? "assigned");
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? ["auth:self", "dashboard:read"]));
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // 按模块分组
  const groups = useMemo(() => {
    const g: Record<string, string[]> = {};
    Object.keys(permCatalog).sort().forEach((k) => {
      const m = k.split(":")[0];
      (g[m] = g[m] ?? []).push(k);
    });
    return g;
  }, [permCatalog]);

  const q = search.trim().toLowerCase();

  function toggle(key: string, on: boolean) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });
  }

  async function save() {
    if (readonly) {
      onClose();
      return;
    }
    if (name.trim().length === 0) {
      toast.error(t("rbac.roleDialog.errNameRequired"));
      return;
    }
    setSaving(true);
    try {
      const body = { name: name.trim(), description, scope, permissions: [...selected] };
      if (role && !role.is_system) await api.rbacUpdateRole(role.id, body);
      else await api.rbacCreateRole(body);
      toast.success(t("rbac.toast.saved"));
      await onSaved();
    } catch (e) {
      toast.error((e as Error)?.message ?? t("rbac.toast.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{readonly ? t("rbac.roleDialog.viewTitle") : role ? t("rbac.roleDialog.editTitle") : t("rbac.roleDialog.createTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 overflow-y-auto py-2">
          <div className="flex gap-3">
            <div className="flex-1 space-y-1.5">
              <Label>{t("rbac.roleDialog.name")}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={readonly} />
            </div>
            <div className="w-40 space-y-1.5">
              <Label>{t("rbac.roleDialog.scopeLabel")}</Label>
              <Select value={scope} onValueChange={setScope} disabled={readonly}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("rbac.scope.all")}</SelectItem>
                  <SelectItem value="assigned">{t("rbac.scope.assigned")}</SelectItem>
                  <SelectItem value="own">{t("rbac.scope.own")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("rbac.roleDialog.desc")}</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} disabled={readonly} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("rbac.roleDialog.permsLabel", { count: selected.size })}</Label>
            <Input placeholder={t("rbac.roleDialog.searchPlaceholder")} value={search} onChange={(e) => setSearch(e.target.value)} className="mb-2" />
            <div className="max-h-[38vh] space-y-3 overflow-y-auto rounded-lg border bg-muted/30 p-2">
              {Object.keys(groups).sort().map((mod) => {
                const items = groups[mod].filter(
                  (k) => !q || k.toLowerCase().includes(q) || (permCatalog[k] ?? "").toLowerCase().includes(q),
                );
                if (items.length === 0) return null;
                return (
                  <div key={mod} className="rounded-lg border bg-background p-2.5">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-sm font-medium text-primary">{moduleLabel(mod, t)}</span>
                    </div>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {items.map((k) => (
                        <label key={k} className="flex cursor-pointer items-start gap-2 rounded-md border bg-muted/40 p-2 text-xs">
                          <Checkbox
                            checked={selected.has(k)}
                            onCheckedChange={(v) => toggle(k, !!v)}
                            disabled={readonly}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="block font-medium">{permLabel(k, permCatalog[k] ?? k, t)}</span>
                            <code className="block truncate text-[0.65rem] text-muted-foreground">{k}</code>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{readonly ? t("common.close") : t("common.cancel")}</Button>
          {!readonly && <Button onClick={save} disabled={saving}>{saving ? t("common.saving") : t("common.save")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
