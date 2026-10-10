"use client";

import Link from "next/link";

import { useShallow } from "zustand/react/shallow";

import { useMemo } from "react";

import { useTranslation } from "react-i18next";

import { AntifoxLogo } from "@/components/antifox-logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { APP_CONFIG } from "@/config/app-config";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePermissions } from "@/hooks/use-permissions";
import { sidebarItems } from "@/navigation/sidebar/sidebar-items";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

import { NavMain } from "./nav-main";
import { NavUser } from "./nav-user";
import { SidebarSupportCard } from "./sidebar-support-card";


// nav 项 → 所需读权限（无映射的项始终显示）。用于按角色隐藏无权页面。
const NAV_PERM: Record<string, string> = {
  dashboard: "dashboard:read",
  chat: "task:read",
  tasks: "task:read",
  findings: "finding:read",
  traffic: "traffic:read",
  assets: "asset:read",
  sync: "asset:read",
  llm: "llm:read",
  agents: "agent:read",
  mcp: "mcp:read",
  skills: "skill:read",
  tools: "tool:read",
  intercept: "intercept:read",
  approvals: "intercept:read",
  rbac: "rbac:read",
  reports: "report:read",
  knowledge: "knowledge:read",
  logs: "log:read",
  settings: "config:read",
};

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const currentUser = useCurrentUser();
  const { ready, has } = usePermissions();
  const { t, i18n } = useTranslation();
  const { sidebarVariant, sidebarCollapsible, isSynced } = usePreferencesStore(
    useShallow((s) => ({
      sidebarVariant: s.sidebarVariant,
      sidebarCollapsible: s.sidebarCollapsible,
      isSynced: s.isSynced,
    })),
  );

  const variant = isSynced ? sidebarVariant : props.variant;
  const collapsible = isSynced ? sidebarCollapsible : props.collapsible;

  // 按权限过滤 nav + 三语翻译（按 id 查 nav.* / navGroup.*，中文原文兜底）。
  // 权限未就绪前先显示全部（避免闪烁），就绪后隐藏无权项。i18n.language 入依赖，切换语言即时重算。
  const navItems = useMemo(() => {
    const tr = <T extends { id: string; title: string }>(it: T): T => ({
      ...it,
      title: t(`nav.${it.id}`, { defaultValue: it.title }),
    });
    return sidebarItems
      .map((g) => ({
        ...g,
        label: g.label ? t(`navGroup.${g.id}`, { defaultValue: g.label }) : g.label,
        items: g.items
          .filter((it) => !ready || !NAV_PERM[it.id] || has(NAV_PERM[it.id]))
          .map((it) => ("subItems" in it && it.subItems ? { ...tr(it), subItems: it.subItems.map(tr) } : tr(it))),
      }))
      .filter((g) => g.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, has, t, i18n.language]);

  return (
    <Sidebar {...props} variant={variant} collapsible={collapsible}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link prefetch={false} href="/function/tasks">
                <AntifoxLogo className="size-8 shrink-0" />
                <span className="font-semibold text-base">{APP_CONFIG.name}</span>
                <span className="rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary">
                  {APP_CONFIG.version}
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navItems} />
        {/* <NavDocuments items={data.documents} /> */}
        {/* <NavSecondary items={data.navSecondary} className="mt-auto" /> */}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={currentUser} />
      </SidebarFooter>
    </Sidebar>
  );
}
