package report

import (
	"archive/zip"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"antifox/db"
)

// mdLeadNumRe 去掉系统标题里 DOCX 版式的章节号前缀（如 "3.1 "）——MD 是独立交付稿、自成 1 起编号。
var mdLeadNumRe = regexp.MustCompile(`^\d+(\.\d+)*\s+`)

// BuildMarkdown 生成【交付标准】Markdown 报告正文 + 随附证据图清单(相对名→源磁盘路径)。
// 版式对齐人工交付稿：信息头 → 按目标分组 → 每条漏洞(属性表 + 7 个编号小节) → 页脚。
// 证据图以相对路径 assets/<name> 引用，由 GenerateMarkdownFile 打进同一个 zip（不再 base64 内嵌，
// 保持 .md 干净、小巧、可在 Typora/VSCode 直接编辑，图片相对解析）。
func BuildMarkdown(ctx context.Context, pg *db.DB, in *GenInput) (string, map[string]string) {
	doc := BuildDoc(ctx, pg, in)
	loc := doc.Meta.Locale
	L := func(zh, tw, en string) string { return pick(loc, zh, tw, en) }
	assets := map[string]string{}
	var b strings.Builder

	// ── 信息头 ──
	b.WriteString("# " + doc.Meta.ReportTitle + "\n\n")
	b.WriteString("> **" + L("出具方", "出具方", "Prepared by") + "**：" + doc.Meta.CompanyName + "  \n")
	b.WriteString("> **" + L("报告日期", "報告日期", "Date") + "**：" + doc.Meta.Date +
		"　·　**" + L("版本", "版本", "Version") + "**：" + doc.Meta.Version + "  \n")
	var crit, high, med, low int
	for _, s := range doc.Summary.Systems {
		crit += s.Crit
		high += s.High
		med += s.Med
		low += s.Low
	}
	b.WriteString("> **" + L("漏洞统计", "漏洞統計", "Findings") + "**：" +
		fmt.Sprintf("%s %d · %s %d · %s %d · %s %d（%s %d）\n",
			L("严重", "嚴重", "Critical"), crit, L("高危", "高危", "High"), high,
			L("中危", "中危", "Medium"), med, L("低危", "低危", "Low"), low,
			L("共", "共", "total"), crit+high+med+low))
	b.WriteString("\n---\n\n")

	s1 := L("漏洞描述", "漏洞描述", "Description")
	s3 := L("所属模块", "所屬模組", "Module")
	s4 := L("测试过程", "測試過程", "Testing Process")
	s5 := L("风险分析", "風險分析", "Risk Analysis")
	s6 := L("修复建议", "修復建議", "Remediation")
	s7 := L("修复情况", "修復情況", "Remediation Status")
	tTarget := L("影响目标", "影響目標", "Target")
	tRisk := L("风险等级", "風險等級", "Severity")
	tDate := L("发现时间", "發現時間", "Found")

	sysIdx := 0
	for _, sysd := range doc.SystemsDetail {
		sysIdx++
		b.WriteString(fmt.Sprintf("## %d %s\n\n", sysIdx, mdLeadNumRe.ReplaceAllString(sysd.Name, "")))
		vulnIdx := 0
		for _, v := range sysd.Vulns {
			vulnIdx++
			// 标题：<sys>.<vuln> <name>（<severity>/CVSS分值<score>）——自成 1 起编号
			paren := v.Severity
			if v.CVSSScore > 0 {
				paren += "/" + L("CVSS分值", "CVSS分值", "CVSS ") + fmt.Sprintf("%.1f", v.CVSSScore)
			}
			b.WriteString(fmt.Sprintf("### %d.%d %s（%s）\n\n", sysIdx, vulnIdx, v.Title, paren))
			// 属性表
			b.WriteString("| | |\n|---|---|\n")
			b.WriteString("| **" + tTarget + "** | " + mdCell(nz(v.Target, v.URL)) + " |\n")
			b.WriteString("| **" + tRisk + "** | **" + v.Severity + "** |\n")
			b.WriteString("| **" + tDate + "** | " + v.FoundDate + " |\n\n")
			// 1. 漏洞描述
			b.WriteString("**1. " + s1 + "**\n\n")
			for _, p := range v.Description {
				b.WriteString(p + "\n\n")
			}
			// 2. URL
			b.WriteString("**2. URL**\n\n")
			b.WriteString(nz(v.URL, v.Target) + "\n\n")
			// 3. 所属模块
			b.WriteString("**3. " + s3 + "**\n\n")
			b.WriteString(defaultStr(v.Module, "—") + "\n\n")
			// 4. 测试过程（步骤文字 + 逐字请求/响应 + 证据截图）
			b.WriteString("**4. " + s4 + "**\n\n")
			for _, blk := range v.TestProcess {
				switch blk.Type {
				case "code":
					b.WriteString("```\n" + strings.TrimRight(blk.Content, "\n") + "\n```\n\n")
				case "image":
					if blk.Path != "" && fileExists(blk.Path) {
						rel := filepath.Base(blk.Path)
						assets[rel] = blk.Path
						b.WriteString("![" + mdEscapeAlt(blk.Caption) + "](assets/" + rel + ")\n")
						if blk.Caption != "" {
							b.WriteString("*" + blk.Caption + "*\n")
						}
						b.WriteString("\n")
					}
				default:
					b.WriteString(blk.Content + "\n\n")
				}
			}
			// 5. 风险分析
			b.WriteString("**5. " + s5 + "**\n\n")
			for _, r := range v.RiskAnalysis {
				b.WriteString("- " + r + "\n")
			}
			b.WriteString("\n")
			// 6. 修复建议
			b.WriteString("**6. " + s6 + "**\n\n")
			for _, r := range v.Remediation {
				b.WriteString("- " + r + "\n")
			}
			b.WriteString("\n")
			// 7. 修复情况
			b.WriteString("**7. " + s7 + "**\n\n")
			b.WriteString(v.FixStatus + "\n\n")
			b.WriteString("---\n\n")
		}
	}
	b.WriteString("*" + fmt.Sprintf(
		L("本报告由 %s 于 %s 出具。", "本報告由 %s 於 %s 出具。", "Report prepared by %s on %s."),
		doc.Meta.CompanyName, doc.Meta.Date) + "*\n")
	return b.String(), assets
}

