"use client";

import * as React from "react";

import { CheckIcon, CopyIcon, SearchIcon, WrapTextIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

// HttpPacket：带行号 + Burp 风语法高亮 + 自动换行 + 一键复制 + 报文内搜索(高亮全部命中 +
// 计数) 的 HTTP 报文渲染件。请求/响应共用；报文视图(流量页 + 截图模式)复用同一组件，样式
// 统一、可直接截图替代 Burp。搜索命中计数便于「截图证明获取到的数据量」。

export function statusTone(status: number): string {
  if (status >= 500) return "text-red-500";
  if (status >= 400) return "text-amber-500";
  if (status >= 300) return "text-blue-500";
  if (status >= 200) return "text-emerald-500";
  return "text-muted-foreground";
}

// Vivid, Burp-like palette — distinct + prominent, tuned for light & dark.
const C = {
  method: "font-semibold text-violet-600 dark:text-violet-400",
  url: "text-sky-600 dark:text-sky-400",
  dim: "text-muted-foreground",
  hname: "text-sky-700 dark:text-sky-300",
  hval: "text-emerald-600 dark:text-emerald-400",
  jkey: "text-sky-700 dark:text-sky-300",
  jstr: "text-amber-600 dark:text-amber-400",
  jnum: "text-fuchsia-600 dark:text-fuchsia-400",
  jbool: "text-rose-600 dark:text-rose-400",
  tag: "text-sky-600 dark:text-sky-400",
};

// requestWithHost 为缺少 Host 头的旧报文补上 Host（net/http 把 Host 放在 Header 之外，早期录制可能漏）。
export function requestWithHost(raw: string, host: string, url: string): string {
  if (!raw.trim() || /^host\s*:/im.test(raw)) return raw;
  let h = host;
  try {
    h = new URL(url).host || host;
  } catch {
    /* 相对/旧 URL 回退到索引的 host */
  }
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  const end = raw.indexOf(nl);
  if (end < 0) return `${raw}${nl}Host: ${h}`;
  return `${raw.slice(0, end + nl.length)}Host: ${h}${nl}${raw.slice(end + nl.length)}`;
}

// Active search term, provided once per packet so every token renderer can overlay
// the match highlight without prop-drilling. Syntax color is kept; matches get a
// yellow <mark> on top.
const HlCtx = React.createContext<string>("");

// Hl renders a text segment with its syntax color (className) AND the active search
// term highlighted. Case-insensitive, literal substring.
function Hl({ text, className }: { text: string; className?: string }) {
  const term = React.useContext(HlCtx);
  if (!term || !text) return <span className={className}>{text}</span>;
  const hay = text.toLowerCase();
  const needle = term.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const idx = hay.indexOf(needle, i);
    if (idx < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={k++} className="rounded-[2px] bg-yellow-300 text-black">
        {text.slice(idx, idx + needle.length)}
      </mark>,
    );
    i = idx + needle.length;
  }
  return <span className={className}>{parts}</span>;
}

function StartLine({ line }: { line: string }) {
  const resp = /^(HTTP\/\S+)(\s+)(\d{3})(.*)$/.exec(line);
  if (resp) {
    return (
      <>
        <Hl text={resp[1]} className={C.dim} />
        {resp[2]}
        <Hl text={resp[3]} className={statusTone(Number(resp[3]))} />
        <Hl text={resp[4]} />
      </>
    );
  }
  const req = /^([A-Z]+)(\s+)(\S+)(\s+)(HTTP\/\S+)$/.exec(line);
  if (req) {
    return (
      <>
        <Hl text={req[1]} className={C.method} />
        {req[2]}
        <Hl text={req[3]} className={C.url} />
        {req[4]}
        <Hl text={req[5]} className={C.dim} />
      </>
    );
  }
  return <Hl text={line} />;
}

function HeaderLine({ line }: { line: string }) {
  const sep = line.indexOf(":");
  if (sep <= 0) return <Hl text={line} />;
  return (
    <>
      <Hl text={line.slice(0, sep)} className={C.hname} />
      <span className={C.dim}>:</span>
      <Hl text={line.slice(sep + 1)} className={C.hval} />
    </>
  );
}

function JsonBody({ body }: { body: string }) {
  const parts: React.ReactNode[] = [];
  const tokens = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let cursor = 0;
  for (const m of body.matchAll(tokens)) {
    const i = m.index ?? 0;
    if (i > cursor) parts.push(<Hl key={`t${cursor}`} text={body.slice(cursor, i)} />);
    let cls = C.jnum;
    if (m[1]) cls = m[2] ? C.jkey : C.jstr;
    else if (m[3]) cls = C.jbool;
    parts.push(<Hl key={`${i}-${m[0].length}`} text={m[0]} className={cls} />);
    cursor = i + m[0].length;
  }
  if (cursor < body.length) parts.push(<Hl key={`e${cursor}`} text={body.slice(cursor)} />);
  return <>{parts}</>;
}

