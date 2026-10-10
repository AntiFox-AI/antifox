#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AntiFox 渗透测试报告构建器（JSON 驱动，自包含）。

成熟的 python-docx 排版引擎，JSON 驱动、自包含：
    python3 report_builder.py <input.json> <output.docx>

输入 JSON 由平台（Go 侧）组装：确定性骨架 + AI 生成的专业叙述。
产出与人工交付一致的 .docx：封面(logo+橙线)、自动目录、页码域、
每漏洞 3 行属性表 + 7 子项、代码块底色、表格浅蓝表头、宋体 10.5/1.5 倍行距首行缩进。

无第三方品牌硬编码——公司名/logo 全部来自 JSON。
"""
import sys
import json
import datetime

from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

# ---------------------------------------------------------------------------
# Palette / fonts
# ---------------------------------------------------------------------------
TITLE_BLUE = RGBColor(0x1F, 0x3A, 0x68)   # cover + heading dark blue
ORANGE = "E36C2A"                          # cover separator
HEADER_SHADE = "D9E2F3"                    # table header light blue
CODE_BG = "F5F5F5"                         # code block background
GRAY_BORDER = "808080"
CAPTION_GRAY = RGBColor(0x40, 0x40, 0x40)
HIT_RED = RGBColor(0xC0, 0x39, 0x2B)       # checklist "不通过"

BODY_FONT = "宋体"
UI_FONT = "微软雅黑"
CODE_FONT = "Consolas"

# ---------------------------------------------------------------------------
# Localized labels
# ---------------------------------------------------------------------------
LABELS = {
    "zh-CN": {
        "toc": "目  录",
        "toc_hint": "请在 Word 中按 F9 更新目录",
        "ch1": "第1章 综述", "s11": "1.1 项目背景", "s12": "1.2 服务成果", "s13": "1.3 整改结论",
        "ch2": "第2章 测试信息", "s21": "2.1 人员信息", "s22": "2.2 测试流程",
        "s23": "2.3 测试清单", "s24": "2.4 测试工具", "s25": "2.5 参考规范",
        "ch3": "第3章 测试详情", "ch4": "第4章 漏洞等级评定", "ch5": "第5章 系统等级评定",
        "tbl_service": "表 1-1 服务内容及成果", "tbl_remediation": "表 1-2 整改结论",
        "tbl_personnel": "表 2-1 测试人员信息", "tbl_checklist": "表 2-2 测试清单",
        "tbl_tools": "表 2-3 测试工具", "tbl_vulnlist": "表 3-1 漏洞列表",
        "tbl_rating_res_cap": "表 5-1 系统等级评定结果",
        "hdr_service": ["系统名称", "域名/地址", "严重", "高危", "中危", "低危", "系统等级"],
        "hdr_remediation": ["序号", "修复对象", "整改结论", "备注"],
        "hdr_personnel": ["姓名", "角色", "联系方式"],
        "hdr_checklist": ["漏洞类型", "漏洞名称", "描述", "测试结果"],
        "hdr_tools": ["工具名称", "描述"],
        "hdr_vulnlist": ["漏洞等级", "漏洞名称", "描述", "修复情况"],
        "hdr_cvss": ["评分项", "取值", "说明"],
        "hdr_rating_def": ["系统等级", "判定标准", "说明"],
        "hdr_rating_res": ["系统名称", "严重/高危/中危/低危", "系统等级"],
        "info_target": "影响目标", "info_severity": "风险等级", "info_found": "发现时间",
        "sub_desc": "1. 漏洞描述", "sub_url": "2. URL", "sub_module": "3. 所属模块",
        "sub_process": "4. 测试过程", "sub_risk": "5. 风险分析",
        "sub_fix": "6. 修复建议", "sub_status": "7. 修复情况",
        "chk_pass": "通过", "chk_fail": "不通过",
        "kv_sep": "：", "lparen": "（", "rparen": "）", "cvss_sep": "/", "cvss_word": "CVSS分值",
        "cvss_vector_row": "CVSS 向量", "cvss_overall": "综合评分 {c}",
        "cvss_metric_names": [["AV", "攻击向量"], ["AC", "攻击复杂度"], ["PR", "权限要求"], ["UI", "用户交互"],
                              ["S", "影响范围"], ["C", "机密性"], ["I", "完整性"], ["A", "可用性"]],
        "page_pre": "第 ", "page_mid": " 页 / 共 ", "page_suf": " 页",
        "client": "客户名称：", "project": "项目名称：", "version": "报告版本：", "date": "报告日期：",
        "report_word": "渗透测试报告",
        "cvss_intro": "本次渗透测试依据通用漏洞评分系统 CVSS {v} 对每个漏洞进行量化评分。评分综合考虑攻击向量（AV）、攻击复杂度（AC）、权限要求（PR）、用户交互（UI）、影响范围（S）、机密性（C）、完整性（I）、可用性（A）八项指标，据此确定漏洞的严重程度等级。",
        "sev_criteria": "严重程度划分标准",
        "hdr_sev": ["等级", "CVSS 分值范围", "说明"],
        "sev_rows": [["严重", "9.0 – 10.0", "可直接导致系统完全失陷或大规模数据泄露"],
                     ["高危", "7.0 – 8.9", "可获取重要数据或服务控制权"],
                     ["中危", "4.0 – 6.9", "可导致信息泄露或受限操作"],
                     ["低危", "0.1 – 3.9", "影响有限的配置或信息类问题"]],
        "rating_intro": "系统安全等级依据该系统中发现的最高严重度漏洞确定，等级定义如下：",
        "rating_def_rows": [["严重", "存在严重漏洞", "可直接利用导致系统完全失陷"],
                            ["高危", "存在高危漏洞", "攻击者可获取重要数据或服务控制权"],
                            ["中危", "存在中危漏洞", "可能导致信息泄露或受限操作"],
                            ["低危", "存在低危漏洞", "影响有限"],
                            ["安全", "未发现漏洞", "本次未发现安全漏洞"]],
    },
    "zh-TW": {
        "toc": "目  錄",
        "toc_hint": "請在 Word 中按 F9 更新目錄",
        "ch1": "第1章 綜述", "s11": "1.1 專案背景", "s12": "1.2 服務成果", "s13": "1.3 整改結論",
        "ch2": "第2章 測試資訊", "s21": "2.1 人員資訊", "s22": "2.2 測試流程",
        "s23": "2.3 測試清單", "s24": "2.4 測試工具", "s25": "2.5 參考規範",
        "ch3": "第3章 測試詳情", "ch4": "第4章 漏洞等級評定", "ch5": "第5章 系統等級評定",
        "tbl_service": "表 1-1 服務內容及成果", "tbl_remediation": "表 1-2 整改結論",
        "tbl_personnel": "表 2-1 測試人員資訊", "tbl_checklist": "表 2-2 測試清單",
        "tbl_tools": "表 2-3 測試工具", "tbl_vulnlist": "表 3-1 漏洞列表",
        "tbl_rating_res_cap": "表 5-1 系統等級評定結果",
        "hdr_service": ["系統名稱", "網域/位址", "嚴重", "高危", "中危", "低危", "系統等級"],
        "hdr_remediation": ["序號", "修復對象", "整改結論", "備註"],
        "hdr_personnel": ["姓名", "角色", "聯絡方式"],
        "hdr_checklist": ["漏洞類型", "漏洞名稱", "描述", "測試結果"],
        "hdr_tools": ["工具名稱", "描述"],
        "hdr_vulnlist": ["漏洞等級", "漏洞名稱", "描述", "修復情況"],
        "hdr_cvss": ["評分項", "取值", "說明"],
        "hdr_rating_def": ["系統等級", "判定標準", "說明"],
        "hdr_rating_res": ["系統名稱", "嚴重/高危/中危/低危", "系統等級"],
        "info_target": "影響目標", "info_severity": "風險等級", "info_found": "發現時間",
        "sub_desc": "1. 漏洞描述", "sub_url": "2. URL", "sub_module": "3. 所屬模組",
        "sub_process": "4. 測試過程", "sub_risk": "5. 風險分析",
        "sub_fix": "6. 修復建議", "sub_status": "7. 修復情況",
        "chk_pass": "通過", "chk_fail": "不通過",
        "kv_sep": "：", "lparen": "（", "rparen": "）", "cvss_sep": "/", "cvss_word": "CVSS分值",
        "cvss_vector_row": "CVSS 向量", "cvss_overall": "綜合評分 {c}",
        "cvss_metric_names": [["AV", "攻擊向量"], ["AC", "攻擊複雜度"], ["PR", "權限要求"], ["UI", "使用者互動"],
                              ["S", "影響範圍"], ["C", "機密性"], ["I", "完整性"], ["A", "可用性"]],
        "page_pre": "第 ", "page_mid": " 頁 / 共 ", "page_suf": " 頁",
        "client": "客戶名稱：", "project": "專案名稱：", "version": "報告版本：", "date": "報告日期：",
        "report_word": "滲透測試報告",
        "cvss_intro": "本次滲透測試依據通用漏洞評分系統 CVSS {v} 對每個漏洞進行量化評分。評分綜合考慮攻擊向量（AV）、攻擊複雜度（AC）、權限要求（PR）、使用者互動（UI）、影響範圍（S）、機密性（C）、完整性（I）、可用性（A）八項指標，據此確定漏洞的嚴重程度等級。",
        "sev_criteria": "嚴重程度劃分標準",
        "hdr_sev": ["等級", "CVSS 分值範圍", "說明"],
        "sev_rows": [["嚴重", "9.0 – 10.0", "可直接導致系統完全失陷或大規模資料洩漏"],
                     ["高危", "7.0 – 8.9", "可取得重要資料或服務控制權"],
                     ["中危", "4.0 – 6.9", "可導致資訊洩漏或受限操作"],
                     ["低危", "0.1 – 3.9", "影響有限的設定或資訊類問題"]],
        "rating_intro": "系統安全等級依據該系統中發現的最高嚴重度漏洞確定，等級定義如下：",
        "rating_def_rows": [["嚴重", "存在嚴重漏洞", "可直接利用導致系統完全失陷"],
                            ["高危", "存在高危漏洞", "攻擊者可取得重要資料或服務控制權"],
                            ["中危", "存在中危漏洞", "可能導致資訊洩漏或受限操作"],
                            ["低危", "存在低危漏洞", "影響有限"],
                            ["安全", "未發現漏洞", "本次未發現安全漏洞"]],
    },
    "en-US": {
        "toc": "Table of Contents",
        "toc_hint": "Press F9 in Word to update the table of contents",
        "ch1": "1  Executive Summary", "s11": "1.1  Project Background", "s12": "1.2  Service Deliverables", "s13": "1.3  Remediation Summary",
        "ch2": "2  Test Information", "s21": "2.1  Personnel", "s22": "2.2  Testing Methodology",
        "s23": "2.3  Test Checklist", "s24": "2.4  Testing Tools", "s25": "2.5  Reference Standards",
        "ch3": "3  Detailed Findings", "ch4": "4  Vulnerability Severity Rating", "ch5": "5  System Security Rating",
        "tbl_service": "Table 1-1  Service Scope and Results", "tbl_remediation": "Table 1-2  Remediation Summary",
        "tbl_personnel": "Table 2-1  Testing Personnel", "tbl_checklist": "Table 2-2  Test Checklist",
        "tbl_tools": "Table 2-3  Testing Tools", "tbl_vulnlist": "Table 3-1  Vulnerability List",
        "tbl_rating_res_cap": "Table 5-1  System Rating Results",
        "hdr_service": ["System Name", "Domain / Address", "Crit", "High", "Med", "Low", "Rating"],
        "hdr_remediation": ["No.", "Remediation Item", "Conclusion", "Remark"],
        "hdr_personnel": ["Name", "Role", "Contact"],
        "hdr_checklist": ["Category", "Vulnerability", "Description", "Result"],
        "hdr_tools": ["Tool", "Description"],
        "hdr_vulnlist": ["Severity", "Vulnerability Name", "Description", "Status"],
        "hdr_cvss": ["Metric", "Value", "Description"],
        "hdr_rating_def": ["Rating", "Criteria", "Description"],
        "hdr_rating_res": ["System Name", "Crit / High / Med / Low", "Rating"],
        "info_target": "Target", "info_severity": "Severity", "info_found": "Date Found",
        "sub_desc": "1. Description", "sub_url": "2. URL", "sub_module": "3. Affected Module",
        "sub_process": "4. Test Process", "sub_risk": "5. Risk Analysis",
        "sub_fix": "6. Remediation", "sub_status": "7. Remediation Status",
        "chk_pass": "Pass", "chk_fail": "Fail",
        "kv_sep": ": ", "lparen": " (", "rparen": ")", "cvss_sep": " / ", "cvss_word": "CVSS ",
        "cvss_vector_row": "CVSS Vector", "cvss_overall": "Overall score {c}",
        "cvss_metric_names": [["AV", "Attack Vector"], ["AC", "Attack Complexity"], ["PR", "Privileges Required"], ["UI", "User Interaction"],
                              ["S", "Scope"], ["C", "Confidentiality"], ["I", "Integrity"], ["A", "Availability"]],
        "page_pre": "Page ", "page_mid": " of ", "page_suf": "",
        "client": "Client: ", "project": "Project: ", "version": "Version: ", "date": "Date: ",
        "report_word": "Penetration Test Report",
        "cvss_intro": "This assessment scores each vulnerability using the Common Vulnerability Scoring System (CVSS {v}). Scoring accounts for Attack Vector (AV), Attack Complexity (AC), Privileges Required (PR), User Interaction (UI), Scope (S), Confidentiality (C), Integrity (I), and Availability (A) to determine the severity rating.",
        "sev_criteria": "Severity Rating Criteria",
        "hdr_sev": ["Rating", "CVSS Range", "Description"],
        "sev_rows": [["Critical", "9.0 – 10.0", "May directly lead to full system compromise or large-scale data breach"],
                     ["High", "7.0 – 8.9", "May obtain critical data or control of services"],
                     ["Medium", "4.0 – 6.9", "May lead to information disclosure or restricted operations"],
                     ["Low", "0.1 – 3.9", "Limited-impact configuration or informational issues"]],
        "rating_intro": "The security rating of each system is determined by the highest-severity vulnerability it contains, defined as follows:",
        "rating_def_rows": [["Critical", "Contains a critical vulnerability", "Directly exploitable to fully compromise the system"],
                            ["High", "Contains a high-severity vulnerability", "Attacker may obtain critical data or control of services"],
                            ["Medium", "Contains a medium-severity vulnerability", "May lead to information disclosure or restricted operations"],
                            ["Low", "Contains a low-severity vulnerability", "Limited impact"],
                            ["Secure", "No vulnerabilities found", "No security vulnerabilities identified in this assessment"]],
    },
}


def L(meta, key):
    loc = meta.get("locale", "zh-CN")
    return LABELS.get(loc, LABELS["zh-CN"]).get(key, LABELS["zh-CN"].get(key, key))


def as_list(v):
    """Coerce an AI/JSON field to a list: None → [], scalar → [scalar], list → list.
    Guards against the LLM emitting null or a bare string where an array is expected."""
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return list(v)
    return [v]


# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------
def set_cn_font(run, font=UI_FONT, size_pt=None, bold=None, color=None):
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn('w:rFonts'))
    if rFonts is None:
        rFonts = OxmlElement('w:rFonts')
        rPr.insert(0, rFonts)
    rFonts.set(qn('w:ascii'), font)
    rFonts.set(qn('w:hAnsi'), font)
    rFonts.set(qn('w:eastAsia'), font)
    rFonts.set(qn('w:cs'), font)
    if size_pt is not None:
        run.font.size = Pt(size_pt)
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color


def configure_styles(doc):
    """Style the built-in Normal + Heading 1/2/3 to match the delivery template."""
    normal = doc.styles['Normal']
    normal.font.name = BODY_FONT
    normal.font.size = Pt(10.5)
    normal._element.rPr.rFonts.set(qn('w:eastAsia'), BODY_FONT)
    for lvl, sz in [(1, 16), (2, 14), (3, 12)]:
        st = doc.styles[f'Heading {lvl}']
        st.font.name = UI_FONT
        st.font.size = Pt(sz)
        st.font.bold = True
        st.font.color.rgb = TITLE_BLUE
        rpr = st.element.get_or_add_rPr()
        rf = rpr.find(qn('w:rFonts'))
        if rf is None:
            rf = OxmlElement('w:rFonts')
            rpr.insert(0, rf)
        rf.set(qn('w:eastAsia'), UI_FONT)
        pf = st.paragraph_format
        pf.space_before = Pt({1: 12, 2: 8, 3: 6}[lvl])
        pf.space_after = Pt({1: 6, 2: 4, 3: 3}[lvl])
        pf.keep_with_next = True


def add_paragraph(doc, text='', align=None, font=UI_FONT, size_pt=10.5,
                  bold=False, color=None, space_before=None, space_after=None):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    pf = p.paragraph_format
    if space_before is not None:
        pf.space_before = Pt(space_before)
    if space_after is not None:
        pf.space_after = Pt(space_after)
    if text:
        r = p.add_run(text)
        set_cn_font(r, font=font, size_pt=size_pt, bold=bold, color=color)
    return p


def add_page_break(doc):
    r = doc.add_paragraph().add_run()
    br = OxmlElement('w:br')
    br.set(qn('w:type'), 'page')
    r._element.append(br)


def add_heading(doc, text, level):
    p = doc.add_paragraph(style=f'Heading {level}')
    r = p.add_run(text)
    set_cn_font(r, font=UI_FONT, bold=True, color=TITLE_BLUE)
    return p


def add_body_text(doc, text, size_pt=10.5):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.first_line_indent = Pt(size_pt * 2)   # 首行缩进 2 字
    pf.line_spacing = 1.5
    pf.space_after = Pt(3)
    r = p.add_run(text)
    set_cn_font(r, font=BODY_FONT, size_pt=size_pt)
    return p


def add_list_item(doc, text, number=None, size_pt=10.5):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.left_indent = Cm(0.74)
    pf.first_line_indent = Cm(-0.74)
    pf.line_spacing = 1.5
    pf.space_after = Pt(2)
    prefix = f"{number}）" if number else "• "
    r = p.add_run(prefix)
    set_cn_font(r, font=BODY_FONT, size_pt=size_pt)
    r2 = p.add_run(text)
    set_cn_font(r2, font=BODY_FONT, size_pt=size_pt)
    return p


def add_code_block(doc, code):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(4)
    pf.space_after = Pt(4)
    pf.left_indent = Cm(0.6)
    pPr = p._element.get_or_add_pPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), CODE_BG)
    pPr.append(shd)
    pBdr = OxmlElement('w:pBdr')
    for edge in ('top', 'left', 'bottom', 'right'):
        b = OxmlElement(f'w:{edge}')
        b.set(qn('w:val'), 'single')
        b.set(qn('w:sz'), '4')
        b.set(qn('w:space'), '4')
        b.set(qn('w:color'), 'CCCCCC')
        pBdr.append(b)
    pPr.append(pBdr)
    for i, line in enumerate(code.rstrip('\n').split('\n')):
        if i > 0:
            p.add_run().add_break()
        r = p.add_run(line if line else ' ')
        # ASCII monospace, CJK falls back to 宋体
        set_cn_font(r, font=CODE_FONT, size_pt=9)
        r._element.get_or_add_rPr().find(qn('w:rFonts')).set(qn('w:eastAsia'), BODY_FONT)


def add_caption(doc, text):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pf = p.paragraph_format
    pf.space_before = Pt(6)
    pf.space_after = Pt(2)
    r = p.add_run(text)
    set_cn_font(r, font=UI_FONT, size_pt=9, color=CAPTION_GRAY)


def add_picture(doc, path, caption=None, width_cm=15):
    import os
    if not path or not os.path.exists(path):
        return
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pf = p.paragraph_format
    pf.space_before = Pt(6)
    pf.space_after = Pt(2)
    try:
        p.add_run().add_picture(path, width=Cm(width_cm))
    except Exception:
        return
    if caption:
        add_caption(doc, caption)


# ---------------------------------------------------------------------------
# Table helpers
# ---------------------------------------------------------------------------
def set_cell_text(cell, text, font=UI_FONT, size_pt=9.5, bold=False,
                  align=WD_ALIGN_PARAGRAPH.LEFT, color=None, shade=None):
    cell.text = ''
    cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
    p = cell.paragraphs[0]
    p.alignment = align
    pf = p.paragraph_format
    pf.space_before = Pt(2)
    pf.space_after = Pt(2)
    pf.first_line_indent = Pt(0)
    for i, line in enumerate(str(text).split('\n')):
        if i > 0:
            p.add_run().add_break()
        r = p.add_run(line)
        set_cn_font(r, font=font, size_pt=size_pt, bold=bold, color=color)
    if shade is not None:
        tcPr = cell._tc.get_or_add_tcPr()
        old = tcPr.find(qn('w:shd'))
        if old is not None:
            tcPr.remove(old)
        shd = OxmlElement('w:shd')
        shd.set(qn('w:val'), 'clear')
        shd.set(qn('w:color'), 'auto')
        shd.set(qn('w:fill'), shade)
        tcPr.append(shd)


def set_table_borders(table, color=GRAY_BORDER, sz='6'):
    tblPr = table._element.find(qn('w:tblPr'))
    old = tblPr.find(qn('w:tblBorders'))
    if old is not None:
        tblPr.remove(old)
    tb = OxmlElement('w:tblBorders')
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        b = OxmlElement(f'w:{edge}')
        b.set(qn('w:val'), 'single')
        b.set(qn('w:sz'), sz)
        b.set(qn('w:space'), '0')
        b.set(qn('w:color'), color)
        tb.append(b)
    tblPr.append(tb)


def set_col_widths(table, widths_cm):
    table.autofit = False
    table.allow_autofit = False
    tbl = table._element
    tblPr = tbl.find(qn('w:tblPr'))
    layout = tblPr.find(qn('w:tblLayout'))
    if layout is None:
        layout = OxmlElement('w:tblLayout')
        tblPr.append(layout)
    layout.set(qn('w:type'), 'fixed')
    tblW = tblPr.find(qn('w:tblW'))
    if tblW is None:
        tblW = OxmlElement('w:tblW')
        tblPr.append(tblW)
    tblW.set(qn('w:w'), str(int(sum(widths_cm) * 567)))
    tblW.set(qn('w:type'), 'dxa')
    grid = tbl.find(qn('w:tblGrid'))
    if grid is not None:
        tbl.remove(grid)
    grid = OxmlElement('w:tblGrid')
    for w in widths_cm:
        gc = OxmlElement('w:gridCol')
        gc.set(qn('w:w'), str(int(w * 567)))
        grid.append(gc)
    tbl.insert(list(tbl).index(tblPr) + 1, grid)
    for row in table.rows:
        for i, cell in enumerate(row.cells):
            if i >= len(widths_cm):
                continue
            tcPr = cell._tc.get_or_add_tcPr()
            tcW = tcPr.find(qn('w:tcW'))
            if tcW is None:
                tcW = OxmlElement('w:tcW')
                tcPr.append(tcW)
            tcW.set(qn('w:w'), str(int(widths_cm[i] * 567)))
            tcW.set(qn('w:type'), 'dxa')


def repeat_header(table):
    trPr = table.rows[0]._tr.get_or_add_trPr()
    trPr.append(OxmlElement('w:tblHeader'))


def build_table(doc, header, rows, widths_cm, col_aligns=None, font_size=9.5):
    ncols = len(header)
    if col_aligns is None:
        col_aligns = [WD_ALIGN_PARAGRAPH.LEFT] * ncols
    table = doc.add_table(rows=1 + len(rows), cols=ncols)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_col_widths(table, widths_cm)
    set_table_borders(table)
    for j, h in enumerate(header):
        set_cell_text(table.rows[0].cells[j], h, size_pt=font_size, bold=True,
                      align=WD_ALIGN_PARAGRAPH.CENTER, shade=HEADER_SHADE)
    for i, row in enumerate(rows):
        for j, val in enumerate(row):
            set_cell_text(table.rows[i + 1].cells[j], val, size_pt=font_size,
                          align=col_aligns[j] if j < len(col_aligns) else WD_ALIGN_PARAGRAPH.LEFT)
    repeat_header(table)
    return table


def add_vuln_info_table(doc, meta, target, severity, found_date):
    t = doc.add_table(rows=3, cols=2)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_col_widths(t, [3.5, 12.0])
    set_table_borders(t)
    fields = [(L(meta, "info_target"), target),
              (L(meta, "info_severity"), severity),
              (L(meta, "info_found"), found_date)]
    for i, (k, v) in enumerate(fields):
        set_cell_text(t.rows[i].cells[0], k, size_pt=10, bold=True,
                      align=WD_ALIGN_PARAGRAPH.CENTER, shade=HEADER_SHADE)
        set_cell_text(t.rows[i].cells[1], v or "—", size_pt=10, align=WD_ALIGN_PARAGRAPH.LEFT)
    return t


# ---------------------------------------------------------------------------
# TOC + footer fields
# ---------------------------------------------------------------------------
def add_toc_field(doc, meta):
    p = doc.add_paragraph()
    for kind, txt in [('begin', None), ('instr', r' TOC \o "1-3" \h \z \u '),
                      ('separate', None), ('text', L(meta, "toc_hint")), ('end', None)]:
        r = OxmlElement('w:r')
        if kind == 'instr':
            e = OxmlElement('w:instrText')
            e.set(qn('xml:space'), 'preserve')
            e.text = txt
            r.append(e)
        elif kind == 'text':
            e = OxmlElement('w:t')
            e.text = txt
            r.append(e)
        else:
            e = OxmlElement('w:fldChar')
            e.set(qn('w:fldCharType'), kind)
            r.append(e)
        p._element.append(r)


def setup_footer(doc, meta):
    footer = doc.sections[0].footer
    for p in list(footer.paragraphs):
        p._element.getparent().remove(p._element)
    p = footer.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    def run_text(text):
        r = p.add_run(text)
        set_cn_font(r, font=UI_FONT, size_pt=9, color=RGBColor(0x64, 0x64, 0x64))

    def run_field(instr):
        r = p.add_run()
        set_cn_font(r, font=UI_FONT, size_pt=9, color=RGBColor(0x64, 0x64, 0x64))
        for t in ('begin', 'sep', 'ph', 'end'):
            if t == 'begin':
                fc = OxmlElement('w:fldChar'); fc.set(qn('w:fldCharType'), 'begin'); r._element.append(fc)
                ir = p.add_run(); it = OxmlElement('w:instrText'); it.set(qn('xml:space'), 'preserve')
                it.text = f' {instr} '; ir._element.append(it)
            elif t == 'sep':
                sr = p.add_run(); fc = OxmlElement('w:fldChar'); fc.set(qn('w:fldCharType'), 'separate'); sr._element.append(fc)
            elif t == 'ph':
                pr = p.add_run('1'); set_cn_font(pr, font=UI_FONT, size_pt=9, color=RGBColor(0x64, 0x64, 0x64))
            else:
                er = p.add_run(); fc = OxmlElement('w:fldChar'); fc.set(qn('w:fldCharType'), 'end'); er._element.append(fc)

    run_text(L(meta, "page_pre"))
    run_field('PAGE \\* MERGEFORMAT')
    run_text(L(meta, "page_mid"))
    run_field('NUMPAGES \\* MERGEFORMAT')
    run_text(L(meta, "page_suf"))


def setup_header(doc, meta):
    """Header: company name (left) — no third-party logo unless provided."""
    header = doc.sections[0].header
    for p in list(header.paragraphs):
        p._element.getparent().remove(p._element)
    p = header.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(f"{meta.get('company_name','')}  |  {meta.get('report_title','')}")
    set_cn_font(r, font=UI_FONT, size_pt=9, color=RGBColor(0x80, 0x80, 0x80))
    # bottom border on header
    pPr = p._element.get_or_add_pPr()
    pBdr = OxmlElement('w:pBdr')
    bot = OxmlElement('w:bottom')
    bot.set(qn('w:val'), 'single'); bot.set(qn('w:sz'), '4'); bot.set(qn('w:space'), '1'); bot.set(qn('w:color'), 'BFBFBF')
    pBdr.append(bot); pPr.append(pBdr)


# ---------------------------------------------------------------------------
# Cover
# ---------------------------------------------------------------------------
def build_cover(doc, meta):
    add_paragraph(doc)
    add_paragraph(doc)
    logo = meta.get('logo_path')
    if logo:
        import os
        if os.path.exists(logo):
            pl = doc.add_paragraph()
            pl.alignment = WD_ALIGN_PARAGRAPH.CENTER
            try:
                pl.add_run().add_picture(logo, width=Cm(6.5))
            except Exception:
                pass
    else:
        add_paragraph(doc)
        add_paragraph(doc)

    title = meta.get('report_title') or (meta.get('client_name', '') + L(meta, "report_word"))
    # split into subject / "渗透测试报告" if it ends with the report word
    rw = L(meta, "report_word")
    if title.endswith(rw) and len(title) > len(rw):
        subject = title[:-len(rw)]
        add_paragraph(doc, subject, align=WD_ALIGN_PARAGRAPH.CENTER, font=UI_FONT,
                      size_pt=32, bold=True, color=TITLE_BLUE, space_before=12, space_after=6)
        add_paragraph(doc, rw, align=WD_ALIGN_PARAGRAPH.CENTER, font=UI_FONT,
                      size_pt=32, bold=True, color=TITLE_BLUE, space_before=0, space_after=24)
    else:
        add_paragraph(doc, title, align=WD_ALIGN_PARAGRAPH.CENTER, font=UI_FONT,
                      size_pt=32, bold=True, color=TITLE_BLUE, space_before=12, space_after=24)

    # orange separator line
    lp = doc.add_paragraph()
    lp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pPr = lp._element.get_or_add_pPr()
    pBdr = OxmlElement('w:pBdr')
    bot = OxmlElement('w:bottom')
    bot.set(qn('w:val'), 'single'); bot.set(qn('w:sz'), '18'); bot.set(qn('w:space'), '1'); bot.set(qn('w:color'), ORANGE)
    pBdr.append(bot); pPr.append(pBdr)

    add_paragraph(doc)
    add_paragraph(doc)

    info = doc.add_table(rows=4, cols=2)
    info.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_col_widths(info, [4.5, 9.5])
    data = [(L(meta, "client"), meta.get('client_name', '')),
            (L(meta, "project"), meta.get('project_name', '')),
            (L(meta, "version"), meta.get('version', 'V1.0')),
            (L(meta, "date"), meta.get('date', ''))]
    for i, (k, v) in enumerate(data):
        set_cell_text(info.rows[i].cells[0], k, size_pt=13, bold=True, align=WD_ALIGN_PARAGRAPH.RIGHT)
        set_cell_text(info.rows[i].cells[1], v or '—', size_pt=13, align=WD_ALIGN_PARAGRAPH.LEFT)
    # hide borders
    tblPr = info._element.find(qn('w:tblPr'))
    tb = OxmlElement('w:tblBorders')
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        b = OxmlElement(f'w:{edge}'); b.set(qn('w:val'), 'nil'); tb.append(b)
    tblPr.append(tb)

    add_paragraph(doc)
    add_paragraph(doc, meta.get('company_name', ''), align=WD_ALIGN_PARAGRAPH.CENTER,
                  font=UI_FONT, size_pt=14, bold=True, color=TITLE_BLUE, space_before=24)
    add_page_break(doc)


# ---------------------------------------------------------------------------
# Chapters
# ---------------------------------------------------------------------------
def build_ch1(doc, data, meta):
    add_heading(doc, L(meta, "ch1"), 1)
    add_heading(doc, L(meta, "s11"), 2)
    for para in as_list(data.get('summary', {}).get('background')):
        add_body_text(doc, para)

    add_heading(doc, L(meta, "s12"), 2)
    sr = data.get('summary', {}).get('service_result')
    if sr:
        add_body_text(doc, sr)
    systems = data.get('summary', {}).get('systems', [])
    if systems:
        add_caption(doc, L(meta, "tbl_service"))
        rows = [[s.get('name', ''), s.get('address', ''), str(s.get('crit', 0)),
                 str(s.get('high', 0)), str(s.get('med', 0)), str(s.get('low', 0)),
                 s.get('rating', '')] for s in systems]
        C = WD_ALIGN_PARAGRAPH.CENTER
        build_table(doc, L(meta, "hdr_service"), rows, [3.2, 4.0, 1.0, 1.0, 1.0, 1.0, 1.8],
                    col_aligns=[WD_ALIGN_PARAGRAPH.LEFT, WD_ALIGN_PARAGRAPH.LEFT, C, C, C, C, C])

    add_heading(doc, L(meta, "s13"), 2)
    rc = data.get('summary', {}).get('remediation_conclusion')
    if rc:
        add_body_text(doc, rc)
    items = data.get('summary', {}).get('remediation_items', [])
    if items:
        add_caption(doc, L(meta, "tbl_remediation"))
        rows = [[str(it.get('idx', i + 1)), it.get('object', ''), it.get('conclusion', '待修复'),
                 it.get('remark', '')] for i, it in enumerate(items)]
        C = WD_ALIGN_PARAGRAPH.CENTER
        build_table(doc, L(meta, "hdr_remediation"), rows, [1.2, 8.0, 2.5, 3.0],
                    col_aligns=[C, WD_ALIGN_PARAGRAPH.LEFT, C, WD_ALIGN_PARAGRAPH.LEFT])
    add_page_break(doc)


def build_ch2(doc, data, meta):
    add_heading(doc, L(meta, "ch2"), 1)
    # 2.1 personnel
    add_heading(doc, L(meta, "s21"), 2)
    add_caption(doc, L(meta, "tbl_personnel"))
    prows = [[p.get('name', ''), p.get('role', ''), p.get('contact', '')]
             for p in data.get('personnel', [])]
    build_table(doc, L(meta, "hdr_personnel"), prows, [4.5, 6.0, 5.0])
    # 2.2 methodology
    add_heading(doc, L(meta, "s22"), 2)
    intro = data.get('methodology_intro')
    if intro:
        add_body_text(doc, intro)
    for i, step in enumerate(data.get('methodology', []), 1):
        add_list_item(doc, f"{step.get('name','')}{L(meta, 'kv_sep')}{step.get('desc','')}", number=i)
    # 2.3 checklist
    add_heading(doc, L(meta, "s23"), 2)
    add_caption(doc, L(meta, "tbl_checklist"))
    build_checklist(doc, data.get('checklist', []), meta)
    # 2.4 tools
    add_heading(doc, L(meta, "s24"), 2)
    add_caption(doc, L(meta, "tbl_tools"))
    trows = [[t.get('name', ''), t.get('desc', '')] for t in data.get('tools', [])]
    build_table(doc, L(meta, "hdr_tools"), trows, [4.5, 11.0])
    # 2.5 standards
    add_heading(doc, L(meta, "s25"), 2)
    for s in data.get('standards', []):
        add_list_item(doc, s)
    add_page_break(doc)


def build_checklist(doc, checklist, meta):
    t = doc.add_table(rows=1 + len(checklist), cols=4)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_col_widths(t, [2.3, 3.4, 8.5, 1.3])
    set_table_borders(t)
    for j, h in enumerate(L(meta, "hdr_checklist")):
        set_cell_text(t.rows[0].cells[j], h, size_pt=9.5, bold=True,
                      align=WD_ALIGN_PARAGRAPH.CENTER, shade=HEADER_SHADE)
    repeat_header(t)
    for i, item in enumerate(checklist, 1):
        # Go emits a stable "pass" | "fail" token; localize the display here.
        hit = item.get('result') == 'fail'
        result_txt = L(meta, "chk_fail") if hit else L(meta, "chk_pass")
        set_cell_text(t.rows[i].cells[0], item.get('category', ''), size_pt=9, align=WD_ALIGN_PARAGRAPH.LEFT)
        set_cell_text(t.rows[i].cells[1], item.get('name', ''), size_pt=9, bold=hit, align=WD_ALIGN_PARAGRAPH.LEFT)
        set_cell_text(t.rows[i].cells[2], item.get('desc', ''), size_pt=9, align=WD_ALIGN_PARAGRAPH.LEFT)
        set_cell_text(t.rows[i].cells[3], result_txt, size_pt=9, bold=True,
                      color=HIT_RED if hit else None, align=WD_ALIGN_PARAGRAPH.CENTER)


def build_ch3(doc, data, meta):
    add_heading(doc, L(meta, "ch3"), 1)
    intro = data.get('findings_intro')
    if intro:
        add_body_text(doc, intro)
    vl = data.get('vuln_list', [])
    if vl:
        add_caption(doc, L(meta, "tbl_vulnlist"))
        rows = [[v.get('severity', ''), v.get('name', ''), v.get('desc', ''), v.get('status', '待修复')] for v in vl]
        C = WD_ALIGN_PARAGRAPH.CENTER
        build_table(doc, L(meta, "hdr_vulnlist"), rows, [1.6, 4.6, 8.0, 1.3],
                    col_aligns=[C, WD_ALIGN_PARAGRAPH.LEFT, WD_ALIGN_PARAGRAPH.LEFT, C])

    for sysd in (data.get('systems_detail') or []):
        add_heading(doc, sysd.get('name', ''), 2)
        for v in sysd.get('vulns', []):
            build_vuln(doc, v, meta)
    add_page_break(doc)


def fmt_cvss(cvss):
    """CVSS score as a clean 1-decimal string ('9.8')—float32→float64 存储噪声(9.800000190734863)归一。"""
    try:
        return f"{round(float(cvss), 1)}"
    except (TypeError, ValueError):
        return str(cvss or "")


def vuln_heading_text(meta, sec_no, title, sev, cvss):
    """Compose e.g. '3.1.1 Title (High / CVSS 5.9)' with locale-aware parens."""
    tail = sev
    if cvss:
        tail = f"{sev}{L(meta, 'cvss_sep')}{L(meta, 'cvss_word')}{fmt_cvss(cvss)}"
    head = f"{sec_no} {title}".strip()
    return f"{head}{L(meta, 'lparen')}{tail}{L(meta, 'rparen')}"


def build_vuln(doc, v, meta):
    sev = v.get('severity', '')
    cvss = v.get('cvss_score')
    add_heading(doc, vuln_heading_text(meta, v.get('sec_no', ''), v.get('title', ''), sev, cvss), 3)
    add_vuln_info_table(doc, meta, v.get('target', ''), sev, v.get('found_date', ''))

    # 1. 漏洞描述
    add_paragraph(doc, L(meta, "sub_desc"), font=UI_FONT, size_pt=11, bold=True, space_before=6, space_after=2)
    for para in as_list(v.get('description')):
        add_body_text(doc, para)
    # 2. URL
    add_paragraph(doc, L(meta, "sub_url"), font=UI_FONT, size_pt=11, bold=True, space_before=6, space_after=2)
    add_body_text(doc, v.get('url') or v.get('target') or '')
    # 3. 所属模块
    add_paragraph(doc, L(meta, "sub_module"), font=UI_FONT, size_pt=11, bold=True, space_before=6, space_after=2)
    add_body_text(doc, v.get('module') or '—')
    # 4. 测试过程
    add_paragraph(doc, L(meta, "sub_process"), font=UI_FONT, size_pt=11, bold=True, space_before=6, space_after=2)
    for block in as_list(v.get('test_process')):
        if not isinstance(block, dict):
            add_body_text(doc, str(block))
            continue
        bt = block.get('type')
        if bt == 'code':
            add_code_block(doc, block.get('content', ''))
        elif bt == 'image':
            add_picture(doc, block.get('path', ''), caption=block.get('caption'))
        else:
            add_body_text(doc, block.get('content', ''))
    # 5. 风险分析
    add_paragraph(doc, L(meta, "sub_risk"), font=UI_FONT, size_pt=11, bold=True, space_before=6, space_after=2)
    for i, item in enumerate(as_list(v.get('risk_analysis')), 1):
        add_list_item(doc, item, number=i)
    # 6. 修复建议
    add_paragraph(doc, L(meta, "sub_fix"), font=UI_FONT, size_pt=11, bold=True, space_before=6, space_after=2)
    for i, item in enumerate(as_list(v.get('remediation')), 1):
        add_list_item(doc, item, number=i)
    # 7. 修复情况
    add_paragraph(doc, L(meta, "sub_status"), font=UI_FONT, size_pt=11, bold=True, space_before=6, space_after=2)
    add_body_text(doc, v.get('fix_status') or '—')


def build_ch4(doc, data, meta):
    add_heading(doc, L(meta, "ch4"), 1)
    add_body_text(doc, L(meta, "cvss_intro").format(v=meta.get('cvss_version', '3.1')))
    add_heading(doc, L(meta, "sev_criteria"), 2)
    C = WD_ALIGN_PARAGRAPH.CENTER
    build_table(doc, L(meta, "hdr_sev"), L(meta, "sev_rows"), [2.5, 4.0, 9.0],
                col_aligns=[C, C, WD_ALIGN_PARAGRAPH.LEFT])
    # per-vuln CVSS tables
    for v in _all_vulns(data):
        metrics = v.get('cvss_metrics') or {}
        if not metrics and not v.get('cvss_vector'):
            continue
        sev = v.get('severity', '')
        cvss = v.get('cvss_score')
        add_heading(doc, vuln_heading_text(meta, '', v.get('title', ''), sev, cvss), 3)
        rows = []
        for code, name in L(meta, "cvss_metric_names"):
            val = metrics.get(code)
            if val:
                rows.append([f"{name} ({code})", val, ""])
        if v.get('cvss_vector'):
            overall = L(meta, "cvss_overall").format(c=cvss) if cvss else ""
            rows.append([L(meta, "cvss_vector_row"), v['cvss_vector'], overall])
        if rows:
            build_table(doc, L(meta, "hdr_cvss"), rows, [4.0, 4.0, 7.5],
                        col_aligns=[WD_ALIGN_PARAGRAPH.LEFT, WD_ALIGN_PARAGRAPH.LEFT, WD_ALIGN_PARAGRAPH.LEFT])
    add_page_break(doc)


def build_ch5(doc, data, meta):
    add_heading(doc, L(meta, "ch5"), 1)
    add_body_text(doc, L(meta, "rating_intro"))
    C = WD_ALIGN_PARAGRAPH.CENTER
    build_table(doc, L(meta, "hdr_rating_def"), L(meta, "rating_def_rows"), [2.5, 4.0, 9.0],
                col_aligns=[C, C, WD_ALIGN_PARAGRAPH.LEFT])
    systems = data.get('summary', {}).get('systems', [])
    if systems:
        rows = [[s.get('name', ''),
                 f"{s.get('crit',0)}/{s.get('high',0)}/{s.get('med',0)}/{s.get('low',0)}",
                 s.get('rating', '')] for s in systems]
        add_caption(doc, L(meta, "tbl_rating_res_cap"))
        build_table(doc, L(meta, "hdr_rating_res"), rows, [6.0, 5.5, 4.0],
                    col_aligns=[WD_ALIGN_PARAGRAPH.LEFT, C, C])
    concl = data.get('overall_conclusion')
    if concl:
        add_body_text(doc, concl)


def _all_vulns(data):
    out = []
    for sysd in (data.get('systems_detail') or []):
        out.extend(sysd.get('vulns', []))
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def build(data, output_path):
    meta = data.get('meta', {})
    if not meta.get('date'):
        meta['date'] = datetime.date.today().strftime('%Y年%m月%d日')
    doc = Document()
    # A4
    sec = doc.sections[0]
    sec.page_width = Cm(21.0)
    sec.page_height = Cm(29.7)
    sec.top_margin = Cm(2.54)
    sec.bottom_margin = Cm(2.54)
    sec.left_margin = Cm(2.8)
    sec.right_margin = Cm(2.8)
    configure_styles(doc)
    setup_header(doc, meta)
    setup_footer(doc, meta)

    build_cover(doc, meta)
    add_paragraph(doc, L(meta, "toc"), align=WD_ALIGN_PARAGRAPH.CENTER, font=UI_FONT,
                  size_pt=22, bold=True, color=TITLE_BLUE, space_before=12, space_after=24)
    add_toc_field(doc, meta)
    add_page_break(doc)
    build_ch1(doc, data, meta)
    build_ch2(doc, data, meta)
    build_ch3(doc, data, meta)
    build_ch4(doc, data, meta)
    build_ch5(doc, data, meta)

    doc.save(output_path)


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: report_builder.py <input.json> <output.docx>\n")
        sys.exit(2)
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        data = json.load(f)
    build(data, sys.argv[2])
    print(sys.argv[2])


if __name__ == '__main__':
    main()