// GenerateMarkdownFile 生成 MD 交付包 zip（report.md + assets/ 证据图），返回 zip 路径。
// 纯 Go、无 python 依赖；图片以真实文件随附、相对引用，解压后在 Typora/VSCode 直接可读可编辑。
func GenerateMarkdownFile(ctx context.Context, pg *db.DB, in *GenInput, workDir, taskID string) (string, error) {
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return "", fmt.Errorf("创建报告目录失败: %w", err)
	}
	md, assets := BuildMarkdown(ctx, pg, in)
	zipPath := filepath.Join(workDir, fmt.Sprintf("task-%s-%s.zip", safeName(taskID), nowStamp(ctx)))
	zf, err := os.Create(zipPath)
	if err != nil {
		return "", fmt.Errorf("创建报告包失败: %w", err)
	}
	defer zf.Close()
	zw := zip.NewWriter(zf)
	mw, err := zw.Create("report.md")
	if err != nil {
		return "", fmt.Errorf("写入 report.md 失败: %w", err)
	}
	if _, err := mw.Write([]byte(md)); err != nil {
		return "", fmt.Errorf("写入 report.md 失败: %w", err)
	}
	for rel, src := range assets {
		data, err := os.ReadFile(src)
		if err != nil {
			continue // 图片缺失就跳过，不影响整包
		}
		aw, err := zw.Create("assets/" + rel)
		if err != nil {
			continue
		}
		_, _ = aw.Write(data)
	}
	if err := zw.Close(); err != nil {
		return "", fmt.Errorf("打包失败: %w", err)
	}
	return zipPath, nil
}

func fileExists(p string) bool {
	if p == "" {
		return false
	}
	_, err := os.Stat(p)
	return err == nil
}

// mdCell 转义表格单元格里会破坏 markdown 表格的字符。
func mdCell(s string) string {
	s = strings.ReplaceAll(s, "|", "\\|")
	s = strings.ReplaceAll(s, "\n", " ")
	return strings.TrimSpace(s)
}

// mdEscapeAlt 清理图片 alt 文本（去掉会破坏 ![]() 语法的字符）。
func mdEscapeAlt(s string) string {
	s = strings.ReplaceAll(s, "]", "")
	s = strings.ReplaceAll(s, "\n", " ")
	if strings.TrimSpace(s) == "" {
		return "evidence"
	}
	return s
}
