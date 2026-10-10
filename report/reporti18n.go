package report

// Locale-aware strings for the Go side of the report pipeline: severity names,
// status words, and the deterministic fallback prose used when the LLM is
// unavailable. Fixed skeleton *labels* (chapter titles, table headers, etc.)
// live in pybuilder/report_builder.py's LABELS; here we only localize the text
// that Go assembles into the report JSON. Supported locales: zh-CN | zh-TW | en-US.

import (
	"fmt"
	"strings"
	"time"
)

// normLocale canonicalizes a locale string to one of the three supported values.
func normLocale(l string) string {
	switch strings.ToLower(strings.TrimSpace(l)) {
	case "zh-tw", "zh_tw", "zh-hant", "tw", "hant":
		return "zh-TW"
	case "en", "en-us", "en_us", "en-gb":
		return "en-US"
	default:
		return "zh-CN"
	}
}

// pick returns the value for the given locale (cn / tw / en fallbacks).
func pick(locale, cn, tw, en string) string {
	switch normLocale(locale) {
	case "zh-TW":
		return tw
	case "en-US":
		return en
	default:
		return cn
	}
}

// ---- severity ----

var sevNames = map[string]map[string]string{
	"critical": {"zh-CN": "严重", "zh-TW": "嚴重", "en-US": "Critical"},
	"high":     {"zh-CN": "高危", "zh-TW": "高危", "en-US": "High"},
	"medium":   {"zh-CN": "中危", "zh-TW": "中危", "en-US": "Medium"},
	"low":      {"zh-CN": "低危", "zh-TW": "低危", "en-US": "Low"},
	"info":     {"zh-CN": "信息", "zh-TW": "資訊", "en-US": "Info"},
}

// severityName renders a canonical/localized severity word for the given locale.
func severityName(locale, sev string) string {
	c := canonSeverity(sev)
	if m, ok := sevNames[c]; ok {
		if v := m[normLocale(locale)]; v != "" {
			return v
		}
		return m["zh-CN"]
	}
	return sevNames["info"][normLocale(locale)]
}

// ---- status / small words ----

func statusPending(locale string) string {
	return pick(locale, "待修复", "待修復", "Pending")
}
func statusRemarkFirst(locale string) string {
	return pick(locale, "本次为首次发现", "本次為首次發現", "First identified in this assessment")
}
func defaultTargetName(locale string) string {
	return pick(locale, "目标系统", "目標系統", "Target System")
}
func reportWord(locale string) string {
	return pick(locale, "渗透测试报告", "滲透測試報告", "Penetration Test Report")
}

// defaultReportTitle builds the fallback cover title "<project> <report word>",
// localized. When project is empty it's just the report word.
func defaultReportTitle(locale, project string) string {
	project = strings.TrimSpace(project)
	if project == "" {
		return reportWord(locale)
	}
	return project + " " + reportWord(locale)
}
func clientDefault(locale string) string {
	return pick(locale, "客户", "客戶", "Client")
}
func projectDefault(locale string) string {
	return pick(locale, "渗透测试项目", "滲透測試項目", "Penetration Testing Project")
}
func moduleDash() string { return "—" }

// ---- composite formatters (parens differ by locale) ----

// sectionSystemHeader renders a 3.x system section title, e.g.
// "3.1 example.com（example.com）" / "3.1 example.com (example.com)".
func sectionSystemHeader(locale string, idx int, name, addr string) string {
	if normLocale(locale) == "en-US" {
		return fmt.Sprintf("3.%d %s (%s)", idx, name, addr)
	}
	return fmt.Sprintf("3.%d %s（%s）", idx, name, addr)
}

// vulnObject renders a remediation-item object "Title（host）" / "Title (host)".
func vulnObject(locale, title, target string) string {
	if strings.TrimSpace(target) == "" {
		return title
	}
	if normLocale(locale) == "en-US" {
		return fmt.Sprintf("%s (%s)", title, target)
	}
	return fmt.Sprintf("%s（%s）", title, target)
}

// localizedDate formats today's date per locale.
func localizedDate(locale string) string {
	t := time.Now()
	if normLocale(locale) == "en-US" {
		return t.Format("January 2, 2006")
	}
	return fmt.Sprintf("%d年%d月%d日", t.Year(), int(t.Month()), t.Day())
}

// ---- fallback prose (used only when the LLM is unavailable) ----

func fallbackBackground(locale, client, company, project string) string {
	switch normLocale(locale) {
	case "zh-TW":
		return fmt.Sprintf("%s委託%s對其 %s 相關資訊系統實施滲透測試服務。安全服務工程師模擬攻擊者行為，採取人工與工具相結合的方式，從多角度挖掘系統安全風險並提供加固建議。", client, company, project)
	case "en-US":
		return fmt.Sprintf("%s commissioned %s to perform a penetration test of the information systems related to %s. Security engineers simulated real-world attacker behaviour, combining manual testing with tooling to surface security risks from multiple angles and to provide hardening recommendations.", client, company, project)
	default:
		return fmt.Sprintf("%s委托%s对其 %s 相关信息系统实施渗透测试服务。安全服务工程师模拟攻击者行为，采取人工与工具相结合的方式，从多角度挖掘系统安全风险并提供加固建议。", client, company, project)
	}
}

