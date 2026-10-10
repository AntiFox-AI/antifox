"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api";

// 当前登录用户的权限集合（来自 /api/rbac/me）。用于按权限隐藏 nav / 按钮。
// 模块级缓存：整个会话只拉一次。
let cached: Set<string> | null = null;
let inflight: Promise<Set<string>> | null = null;

async function fetchPerms(): Promise<Set<string>> {
  if (cached) return cached;
  if (!inflight) {
    inflight = api
      .rbacMe()
      .then((me) => {
        cached = new Set(me.permissions ?? []);
        return cached;
      })
      .catch(() => new Set<string>())
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function usePermissions() {
  const [perms, setPerms] = useState<Set<string>>(cached ?? new Set());
  const [ready, setReady] = useState(cached !== null);

  useEffect(() => {
    let alive = true;
    void fetchPerms().then((p) => {
      if (alive) {
        setPerms(p);
        setReady(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  return {
    ready,
    permissions: perms,
    has: (p: string) => perms.has(p),
  };
}
