package server

// Human-grade .docx report: async pipeline (AI narrative + python-docx) layered
// on top of the existing Markdown quick-view. POST /generate kicks off generation,
// GET /status polls, GET /download serves the finished file. All per-task, in-memory.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"antifox/db"
	"antifox/report"
)

type reportJob struct {
	Status    string    `json:"status"` // generating | done | failed
	Filename  string    `json:"filename,omitempty"`
	Error     string    `json:"error,omitempty"`
	StartedAt time.Time `json:"started_at"`
	path      string    // absolute path (not serialized)
}

// POST /api/report/generate?task=&company=&client=&title= — start async docx build.
func (s *Server) generateReport(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeErr(w, 404, "no active task")
		return
	}
	s.reportMu.Lock()
	if j := s.reportJobs[t.ID]; j != nil && j.Status == "generating" {
		snap := *j // copy under lock; the goroutine mutates *j concurrently
		s.reportMu.Unlock()
		writeJSON(w, 200, snap)
		return
	}
	job := &reportJob{Status: "generating", StartedAt: time.Now()}
	s.reportJobs[t.ID] = job
	snap := *job
	s.reportMu.Unlock()

	in := s.buildReportInput(t, r.URL.Query())
	taskID := t.ID
	taskDesc := t.Description
	go func() {
		// A panic in the builder must not leave the job stuck in "generating" forever.
		defer func() {
			if rec := recover(); rec != nil {
				s.reportMu.Lock()
				job.Status = "failed"
				job.Error = fmt.Sprintf("报告生成异常：%v", rec)
				s.reportMu.Unlock()
			}
		}()
		outPath, err := report.GenerateDocx(s.ctx, s.m.pg, in, filepath.Join(s.dataDir, "reports"), taskID)
		s.reportMu.Lock()
		if err != nil {
			job.Status = "failed"
			job.Error = err.Error()
			s.reportMu.Unlock()
			return
		}
		job.Status = "done"
		job.path = outPath
		job.Filename = filepath.Base(outPath)
		s.reportMu.Unlock()
		// persist to the reports list (report management page)
		var size int64
		if fi, e := os.Stat(outPath); e == nil {
			size = fi.Size()
		}
		tid, _ := strconv.ParseInt(taskID, 10, 64)
		_, _ = s.m.pg.AddReport(tid, taskDesc, filepath.Base(outPath), outPath, size, in.CompanyName)
	}()
	writeJSON(w, 202, snap)
}

// GET /api/report/status?task= — poll async generation state.
func (s *Server) reportStatus(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeErr(w, 404, "no active task")
		return
	}
	s.reportMu.Lock()
	job := s.reportJobs[t.ID]
	if job == nil {
		s.reportMu.Unlock()
		writeJSON(w, 200, map[string]any{"status": "idle"})
		return
	}
	snap := *job // copy under lock; the goroutine may be mutating *job
	s.reportMu.Unlock()
	writeJSON(w, 200, snap)
}

