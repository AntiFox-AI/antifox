"use client";

import * as React from "react";

import { XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { HttpPacket, requestWithHost, statusTone } from "@/components/http-packet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { TrafficDetail, TrafficExchange } from "@/lib/types";
import { cn } from "@/lib/utils";

function fmtTime(ts: string) {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// PacketShotModal：全屏「截图模式」——请求+响应一屏、顶部自说明头(方法/状态/目标/URL/时间)，
// 专为替代 Burp 截图。自行按需加载报文正文。流量页与漏洞详情(关联流量)共用。
export function PacketShotModal({ exchange, onClose }: { exchange: TrafficExchange; onClose: () => void }) {
  const { t } = useTranslation();
  const [detail, setDetail] = React.useState<TrafficDetail | null>(null);
  React.useEffect(() => {
    let alive = true;
    api
      .trafficExchange(exchange.id)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetail({ req: "", resp: "" }));
    return () => {
      alive = false;
    };
  }, [exchange.id]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background p-4">
      <div className="mb-3 border-b pb-3">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="font-mono">
            {exchange.method}
          </Badge>
          <span className={cn("font-mono text-sm font-semibold tabular-nums", statusTone(exchange.status))}>
            {exchange.status}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{fmtTime(exchange.ts)}</span>
          <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={onClose}>
            <XIcon className="size-4" /> {t("common.close")}
          </Button>
        </div>
        <div className="mt-1.5 truncate font-mono text-base font-semibold" title={exchange.host}>
          {exchange.host}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground" title={exchange.url}>
          {exchange.url}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <div className="flex min-h-0 flex-col gap-1.5">
          <span className="text-xs font-semibold text-muted-foreground">{t("traffic.reqLabel")}</span>
          <HttpPacket raw={requestWithHost(detail?.req ?? "", exchange.host, exchange.url)} className="min-h-0 flex-1" />
        </div>
        <div className="flex min-h-0 flex-col gap-1.5">
          <span className="text-xs font-semibold text-muted-foreground">{t("traffic.respLabel")}</span>
          <HttpPacket raw={detail?.resp ?? ""} className="min-h-0 flex-1" />
        </div>
      </div>
    </div>
  );
}
