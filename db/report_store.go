package db

// Report management: org-level report settings (singleton) + a list of generated
// reports. Settings feed the report pipeline (company / logo / personnel / CVSS)
// so reports are customizable instead of using baked defaults.

import (
	"database/sql"
	"encoding/json"
	"time"
)

type ReportSettings struct {
	CompanyName   string          `json:"company_name"`
	CompanyNameEn string          `json:"company_name_en"`
	LogoPath      string          `json:"logo_path"`
	Personnel     json.RawMessage `json:"personnel"` // [{name,role,contact}]
	CVSSVersion   string          `json:"cvss_version"`
	UpdatedAt     time.Time       `json:"updated_at"`
}

// GetReportSettings returns the singleton row, or a zero-value default if unset.
func (d *DB) GetReportSettings() (*ReportSettings, error) {
	rs := &ReportSettings{CVSSVersion: "3.1", Personnel: json.RawMessage("[]")}
	var pj string
	err := d.QueryRow(`SELECT company_name, company_name_en, logo_path, personnel_json::text, cvss_version, updated_at
		FROM report_settings WHERE id=1`).
		Scan(&rs.CompanyName, &rs.CompanyNameEn, &rs.LogoPath, &pj, &rs.CVSSVersion, &rs.UpdatedAt)
	if err == sql.ErrNoRows {
		return rs, nil
	}
	if err != nil {
		return rs, err
	}
	rs.Personnel = json.RawMessage(pj)
	return rs, nil
}

// SaveReportSettings upserts the singleton. personnel must be a JSON array.
func (d *DB) SaveReportSettings(rs *ReportSettings) error {
	pj := "[]"
	if len(rs.Personnel) > 0 {
		pj = string(rs.Personnel)
	}
	cv := rs.CVSSVersion
	if cv == "" {
		cv = "3.1"
	}
	_, err := d.Exec(`INSERT INTO report_settings (id, company_name, company_name_en, logo_path, personnel_json, cvss_version, updated_at)
		VALUES (1, $1, $2, $3, $4::jsonb, $5, now())
		ON CONFLICT (id) DO UPDATE SET company_name=EXCLUDED.company_name, company_name_en=EXCLUDED.company_name_en,
			logo_path=EXCLUDED.logo_path, personnel_json=EXCLUDED.personnel_json, cvss_version=EXCLUDED.cvss_version, updated_at=now()`,
		rs.CompanyName, rs.CompanyNameEn, rs.LogoPath, pj, cv)
	return err
}

// SetReportLogo updates just the org-default logo path.
func (d *DB) SetReportLogo(path string) error {
	_, err := d.Exec(`INSERT INTO report_settings (id, logo_path, updated_at) VALUES (1, $1, now())
		ON CONFLICT (id) DO UPDATE SET logo_path=EXCLUDED.logo_path, updated_at=now()`, path)
	return err
}

type Report struct {
	ID        int64     `json:"id"`
	TaskID    *int64    `json:"task_id,omitempty"`
	TaskDesc  string    `json:"task_desc"`
	Filename  string    `json:"filename"`
	Path      string    `json:"-"`
	Size      int64     `json:"size"`
	Company   string    `json:"company"`
	CreatedAt time.Time `json:"created_at"`
}

