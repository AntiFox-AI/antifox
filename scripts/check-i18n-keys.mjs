#!/usr/bin/env node
// 校验：扫 src 下所有 t("key")/t('key') 引用，跟 zh-CN.json 对账。
// 报告：① 代码引用但 JSON 缺失的键（会显示原始 key，需补）；② 残留中文硬编码文件。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../web/src/", import.meta.url).pathname;
const zhCN = JSON.parse(readFileSync(join(SRC, "i18n/locales/zh-CN.json"), "utf8"));

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|ts)$/.test(e)) acc.push(p);
  }
  return acc;
}

function hasKey(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj) !== undefined;
}

const files = walk(SRC);
const KEY_RE = /\bt\(\s*["'`]([a-zA-Z0-9_.]+)["'`]/g;
const missing = new Map(); // key -> [files]
let refCount = 0;

for (const f of files) {
  const src = readFileSync(f, "utf8");
  let m;
  while ((m = KEY_RE.exec(src))) {
    const key = m[1];
    if (!key.includes(".")) continue; // 跳过非命名空间键（如变量）
    refCount++;
    if (!hasKey(zhCN, key)) {
      const rel = f.replace(SRC, "");
      if (!missing.has(key)) missing.set(key, new Set());
      missing.get(key).add(rel);
    }
  }
}

console.log(`扫描 ${files.length} 文件，${refCount} 处 t() 引用。`);
if (missing.size === 0) {
  console.log("✓ 所有 t() 键在 zh-CN.json 中都存在。");
} else {
  console.log(`✗ ${missing.size} 个键在 zh-CN.json 缺失：`);
  for (const [k, fs] of missing) console.log(`  ${k}  ← ${[...fs].join(", ")}`);
}

// 残留中文（排除注释行与 locales 目录）
const CJK = /[一-鿿]/;
const residual = [];
for (const f of files) {
  if (f.includes("/i18n/locales/") || f.includes("/lib/mock/")) continue;
  const lines = readFileSync(f, "utf8").split("\n");
  let n = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue; // 注释
    if (CJK.test(line)) n++;
  }
  if (n > 0) residual.push([f.replace(SRC, ""), n]);
}
residual.sort((a, b) => b[1] - a[1]);
console.log(`\n残留含中文（非注释、非 mock/locale）文件 ${residual.length} 个：`);
for (const [f, n] of residual) console.log(`  ${String(n).padStart(4)}  ${f}`);

process.exit(missing.size === 0 ? 0 : 1);
