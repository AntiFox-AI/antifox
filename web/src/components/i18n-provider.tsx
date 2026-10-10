"use client";

import { useEffect } from "react";

import { I18nextProvider } from "react-i18next";

import i18n, { DEFAULT_LANG, LANG_STORAGE_KEY, isLangCode } from "@/i18n/config";

// 首帧统一用 DEFAULT_LANG（与静态导出预渲染一致，避免 hydration 文本错配），
// 挂载后从 localStorage 读取用户选择的语言并切换，同时同步 <html lang>。
export function I18nProvider({ children }: { readonly children: React.ReactNode }) {
  useEffect(() => {
    const stored = typeof window === "undefined" ? null : localStorage.getItem(LANG_STORAGE_KEY);
    const lang = isLangCode(stored) ? stored : DEFAULT_LANG;
    if (i18n.language !== lang) void i18n.changeLanguage(lang);
    if (typeof document !== "undefined") document.documentElement.lang = lang;
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
