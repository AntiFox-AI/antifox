#!/usr/bin/env node
// 合并各页面代理返回的命名空间 JSON 片段进 3 份 locale。
// 片段目录 /tmp/i18n-frag/*.json，每个形如 { "<ns>": { "zh-CN": {...}, "zh-TW": {...}, "en-US": {...} }, ... }
// 每个命名空间由唯一代理拥有 → 顶层赋值即可、无冲突。保留 locale 里已有的 nav/common/status/login 等。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const LOCALE_DIR = new URL("../web/src/i18n/locales/", import.meta.url);
const FRAG_DIR = "/tmp/i18n-frag";
const LANGS = ["zh-CN", "zh-TW", "en-US"];

// 安全网：解码子代理可能过度转义的 HTML 实体（&lt;→< &gt;→> &amp;→& 等）。
// UI 展示文本永远要字面字符；settings 的 <b> 标签也需字面形式给 <Trans> 用。
function decodeEntities(v) {
  if (typeof v === "string") {
    return v
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&amp;", "&");
  }
  if (Array.isArray(v)) return v.map(decodeEntities);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = decodeEntities(v[k]);
    return out;
  }
  return v;
}

const locales = {};
for (const l of LANGS) {
  locales[l] = JSON.parse(readFileSync(new URL(`${l}.json`, LOCALE_DIR), "utf8"));
}

let nsCount = 0;
const seen = new Set();
for (const f of readdirSync(FRAG_DIR).filter((f) => f.endsWith(".json")).sort()) {
  const frag = JSON.parse(readFileSync(`${FRAG_DIR}/${f}`, "utf8"));
  for (const ns of Object.keys(frag)) {
    if (seen.has(ns)) {
      console.warn(`⚠️  命名空间重复: ${ns}（来自 ${f}）— 后者覆盖前者`);
    }
    seen.add(ns);
    for (const l of LANGS) {
      const sub = frag[ns]?.[l];
      if (!sub) {
        console.warn(`⚠️  ${f} 的 ${ns} 缺 ${l}`);
        continue;
      }
      locales[l][ns] = decodeEntities(sub);
    }
    nsCount++;
  }
}

for (const l of LANGS) {
  writeFileSync(new URL(`${l}.json`, LOCALE_DIR), JSON.stringify(locales[l], null, 2) + "\n");
}
console.log(`✓ 合并 ${nsCount} 个命名空间进 ${LANGS.length} 份 locale：${[...seen].join(", ")}`);
