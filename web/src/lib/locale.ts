import i18n from "@/i18n/config";

// dateLocale returns the BCP-47 locale for date/number formatting that matches
// the active UI language (zh* → 简体中文区域, else en-US). Called at render time
// so switching language re-formats immediately.
export function dateLocale(): string {
  const lang = i18n.language ?? "";
  return lang.startsWith("zh") ? "zh-CN" : "en-US";
}
