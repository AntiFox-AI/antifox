package report

// Retroactive finding extraction: pull confirmed vulnerabilities out of a task's
// agent transcript (synthesis + worker conclusions) that were described but never
// recorded via report_finding — so they can be back-filled as finding nodes.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"antifox/db"
)

// ExtractedFinding is one vuln pulled from the transcript.
type ExtractedFinding struct {
	VulnClass string `json:"vulnclass"`
	Severity  string `json:"severity"` // high|medium|low
	Summary   string `json:"summary"`
	Target    string `json:"target"`
	Evidence  string `json:"evidence"`
}

const sysExtract = "你是资深渗透测试专家。从渗透测试执行/汇总记录中提取【已确认的漏洞】。严格只输出 JSON，不要 markdown 代码块。证据必须保留记录里的真实原文，不得编造。"

const userExtract = `从以下渗透测试执行与汇总记录中，提取所有【已确认的漏洞】与【已证实的暴露/信息泄露风险】（不含未验证的猜测与否定结论）。

已记录的漏洞（这些不要重复输出）：
%s
执行/汇总记录：
%s

要求：
- 每条一个确认漏洞：vulnclass(漏洞类型/名称，如"存储型 XSS"、"硬编码凭据"、"未授权访问"), severity(critical|high|medium|low；critical=可直接导致系统/数据完全失陷), summary(一句话摘要，含受影响对象), target(受影响主机或 URL), evidence(关键 PoC/请求/命令/响应原文，保留真实内容)。
- 只提取记录里**明确验证过**的漏洞/暴露；上面"已记录"列表里的语义相同项不要重复。
- **暴露/信息泄露类也要提取**：记录里实际访问到、有响应证据的未授权可达敏感/管理/调试接口、Swagger/API 文档、配置或备份/源码公开、敏感数据泄露等，按敏感度定 severity（一般信息泄露=low、未授权可达敏感/管理接口=medium、可接管或拿到凭据/密钥=high）。仍排除纯臆测（版本/CVE 匹配、"看起来可注入"）；仅"存在某接口"而无未授权暴露的不算。
- 若没有新漏洞/暴露，findings 输出空数组。

只输出 JSON：{"findings":[{"vulnclass":"...","severity":"high","summary":"...","target":"...","evidence":"..."}]}`

// ExtractFindings asks the active LLM to extract confirmed vulns from the
// transcript, excluding ones already recorded (passed as short labels).
func ExtractFindings(ctx context.Context, pg *db.DB, transcript string, existing []string) ([]ExtractedFinding, error) {
	if strings.TrimSpace(transcript) == "" {
		return nil, fmt.Errorf("无可分析的会话记录")
	}
	var ex strings.Builder
	for _, e := range existing {
		ex.WriteString("- ")
		ex.WriteString(e)
		ex.WriteString("\n")
	}
	if ex.Len() == 0 {
		ex.WriteString("（无）\n")
	}
	raw, err := complete(ctx, pg, sysExtract, fmt.Sprintf(userExtract, ex.String(), transcript), 4000)
	if err != nil {
		return nil, err
	}
	var out struct {
		Findings []ExtractedFinding `json:"findings"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, fmt.Errorf("AI 输出解析失败")
	}
	return out.Findings, nil
}