// GET /api/report/download?task= — stream the finished .docx.
func (s *Server) downloadReport(w http.ResponseWriter, r *http.Request) {
	t := s.m.ResolveTask(r.URL.Query().Get("task"))
	if t == nil {
		writeErr(w, 404, "no active task")
		return
	}
	s.reportMu.Lock()
	job := s.reportJobs[t.ID]
	var status, path, filename string
	if job != nil {
		status, path, filename = job.Status, job.path, job.Filename
	}
	s.reportMu.Unlock()
	if job == nil || status != "done" || path == "" {
		writeErr(w, 404, "报告尚未生成")
		return
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	http.ServeFile(w, r, path)
}

// buildReportInput flattens the task's confirmed findings + global asset counts
// into the report input, with optional query overrides for the cover metadata.
func (s *Server) buildReportInput(t *Task, q map[string][]string) *report.GenInput {
	get := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}
	// Optional named template: preset cover/org metadata + default language.
	var tmpl *db.ReportTemplate
	if tid, _ := strconv.ParseInt(get("template_id"), 10, 64); tid > 0 {
		tmpl, _ = s.m.pg.GetReportTemplate(tid)
	}
	locale := get("locale") // "" | zh-CN | zh-TW | en-US
	if locale == "" && tmpl != nil {
		locale = tmpl.Locale
	}
	// Only reuse the persisted (Chinese) enrichment for zh-CN reports; for zh-TW/
	// en-US we regenerate per-finding so the whole report is in the target language.
	reuseEnrichment := locale == "" || strings.EqualFold(locale, "zh-CN")
	// Optional subset: ?finding_ids=12,15,18 selects specific findings (node IDs).
	idFilter := parseInt64Set(get("finding_ids"))

	nodes, _ := t.Store.ListByKind(db.KindFinding, 500)
	findings := make([]report.FindingInput, 0, len(nodes))
	for _, n := range nodes {
		if idFilter != nil && !idFilter[n.ID] {
			continue
		}
		var p struct {
			VulnClass string `json:"vulnclass"`
			Severity  string `json:"severity"`
			Summary   string `json:"summary"`
			Evidence  struct {
				PoC string `json:"poc"`
			} `json:"evidence"`
			Reproduction json.RawMessage `json:"reproduction"` // 就地记录的结构化复现过程(可空)
		}
		_ = json.Unmarshal(n.Payload, &p)
		fi := report.FindingInput{
			VulnClass: p.VulnClass, Severity: p.Severity, Summary: p.Summary,
			PoC: p.Evidence.PoC, CreatedAt: n.CreatedAt,
			Reproduction: p.Reproduction, // authoritative test_process — rendered verbatim, AI skips rebuild
		}
		// Reuse persisted enrichment (from the findings page "AI 分析") so the report
		// is consistent with what the user reviewed and skips a redundant LLM call.
		if enr, _ := s.m.pg.GetFindingEnrichment(n.ID); enr != nil {
			if reuseEnrichment {
				fi.Enrichment = reportEnrichmentFromDB(enr)
			}
			if strings.TrimSpace(enr.Severity) != "" {
				fi.Severity = enr.Severity // honor human severity override (language-agnostic)
			}
		}
		// No persisted enrichment to reuse (fresh finding, or zh-TW/en-US
		// regeneration) → ground the on-the-fly narrative in the real work
		// transcript, same as the findings-page "AI 分析".
		if fi.Enrichment == nil {
			fi.Transcript = s.m.pg.FindingSourceTranscript(n.ID, 40000)
		}
		findings = append(findings, fi)
	}
	counts := map[string]int{}
	if a := s.m.Assets(); a != nil {
		if c, err := a.CountsByType(); err == nil {
			counts = c
		}
	}
	// 项目名(封面/标题)用【短任务名】，绝不用整段描述——否则用户把目标系统清单写进
	// 描述时会被灌进封面"项目名称"、撑爆封面。完整描述另经 Scope 喂 AI。
	project := defaultStrSrv(t.Name, "渗透测试项目")
	if len([]rune(project)) > 40 { // 名称异常长(误填清单)→ 回退,别撑爆封面
		project = "渗透测试项目"
	}

	// Resolve org-level cover metadata. Precedence: explicit query param >
	// selected template > singleton report settings > built-in default.
	rs, _ := s.m.pg.GetReportSettings()
	var personnel []report.PersonInput
	companyName, companyEn, cvss, logoRel := "", "", "3.1", ""
	if rs != nil {
		_ = json.Unmarshal(rs.Personnel, &personnel)
		companyName, companyEn = rs.CompanyName, rs.CompanyNameEn
		cvss = defaultStrSrv(rs.CVSSVersion, "3.1")
		logoRel = rs.LogoPath
	}
	if tmpl != nil {
		if strings.TrimSpace(tmpl.CompanyName) != "" {
			companyName = tmpl.CompanyName
		}
		if strings.TrimSpace(tmpl.CompanyNameEn) != "" {
			companyEn = tmpl.CompanyNameEn
		}
		cvss = defaultStrSrv(tmpl.CVSSVersion, cvss)
		if strings.TrimSpace(tmpl.LogoPath) != "" {
			logoRel = tmpl.LogoPath
		}
		var tp []report.PersonInput
		if json.Unmarshal(tmpl.Personnel, &tp) == nil && len(tp) > 0 {
			personnel = tp
		}
	}
	logoPath := ""
	if strings.TrimSpace(logoRel) != "" {
		logoPath = filepath.Join(s.dataDir, logoRel) // stored relative → absolute for python
	}
	return &report.GenInput{
		CompanyName:   defaultStrSrv(get("company"), companyName),
		CompanyNameEn: companyEn,
		ClientName:    get("client"),
		ProjectName:   defaultStrSrv(get("project"), project),
		Scope:         strings.TrimSpace(t.Description), // 完整目标系统清单/范围→喂 AI 叙述,不上封面

		ReportTitle:   get("title"), // empty → BuildDoc applies locale-aware "<project> <报告词>"
		Version:       defaultStrSrv(get("version"), "V1.0"),
		Locale:        defaultStrSrv(locale, "zh-CN"),
		CVSSVersion:   cvss,
		LogoPath:      logoPath,
		Personnel:     personnel,
		Findings:      findings,
		AssetCounts:   counts,
		SkillDir:      s.skillDir,
		DataDir:       s.dataDir, // 用于客户报告脱敏内部 scratch 路径
	}
}

func defaultStrSrv(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return v
}

// parseInt64Set parses "12,15,18" into a set. Returns nil when empty so callers
// treat "no filter" as "all findings".
func parseInt64Set(csv string) map[int64]bool {
	csv = strings.TrimSpace(csv)
	if csv == "" {
		return nil
	}
	set := map[int64]bool{}
	for _, p := range strings.Split(csv, ",") {
		if id, err := strconv.ParseInt(strings.TrimSpace(p), 10, 64); err == nil {
			set[id] = true
		}
	}
	if len(set) == 0 {
		return nil
	}
	return set
}
