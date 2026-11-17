"use client";

import { useEffect, useState } from "react";

import { useRouter } from "next/navigation";

import { useTranslation } from "react-i18next";

import { AntifoxLogo } from "@/components/antifox-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { auth } from "@/lib/auth";

// ForceChangePasswordPage is the mandatory first-login gate: the seeded admin uses a
// weak default password, so the backend flags must_change_password and blocks every
// non-auth API until it is changed here.
export default function ForceChangePasswordPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 未登录（无 token）直接回登录页；静态导出下无 middleware 代劳这层跳转。
    if (!auth.getToken()) router.replace("/login");
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!currentPassword || !newPassword) {
      setError(t("changePassword.errRequired"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("changePassword.errMismatch"));
      return;
    }
    setLoading(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      // 改密后 must_change_password 已清，进入主界面。
      router.replace("/function/tasks");
    } catch (err) {
      setError((err as Error)?.message || t("changePassword.errFail", { msg: "" }));
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-8">
      <div className="w-full max-w-md space-y-8">
        <div className="space-y-4 text-center">
          <AntifoxLogo className="mx-auto size-16" />
          <div className="space-y-1.5">
            <h2 className="text-2xl font-medium tracking-tight">{t("forceChangePassword.title")}</h2>
            <p className="text-muted-foreground">{t("forceChangePassword.desc")}</p>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="fcp-current">{t("changePassword.currentPassword")}</Label>
            <Input
              id="fcp-current"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              disabled={loading}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fcp-new">{t("changePassword.newPassword")}</Label>
            <Input
              id="fcp-new"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              disabled={loading}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fcp-confirm">{t("changePassword.confirmNew")}</Label>
            <Input
              id="fcp-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              disabled={loading}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t("changePassword.submitting") : t("forceChangePassword.submit")}
          </Button>
        </form>
      </div>
    </div>
  );
}
