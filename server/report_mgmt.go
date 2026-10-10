package server

// Report management endpoints: org-level report settings (company / logo /
// personnel / CVSS), logo upload, and the generated-reports list.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"antifox/db"
)

// GET /api/report-settings
func (s *Server) getReportSettings(w http.ResponseWriter, r *http.Request) {
	rs, err := s.m.pg.GetReportSettings()
	if err != nil {
		writeErr(w, 500, "读取失败")
		return
	}
	writeJSON(w, 200, rs)
}

// PUT /api/report-settings
func (s *Server) putReportSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CompanyName   string `json:"company_name"`
		CompanyNameEn string `json:"company_name_en"`
		LogoPath      string `json:"logo_path"`
		Personnel     []struct {
			Name    string `json:"name"`
			Role    string `json:"role"`
			Contact string `json:"contact"`
		} `json:"personnel"`
		CVSSVersion string `json:"cvss_version"`
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	pj, _ := json.Marshal(body.Personnel)
	rs := &db.ReportSettings{
		CompanyName: strings.TrimSpace(body.CompanyName), CompanyNameEn: strings.TrimSpace(body.CompanyNameEn),
		LogoPath: strings.TrimSpace(body.LogoPath), Personnel: pj, CVSSVersion: strings.TrimSpace(body.CVSSVersion),
	}
	if err := s.m.pg.SaveReportSettings(rs); err != nil {
		writeErr(w, 500, "保存失败: "+err.Error())
		return
	}
	saved, _ := s.m.pg.GetReportSettings()
	writeJSON(w, 200, saved)
}

// POST /api/report-assets/logo — multipart "file" → data/report_assets/, returns relative path.
func (s *Server) uploadReportLogo(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(8 << 20); err != nil { // 8 MB cap
		writeErr(w, 400, "上传解析失败")
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, 400, "缺少文件")
		return
	}
	defer file.Close()
	ext := strings.ToLower(filepath.Ext(hdr.Filename))
	if ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".svg" && ext != ".webp" {
		writeErr(w, 400, "仅支持 png/jpg/svg/webp")
		return
	}
	dir := filepath.Join(s.dataDir, "report_assets")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeErr(w, 500, "创建目录失败")
		return
	}
	name := fmt.Sprintf("logo-%d%s", time.Now().UnixNano(), ext)
	dst, err := os.Create(filepath.Join(dir, name))
	if err != nil {
		writeErr(w, 500, "写入失败")
		return
	}
	defer dst.Close()
	if _, err := io.Copy(dst, file); err != nil {
		writeErr(w, 500, "写入失败")
		return
	}
	// Return the uploaded asset path for preview only — it is persisted to
	// report_settings when the user clicks Save (PUT /report-settings), so
	// "upload" and "clear logo" stay symmetric (both staged until Save).
	rel := filepath.Join("report_assets", name)
	writeJSON(w, 200, map[string]any{"logo_path": rel, "url": "/api/report-assets/" + name})
}

// GET /api/report-assets/{file} — serve an uploaded logo (base name only, no traversal).
func (s *Server) serveReportAsset(w http.ResponseWriter, r *http.Request) {
	file := filepath.Base(r.PathValue("file"))
	http.ServeFile(w, r, filepath.Join(s.dataDir, "report_assets", file))
}

// seedDemoReportTemplate inserts one illustrative (deletable) template on first
// run so users see how templates work. Gated by a marker file so it seeds only
// once ever — deleting the demo won't bring it back on restart.
func (s *Server) seedDemoReportTemplate() {
	marker := filepath.Join(s.dataDir, ".report_demo_template_seeded")
	if _, err := os.Stat(marker); err == nil {
		return
	}
	if ts, err := s.m.pg.ListReportTemplates(); err == nil && len(ts) == 0 {
		pj, _ := json.Marshal([]map[string]string{
			{"name": "张三", "role": "项目负责人 / 安全工程师", "contact": ""},
			{"name": "李四", "role": "红队评估", "contact": ""},
		})
		_, _ = s.m.pg.AddReportTemplate(&db.ReportTemplate{
			Name:          "标准中文交付（示例）",
			CompanyName:   "示例安全服务团队",
			CompanyNameEn: "Example Security Team",
			Personnel:     pj,
			CVSSVersion:   "3.1",
			Locale:        "zh-CN",
		})
	}
	_ = os.MkdirAll(s.dataDir, 0o755)
	_ = os.WriteFile(marker, []byte("1"), 0o644)
}

// ---- named report templates ----