// AddReport records a generated report. taskID 0 → NULL.
func (d *DB) AddReport(taskID int64, taskDesc, filename, path string, size int64, company string) (int64, error) {
	var tid *int64
	if taskID > 0 {
		tid = &taskID
	}
	var id int64
	err := d.QueryRow(`INSERT INTO reports (task_id, task_desc, filename, path, size, company)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, tid, taskDesc, filename, path, size, company).Scan(&id)
	return id, err
}

// ListReports returns generated reports, newest first.
func (d *DB) ListReports(limit int) ([]*Report, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := d.Query(`SELECT id, task_id, task_desc, filename, path, size, company, created_at
		FROM reports ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Report{}
	for rows.Next() {
		r := &Report{}
		if err := rows.Scan(&r.ID, &r.TaskID, &r.TaskDesc, &r.Filename, &r.Path, &r.Size, &r.Company, &r.CreatedAt); err != nil {
			return out, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetReport returns one report record by id (for download).
func (d *DB) GetReport(id int64) (*Report, error) {
	r := &Report{}
	err := d.QueryRow(`SELECT id, task_id, task_desc, filename, path, size, company, created_at FROM reports WHERE id=$1`, id).
		Scan(&r.ID, &r.TaskID, &r.TaskDesc, &r.Filename, &r.Path, &r.Size, &r.Company, &r.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return r, err
}

// DeleteReport removes a report record by id. The .docx file on disk is deleted
// by the caller (it holds the dataDir to resolve the portable path).
func (d *DB) DeleteReport(id int64) error {
	_, err := d.Exec(`DELETE FROM reports WHERE id=$1`, id)
	return err
}

// ---- named report templates (reusable cover/org presets) ----

type ReportTemplate struct {
	ID            int64           `json:"id"`
	Name          string          `json:"name"`
	CompanyName   string          `json:"company_name"`
	CompanyNameEn string          `json:"company_name_en"`
	LogoPath      string          `json:"logo_path"`
	Personnel     json.RawMessage `json:"personnel"` // [{name,role,contact}]
	CVSSVersion   string          `json:"cvss_version"`
	Locale        string          `json:"locale"`
	CreatedAt     time.Time       `json:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
}

func scanReportTemplate(sc interface{ Scan(...any) error }) (*ReportTemplate, error) {
	rt := &ReportTemplate{}
	var pj string
	if err := sc.Scan(&rt.ID, &rt.Name, &rt.CompanyName, &rt.CompanyNameEn, &rt.LogoPath, &pj,
		&rt.CVSSVersion, &rt.Locale, &rt.CreatedAt, &rt.UpdatedAt); err != nil {
		return nil, err
	}
	rt.Personnel = json.RawMessage(pj)
	return rt, nil
}

const reportTemplateCols = `id, name, company_name, company_name_en, logo_path, personnel_json::text, cvss_version, locale, created_at, updated_at`

// ListReportTemplates returns all templates, newest first.
func (d *DB) ListReportTemplates() ([]*ReportTemplate, error) {
	rows, err := d.Query(`SELECT ` + reportTemplateCols + ` FROM report_templates ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*ReportTemplate{}
	for rows.Next() {
		rt, err := scanReportTemplate(rows)
		if err != nil {
			return out, err
		}
		out = append(out, rt)
	}
	return out, rows.Err()
}

// GetReportTemplate returns one template by id (nil when not found).
func (d *DB) GetReportTemplate(id int64) (*ReportTemplate, error) {
	rt, err := scanReportTemplate(d.QueryRow(`SELECT `+reportTemplateCols+` FROM report_templates WHERE id=$1`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return rt, err
}

func personnelJSON(p json.RawMessage) string {
	if len(p) == 0 {
		return "[]"
	}
	return string(p)
}

// AddReportTemplate inserts a template and returns its id.
func (d *DB) AddReportTemplate(rt *ReportTemplate) (int64, error) {
	var id int64
	err := d.QueryRow(`INSERT INTO report_templates (name, company_name, company_name_en, logo_path, personnel_json, cvss_version, locale)
		VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id`,
		rt.Name, rt.CompanyName, rt.CompanyNameEn, rt.LogoPath, personnelJSON(rt.Personnel),
		defStr(rt.CVSSVersion, "3.1"), defStr(rt.Locale, "zh-CN")).Scan(&id)
	return id, err
}

// UpdateReportTemplate overwrites an existing template.
func (d *DB) UpdateReportTemplate(rt *ReportTemplate) error {
	_, err := d.Exec(`UPDATE report_templates SET name=$1, company_name=$2, company_name_en=$3, logo_path=$4,
		personnel_json=$5::jsonb, cvss_version=$6, locale=$7, updated_at=now() WHERE id=$8`,
		rt.Name, rt.CompanyName, rt.CompanyNameEn, rt.LogoPath, personnelJSON(rt.Personnel),
		defStr(rt.CVSSVersion, "3.1"), defStr(rt.Locale, "zh-CN"), rt.ID)
	return err
}

// DeleteReportTemplate removes a template by id.
func (d *DB) DeleteReportTemplate(id int64) error {
	_, err := d.Exec(`DELETE FROM report_templates WHERE id=$1`, id)
	return err
}

func defStr(v, d string) string {
	if v == "" {
		return d
	}
	return v
}
