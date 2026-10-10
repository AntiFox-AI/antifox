---
name: report-generation
description: 渗透测试报告生成的可编辑内容——AI 改写 prompt 与固定骨架（方法论/测试清单/工具/参考规范/测试人员），按语言分文件。报告引擎每次生成读盘，编辑即时生效。
---

# 报告生成（可编辑内容）

本 skill 存放**渗透测试报告的可编辑内容**，供「报告管理」的生成管线读取。修改后**下次生成即时生效**，无需重启或重新编译；任一文件缺失或损坏会自动回退到内置默认值。

## 结构

- `prompts/report-level.tmpl` — 报告级叙述的 AI 提示词（背景 / 服务成果 / 整改结论 / 命中的测试项）。
- `prompts/vuln-narrative.tmpl` — 单条漏洞改写的 AI 提示词（描述 / 复现过程 / 风险 / 修复 / CVSS）。
- `skeleton/<语言>/methodology.json` — 2.2 测试流程：`{intro, phases:[{name,desc}]}`。
- `skeleton/<语言>/checklist.json` — 2.3 测试清单：`[{category,name,desc}]`。AI 判定命中的项渲染为「不通过」。
- `skeleton/<语言>/tools.json` — 2.4 测试工具：`[{name,desc}]`。
- `skeleton/<语言>/standards.json` — 2.5 参考规范：`["..."]`。
- `skeleton/<语言>/personnel.json` — 2.1 测试人员默认值：`[{name,role,contact}]`（用户在报告设置里填了就以其为准）。

语言目录：`zh-CN`（简体）/ `zh-TW`（繁体）/ `en-US`（英文）。

## Prompt 模板变量

提示词是 Go `text/template`，用 `===USER===` 分隔 system 与 user 两段：

- 报告级：`{{.Company}}` `{{.Project}}` `{{.Client}}` `{{.FindingsList}}` `{{.LangDirective}}`
- 漏洞级：`{{.Company}}` `{{.VulnClass}}` `{{.Severity}}` `{{.Summary}}` `{{.PoC}}` `{{.LangDirective}}`

`{{.LangDirective}}` 会注入目标语言指令（简/繁/英），故 prompt 本身与语言无关、三语共用一份。
