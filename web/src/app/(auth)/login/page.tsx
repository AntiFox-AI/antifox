"use client";

import { useEffect, useState } from "react";

import { useRouter } from "next/navigation";

import { useTranslation } from "react-i18next";

import { LanguageSwitcher } from "@/app/(main)/_components/sidebar/language-switcher";
import { AntifoxLogo } from "@/components/antifox-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { auth } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // 已登录直接进主界面（静态导出下无 middleware 代劳这层跳转）。
    if (auth.getToken()) {
      router.replace("/function/tasks");
      return;
    }
    api.authStatus()
      .then(({ initialized }) => {
        if (!initialized) router.replace("/setup");
      })
      .catch(() => setError(t("login.errBackend")))
      .finally(() => setChecking(false));
  }, [router, t]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const { token } = await api.login(username.trim(), password);
      auth.setToken(token);
      router.replace("/function/tasks");
    } catch (e) {
      setError((e as Error)?.message || t("login.errFailed"));
    } finally {
      setLoading(false);
    }
  }

  if (checking) return null;

  return (
    <div className="relative flex h-dvh">
      <div className="absolute top-4 right-4 z-20">
        <LanguageSwitcher />
      </div>
      {/* Left brand panel — 特色背景图 login.jpg + AntiFox 品牌 */}
      <div className="relative hidden flex-col items-center justify-center overflow-hidden p-12 text-center lg:flex lg:w-1/2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/login.jpg" alt="" className="absolute inset-0 size-full object-cover" />
        {/* 暗色渐变遮罩：保证 logo/文字清晰可读，并统一到品牌深蓝 */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#0A1126]/90 via-[#0A1126]/55 to-[#0A1126]/90" />
        <div className="relative z-10 flex flex-col items-center gap-5 text-white">
          <AntifoxLogo className="size-24 drop-shadow-xl" />
          <div className="space-y-1.5">
            <div className="text-4xl font-bold tracking-tight">
              Anti<span className="bg-gradient-to-r from-[#4F6BF6] to-[#7C3AED] bg-clip-text text-transparent">Fox</span>
            </div>
            <div className="text-xs font-medium uppercase tracking-[0.25em] text-white/70">
              AI Autonomous Pentest Platform
            </div>
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div className="flex w-full items-center justify-center bg-background p-8 lg:w-1/2">
        <div className="w-full max-w-md space-y-10 py-24 lg:py-32">
          <div className="space-y-4 text-center">
            <h2 className="text-2xl font-medium tracking-tight">{t("login.title")}</h2>
            <p className="mx-auto max-w-xl text-muted-foreground">{t("login.welcome")}</p>
          </div>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="username">{t("login.username")}</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t("login.usernamePlaceholder")}
                autoFocus
                autoComplete="username"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">{t("login.password")}</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("login.passwordPlaceholder")}
                autoComplete="current-password"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || !password}>
              {loading ? t("login.submitting") : t("login.submit")}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
