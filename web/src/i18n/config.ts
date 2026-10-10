import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enUS from "./locales/en-US.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";

// 支持的三种语言。label 用各自母语名（永不翻译），供语言切换器展示。
export const LANGS = [
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "en-US", label: "English" },
] as const;

export type LangCode = (typeof LANGS)[number]["code"];

export const DEFAULT_LANG: LangCode = "zh-CN";
export const LANG_STORAGE_KEY = "antifox-lang";

export function isLangCode(v: string | null | undefined): v is LangCode {
  return !!v && LANGS.some((l) => l.code === v);
}

// 资源直接打包（非异步加载）——静态导出友好、无 Suspense、SSR/首帧一致。
if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: {
      "zh-CN": { translation: zhCN },
      "zh-TW": { translation: zhTW },
      "en-US": { translation: enUS },
    },
    lng: DEFAULT_LANG,
    fallbackLng: DEFAULT_LANG,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

export default i18n;