function MarkupBody({ body }: { body: string }) {
  const parts: React.ReactNode[] = [];
  const tags = /<\/?[A-Za-z][^>]*>|<!--[\s\S]*?-->/g;
  let cursor = 0;
  for (const m of body.matchAll(tags)) {
    const i = m.index ?? 0;
    if (i > cursor) parts.push(<Hl key={`t${cursor}`} text={body.slice(cursor, i)} />);
    parts.push(<Hl key={`${i}-${m[0].length}`} text={m[0]} className={C.tag} />);
    cursor = i + m[0].length;
  }
  if (cursor < body.length) parts.push(<Hl key={`e${cursor}`} text={body.slice(cursor)} />);
  return <>{parts}</>;
}

type BodyFormat = "json" | "markup" | "plain";
function detectBodyFormat(body: string): BodyFormat {
  const t = body.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (t.startsWith("<")) return "markup";
  return "plain";
}

// countMatches tallies case-insensitive literal occurrences across the whole packet
// — the "N matches" shown when searching, handy for screenshotting data volume.
function countMatches(hayRaw: string, termRaw: string): number {
  if (!termRaw) return 0;
  const hay = hayRaw.toLowerCase();
  const needle = termRaw.toLowerCase();
  let n = 0;
  let i = 0;
  for (;;) {
    const idx = hay.indexOf(needle, i);
    if (idx < 0) break;
    n++;
    i = idx + needle.length;
  }
  return n;
}

export function HttpPacket({ raw, className }: { raw: string; className?: string }) {
  const { t } = useTranslation();
  const [wrap, setWrap] = React.useState(true);
  const [copied, setCopied] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const value = raw && raw.trim() ? raw : t("traffic.emptyPacket");
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  const sep = lines.indexOf("");
  const body = sep >= 0 ? lines.slice(sep + 1).join("\n") : "";
  const fmt = detectBodyFormat(body);
  const matches = React.useMemo(() => countMatches(value, query), [value, query]);

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  function copy() {
    navigator.clipboard?.writeText(value).then(
      () => setCopied(true),
      () => {},
    );
  }

  function renderLine(line: string, i: number) {
    if (i === 0) return <StartLine line={line} />;
    if (sep < 0 || i < sep) return <HeaderLine line={line} />;
    if (i === sep) return null;
    if (fmt === "json") return <JsonBody body={line} />;
    if (fmt === "markup") return <MarkupBody body={line} />;
    return <Hl text={line} />;
  }

  return (
    <div className={cn("relative flex min-h-0 flex-col overflow-hidden rounded-md border bg-background", className)}>
      <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-0.5 rounded-md border bg-background/95 p-0.5 shadow-xs">
        <button
          type="button"
          aria-pressed={wrap}
          title={wrap ? t("traffic.wrapOff") : t("traffic.wrapOn")}
          onClick={() => setWrap((v) => !v)}
          className={cn("rounded p-1 hover:bg-muted", wrap ? "text-primary" : "text-muted-foreground")}
        >
          <WrapTextIcon className="size-3.5" />
        </button>
        <button
          type="button"
          title={copied ? t("traffic.copied") : t("traffic.copyPacket")}
          onClick={copy}
          className="rounded p-1 text-muted-foreground hover:bg-muted"
        >
          {copied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-background py-2 font-mono text-xs leading-relaxed">
        <HlCtx.Provider value={query}>
          {lines.map((line, i) => (
            <div
              key={`${i}-${line}`}
              data-line={i + 1}
              className="grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)] before:sticky before:left-0 before:self-stretch before:border-r before:bg-muted/20 before:px-1 before:text-right before:text-[11px] before:text-muted-foreground/50 before:content-[attr(data-line)]"
            >
              <code className={cn("min-h-[1lh] min-w-0 pr-14 pl-2 [tab-size:4]", wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre")}>
                {renderLine(line, i)}
              </code>
            </div>
          ))}
        </HlCtx.Provider>
      </div>
      {/* Burp-style in-packet search: highlights every hit + shows the count (for
          screenshotting proof of data volume). */}
      <div className="flex items-center gap-2 border-t bg-muted/20 px-2 py-1">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("traffic.packetSearch")}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/60"
        />
        {query && (
          <span className={cn("shrink-0 text-xs tabular-nums", matches ? "font-medium text-foreground" : "text-muted-foreground")}>
            {t("traffic.matchCount", { count: matches })}
          </span>
        )}
      </div>
    </div>
  );
}
