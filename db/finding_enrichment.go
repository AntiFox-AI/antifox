package db

// finding_enrichment: AI-generated / human-edited structured vuln data that
// overlays a raw finding node (keyed by exploration node id). The node payload
// is never mutated — enrichment is a report/management layer. JSONB columns are
// carried as json.RawMessage so this package stays agnostic of the report types.

import (
	"database/sql"
	"encoding/json"
	"time"
)

type FindingEnrichment struct {
	NodeID       int64           `json:"node_id"`
	Name         string          `json:"name"`
	Target       string          `json:"target"`
	Module       string          `json:"module"`
	Severity     string          `json:"severity"` // human override; empty = use node's
	Status       string          `json:"status"`   // open|confirmed|fixed|false_positive|ignored
	CVSSScore    float64         `json:"cvss_score"`
	CVSSVector   string          `json:"cvss_vector"`
	CVSSMetrics  json.RawMessage `json:"cvss_metrics"`
	Description  json.RawMessage `json:"description"`
	TestProcess  json.RawMessage `json:"test_process"`
	RiskAnalysis json.RawMessage `json:"risk_analysis"`
	Remediation  json.RawMessage `json:"remediation"`
	Source       string          `json:"source"` // ai | manual
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

func rawOr(r json.RawMessage, def string) string {
	if len(r) == 0 {
		return def
	}
	return string(r)
}
func strOr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

const feSelect = `SELECT node_id, name, target, module, severity, status, cvss_score, cvss_vector,
	cvss_metrics::text, description::text, test_process::text, risk_analysis::text, remediation::text,
	source, created_at, updated_at FROM finding_enrichment`

func scanFE(sc interface{ Scan(...any) error }) (*FindingEnrichment, error) {
	e := &FindingEnrichment{}
	var cvss, desc, tp, risk, rem string
	if err := sc.Scan(&e.NodeID, &e.Name, &e.Target, &e.Module, &e.Severity, &e.Status,
		&e.CVSSScore, &e.CVSSVector, &cvss, &desc, &tp, &risk, &rem, &e.Source, &e.CreatedAt, &e.UpdatedAt); err != nil {
		return nil, err
	}
	e.CVSSMetrics, e.Description = json.RawMessage(cvss), json.RawMessage(desc)
	e.TestProcess, e.RiskAnalysis, e.Remediation = json.RawMessage(tp), json.RawMessage(risk), json.RawMessage(rem)
	return e, nil
}

// GetFindingEnrichment returns the enrichment for a finding node, or (nil, nil)
// when the finding has not been enriched yet.
func (d *DB) GetFindingEnrichment(nodeID int64) (*FindingEnrichment, error) {
	e, err := scanFE(d.QueryRow(feSelect+" WHERE node_id=$1", nodeID))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return e, err
}

// GetFindingEnrichments loads enrichments for a set of node ids (loop-based; the
// per-task finding set is small). Missing ids are simply absent from the map.
func (d *DB) GetFindingEnrichments(nodeIDs []int64) (map[int64]*FindingEnrichment, error) {
	out := make(map[int64]*FindingEnrichment, len(nodeIDs))
	for _, id := range nodeIDs {
		e, err := d.GetFindingEnrichment(id)
		if err != nil {
			return out, err
		}
		if e != nil {
			out[id] = e
		}
	}
	return out, nil
}

// UpsertFindingEnrichment inserts or replaces the enrichment for a finding node.
func (d *DB) UpsertFindingEnrichment(e *FindingEnrichment) error {
	_, err := d.Exec(`INSERT INTO finding_enrichment
		(node_id, name, target, module, severity, status, cvss_score, cvss_vector,
		 cvss_metrics, description, test_process, risk_analysis, remediation, source, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14, now())
		ON CONFLICT (node_id) DO UPDATE SET name=EXCLUDED.name, target=EXCLUDED.target, module=EXCLUDED.module,
			severity=EXCLUDED.severity, status=EXCLUDED.status, cvss_score=EXCLUDED.cvss_score,
			cvss_vector=EXCLUDED.cvss_vector, cvss_metrics=EXCLUDED.cvss_metrics, description=EXCLUDED.description,
			test_process=EXCLUDED.test_process, risk_analysis=EXCLUDED.risk_analysis, remediation=EXCLUDED.remediation,
			source=EXCLUDED.source, updated_at=now()`,
		e.NodeID, e.Name, e.Target, e.Module, e.Severity, strOr(e.Status, "open"), e.CVSSScore, e.CVSSVector,
		rawOr(e.CVSSMetrics, "{}"), rawOr(e.Description, "[]"), rawOr(e.TestProcess, "[]"),
		rawOr(e.RiskAnalysis, "[]"), rawOr(e.Remediation, "[]"), strOr(e.Source, "ai"))
	return err
}

// UpdateFindingEnrichmentFields patches the human-editable fields + status of an
// existing enrichment (used by the edit endpoint). Blank fields PRESERVE the
// existing value (partial update) so an edit that only changes status doesn't wipe
// the AI-derived name/target. Creates the row if absent.
func (d *DB) UpdateFindingEnrichmentFields(nodeID int64, name, target, severity, status string) error {
	// The ON CONFLICT clause references the raw parameters ($2..$5) — NOT EXCLUDED —
	// so a blank field genuinely preserves the existing value on update, while a
	// fresh insert defaults an empty status to "open". (Binding strOr(status,"open")
	// as EXCLUDED made the status COALESCE dead code, silently resetting a triaged
	// status back to "open" on a status-omitted partial patch.)
	_, err := d.Exec(`INSERT INTO finding_enrichment (node_id, name, target, severity, status, source, updated_at)
		VALUES ($1,$2,$3,$4,COALESCE(NULLIF($5,''),'open'),'manual', now())
		ON CONFLICT (node_id) DO UPDATE SET
			name     = COALESCE(NULLIF($2, ''), finding_enrichment.name),
			target   = COALESCE(NULLIF($3, ''), finding_enrichment.target),
			severity = COALESCE(NULLIF($4, ''), finding_enrichment.severity),
			status   = COALESCE(NULLIF($5, ''), finding_enrichment.status),
			source='manual', updated_at=now()`,
		nodeID, name, target, severity, status)
	return err
}