// infoSeg / infoSegParen append an "info"-severity segment to a breakdown only
// when there are informational findings, so the enumerated counts reconcile with
// the total (which includes info). infoSeg carries the counting unit (个/個),
// infoSegParen is the unit-less form used inside parentheses.
func infoSeg(locale string, info int) string {
	if info <= 0 {
		return ""
	}
	return pick(locale, fmt.Sprintf("、信息 %d 个", info), fmt.Sprintf("、資訊 %d 個", info), fmt.Sprintf(", %d Info", info))
}
func infoSegParen(locale string, info int) string {
	if info <= 0 {
		return ""
	}
	return pick(locale, fmt.Sprintf("、信息 %d", info), fmt.Sprintf("、資訊 %d", info), fmt.Sprintf(", %d Info", info))
}

func fallbackServiceResult(locale string, total, crit, high, med, low, info int) string {
	switch normLocale(locale) {
	case "zh-TW":
		return fmt.Sprintf("本次測試共發現 %d 個安全漏洞：嚴重 %d 個、高危 %d 個、中危 %d 個、低危 %d 個%s。", total, crit, high, med, low, infoSeg(locale, info))
	case "en-US":
		return fmt.Sprintf("A total of %d security issues were identified: %d Critical, %d High, %d Medium, %d Low%s.", total, crit, high, med, low, infoSeg(locale, info))
	default:
		return fmt.Sprintf("本次测试共发现 %d 个安全漏洞：严重 %d 个、高危 %d 个、中危 %d 个、低危 %d 个%s。", total, crit, high, med, low, infoSeg(locale, info))
	}
}

func fallbackRemediationConclusion(locale string) string {
	return pick(locale,
		"本次为首轮渗透检查，所发现漏洞均处于待修复状态，建议按报告中修复建议尽快整改，修复完成后组织复测以确认漏洞闭环。",
		"本次為首輪滲透檢查，所發現漏洞均處於待修復狀態，建議按報告中修復建議儘快整改，修復完成後組織複測以確認漏洞閉環。",
		"This was an initial penetration assessment; all identified issues are currently pending remediation. Remediation should follow the recommendations in this report, with retesting performed afterwards to confirm closure.")
}

func fallbackFindingsIntro(locale, company string, crit, high, med, low, info int) string {
	switch normLocale(locale) {
	case "zh-TW":
		return fmt.Sprintf("%s對目標系統實施滲透測試服務，共發現嚴重漏洞 %d 個、高危漏洞 %d 個、中危漏洞 %d 個、低危漏洞 %d 個%s，詳情見下表：", company, crit, high, med, low, infoSeg(locale, info))
	case "en-US":
		return fmt.Sprintf("%s performed penetration testing against the target systems and identified %d Critical, %d High, %d Medium, %d Low%s findings, as detailed in the table below:", company, crit, high, med, low, infoSeg(locale, info))
	default:
		return fmt.Sprintf("%s对目标系统实施渗透测试服务，共发现严重漏洞 %d 个、高危漏洞 %d 个、中危漏洞 %d 个、低危漏洞 %d 个%s，详情见下表：", company, crit, high, med, low, infoSeg(locale, info))
	}
}

// overallConclusion builds the chapter-5 overall conclusion sentence.
func overallConclusion(locale string, total, crit, high, med, low, info int, worst string) string {
	switch normLocale(locale) {
	case "zh-TW":
		s := fmt.Sprintf("本次滲透測試共發現 %d 個安全漏洞（嚴重 %d、高危 %d、中危 %d、低危 %d%s），系統整體安全等級評定為「%s」。", total, crit, high, med, low, infoSegParen(locale, info), worst)
		if crit > 0 || high > 0 {
			s += fmt.Sprintf("其中存在 %d 個嚴重、%d 個高危漏洞，建議立即組織修復，並在整改完成後開展複測驗證。", crit, high)
		} else if med > 0 {
			s += "未發現嚴重或高危漏洞，建議按計劃修復中危漏洞。"
		} else {
			s += "系統安全性良好，僅發現低風險或資訊類問題。"
		}
		return s
	case "en-US":
		s := fmt.Sprintf("A total of %d security issues were identified (%d Critical, %d High, %d Medium, %d Low%s). The overall system security rating is \"%s\". ", total, crit, high, med, low, infoSegParen(locale, info), worst)
		if crit > 0 || high > 0 {
			s += fmt.Sprintf("The environment contains %d Critical and %d High findings; immediate remediation followed by retesting is strongly recommended.", crit, high)
		} else if med > 0 {
			s += "No Critical or High findings were identified; Medium findings should be remediated on schedule."
		} else {
			s += "The overall security posture is good; only low-risk or informational issues were found."
		}
		return s
	default:
		s := fmt.Sprintf("本次渗透测试共发现 %d 个安全漏洞（严重 %d、高危 %d、中危 %d、低危 %d%s），系统整体安全等级评定为「%s」。", total, crit, high, med, low, infoSegParen(locale, info), worst)
		if crit > 0 || high > 0 {
			s += fmt.Sprintf("其中存在 %d 个严重、%d 个高危漏洞，建议立即组织修复，并在整改完成后开展复测验证。", crit, high)
		} else if med > 0 {
			s += "未发现严重或高危漏洞，建议按计划修复中危漏洞。"
		} else {
			s += "系统安全性良好，仅发现低风险或信息类问题。"
		}
		return s
	}
}

// ---- AI output-language directive (injected into prompts) ----

// outputLangDirective tells the LLM which language to write all prose in.
func outputLangDirective(locale string) string {
	return pick(locale,
		"使用简体中文撰写所有叙述性字段（background、description、risk_analysis、remediation 等），保持专业交付口吻。",
		"使用繁體中文（台灣用語）撰寫所有敘述性欄位（background、description、risk_analysis、remediation 等），保持專業交付口吻。",
		"Write ALL narrative fields (background, description, risk_analysis, remediation, etc.) in professional, client-ready English. Keep the JSON keys in English exactly as specified.")
}
