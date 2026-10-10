package report

// JSON schema shared with pybuilder/report_builder.py. Field tags MUST match
// the keys the Python builder reads.

type reportDoc struct {
	Meta             docMeta           `json:"meta"`
	Personnel        []person          `json:"personnel"`
	MethodologyIntro string            `json:"methodology_intro"`
	Methodology      []nameDesc        `json:"methodology"`
	Checklist        []checkRow        `json:"checklist"`
	Tools            []nameDesc        `json:"tools"`
	Standards        []string          `json:"standards"`
	Summary          summarySection    `json:"summary"`
	FindingsIntro    string            `json:"findings_intro"`
	VulnList         []vulnListRow     `json:"vuln_list"`
	SystemsDetail    []systemDetail    `json:"systems_detail"`
	OverallConcl     string            `json:"overall_conclusion"`
}

type docMeta struct {
	CompanyName string `json:"company_name"`
	ClientName  string `json:"client_name"`
	ProjectName string `json:"project_name"`
	ReportTitle string `json:"report_title"`
	Version     string `json:"version"`
	Date        string `json:"date"`
	LogoPath    string `json:"logo_path,omitempty"`
	Locale      string `json:"locale"`
	CVSSVersion string `json:"cvss_version"`
}

type person struct {
	Name    string `json:"name"`
	Role    string `json:"role"`
	Contact string `json:"contact"`
}

type nameDesc struct {
	Name string `json:"name"`
	Desc string `json:"desc"`
}

type checkRow struct {
	Category string `json:"category"`
	Name     string `json:"name"`
	Desc     string `json:"desc"`
	Result   string `json:"result"` // 通过 | 不通过
}

type summarySection struct {
	Background            []string      `json:"background"`
	ServiceResult         string        `json:"service_result"`
	Systems               []sysRow      `json:"systems"`
	RemediationConclusion string        `json:"remediation_conclusion"`
	RemediationItems      []remedyRow   `json:"remediation_items"`
}

type sysRow struct {
	Name    string `json:"name"`
	Address string `json:"address"`
	Crit    int    `json:"crit"`
	High    int    `json:"high"`
	Med     int    `json:"med"`
	Low     int    `json:"low"`
	Rating  string `json:"rating"`
}

type remedyRow struct {
	Idx        int    `json:"idx"`
	Object     string `json:"object"`
	Conclusion string `json:"conclusion"`
	Remark     string `json:"remark"`
}

type vulnListRow struct {
	Severity string `json:"severity"`
	Name     string `json:"name"`
	Desc     string `json:"desc"`
	Status   string `json:"status"`
}

type systemDetail struct {
	Name  string       `json:"name"`
	Vulns []vulnDetail `json:"vulns"`
}

type vulnDetail struct {
	SecNo        string            `json:"sec_no"`
	Title        string            `json:"title"`
	Severity     string            `json:"severity"`
	CVSSScore    float64           `json:"cvss_score,omitempty"`
	CVSSVector   string            `json:"cvss_vector,omitempty"`
	CVSSMetrics  map[string]string `json:"cvss_metrics,omitempty"`
	Target       string            `json:"target"`
	FoundDate    string            `json:"found_date"`
	Module       string            `json:"module"`
	URL          string            `json:"url"`
	Description  []string          `json:"description"`
	TestProcess  []procBlock       `json:"test_process"`
	RiskAnalysis []string          `json:"risk_analysis"`
	Remediation  []string          `json:"remediation"`
	FixStatus    string            `json:"fix_status"`
}

type procBlock struct {
	Type    string `json:"type"` // text | code | image
	Content string `json:"content,omitempty"`
	Path    string `json:"path,omitempty"`
	Caption string `json:"caption,omitempty"`
}