type reportTemplateBody struct {
	Name          string `json:"name"`
	CompanyName   string `json:"company_name"`
	CompanyNameEn string `json:"company_name_en"`
	LogoPath      string `json:"logo_path"`
	Personnel     []struct {
		Name    string `json:"name"`
		Role    string `json:"role"`
		Contact string `json:"contact"`
	} `json:"personnel"`
	CVSSVersion string `json:"cvss_version"`
	Locale      string `json:"locale"`
}

func (b *reportTemplateBody) toDB(id int64) *db.ReportTemplate {
	pj, _ := json.Marshal(b.Personnel)
	return &db.ReportTemplate{
		ID: id, Name: strings.TrimSpace(b.Name), CompanyName: strings.TrimSpace(b.CompanyName),
		CompanyNameEn: strings.TrimSpace(b.CompanyNameEn), LogoPath: strings.TrimSpace(b.LogoPath),
		Personnel: pj, CVSSVersion: strings.TrimSpace(b.CVSSVersion), Locale: strings.TrimSpace(b.Locale),
	}
}

// GET /api/report-templates
func (s *Server) listReportTemplates(w http.ResponseWriter, r *http.Request) {
	ts, err := s.m.pg.ListReportTemplates()
	if err != nil {
		writeErr(w, 500, "读取失败")
		return
	}
	writeJSON(w, 200, ts)
}

// POST /api/report-templates
func (s *Server) createReportTemplate(w http.ResponseWriter, r *http.Request) {
	var body reportTemplateBody
	if err := decode(r, &body); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeErr(w, 400, "模版名称不能为空")
		return
	}
	id, err := s.m.pg.AddReportTemplate(body.toDB(0))
	if err != nil {
		writeErr(w, 500, "保存失败: "+err.Error())
		return
	}
	rt, _ := s.m.pg.GetReportTemplate(id)
	writeJSON(w, 200, rt)
}

// PUT /api/report-templates/{id}
func (s *Server) updateReportTemplate(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var body reportTemplateBody
	if err := decode(r, &body); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeErr(w, 400, "模版名称不能为空")
		return
	}
	if err := s.m.pg.UpdateReportTemplate(body.toDB(id)); err != nil {
		writeErr(w, 500, "保存失败: "+err.Error())
		return
	}
	rt, _ := s.m.pg.GetReportTemplate(id)
	writeJSON(w, 200, rt)
}

// DELETE /api/report-templates/{id}
func (s *Server) deleteReportTemplate(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err := s.m.pg.DeleteReportTemplate(id); err != nil {
		writeErr(w, 500, "删除失败: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// GET /api/reports — list generated reports.
func (s *Server) listReports(w http.ResponseWriter, r *http.Request) {
	rs, err := s.m.pg.ListReports(200)
	if err != nil {
		writeErr(w, 500, "读取失败")
		return
	}
	writeJSON(w, 200, rs)
}

// GET /api/reports/{id}/download — stream a recorded report .docx.
func (s *Server) downloadReportByID(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	rec, err := s.m.pg.GetReport(id)
	if err != nil || rec == nil {
		writeErr(w, 404, "报告不存在")
		return
	}
	// Resolve the file portably: report .docx always live in <dataDir>/reports, but
	// rec.Path is the absolute path captured at generation time — stale after a DB
	// restore onto a host with a different dataDir (e.g. dev /tmp/... → VPS /opt/...).
	// Prefer <dataDir>/reports/<filename>, fall back to the recorded path.
	path := filepath.Join(s.dataDir, "reports", filepath.Base(rec.Filename))
	if _, err := os.Stat(path); err != nil {
		path = rec.Path
	}
	if _, err := os.Stat(path); err != nil {
		writeErr(w, 404, "报告文件已不存在")
		return
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", rec.Filename))
	http.ServeFile(w, r, path)
}

// DELETE /api/reports/{id} — remove a recorded report (DB row + .docx file).
func (s *Server) deleteReportByID(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	rec, err := s.m.pg.GetReport(id)
	if err != nil || rec == nil {
		writeErr(w, 404, "报告不存在")
		return
	}
	if err := s.m.pg.DeleteReport(id); err != nil {
		writeErr(w, 500, "删除失败: "+err.Error())
		return
	}
	// best-effort remove the file (portable path first, then the recorded path).
	_ = os.Remove(filepath.Join(s.dataDir, "reports", filepath.Base(rec.Filename)))
	if rec.Path != "" {
		_ = os.Remove(rec.Path)
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
