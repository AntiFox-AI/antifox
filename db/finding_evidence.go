package db

import (
	"strconv"
	"strings"
	"time"
)

// 漏洞证据截图数据层。文件本体存 dataDir/report_assets/evidence/<node_id>/，本表只存元数据。
// 以 exploration 节点 id 为规范键，与 finding_enrichment 对齐；发现页 / 报告 / MD 共用。

type FindingEvidence struct {
	ID        int64     `json:"id"`
	NodeID    int64     `json:"node_id"`
	Filename  string    `json:"filename"`
	Caption   string    `json:"caption"`
	StepIndex int       `json:"step_index"`
	SortOrder int       `json:"sort_order"`
	CreatedAt time.Time `json:"created_at"`
}

// CreateFindingEvidence 新增一条证据记录（文件已落盘），sort_order 自动取当前最大+1。
func (d *DB) CreateFindingEvidence(nodeID int64, filename, caption string, stepIndex int) (*FindingEvidence, error) {
	var next int
	_ = d.QueryRow(`SELECT COALESCE(MAX(sort_order),0)+1 FROM finding_evidence WHERE node_id=$1`, nodeID).Scan(&next)
	var e FindingEvidence
	err := d.QueryRow(`
INSERT INTO finding_evidence(node_id, filename, caption, step_index, sort_order)
VALUES ($1,$2,$3,$4,$5)
RETURNING id, node_id, filename, caption, step_index, sort_order, created_at`,
		nodeID, filename, strings.TrimSpace(caption), stepIndex, next).
		Scan(&e.ID, &e.NodeID, &e.Filename, &e.Caption, &e.StepIndex, &e.SortOrder, &e.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// ListFindingEvidence 按展示顺序列出某漏洞的全部证据。
func (d *DB) ListFindingEvidence(nodeID int64) ([]FindingEvidence, error) {
	rows, err := d.Query(`
SELECT id, node_id, filename, caption, step_index, sort_order, created_at
FROM finding_evidence WHERE node_id=$1 ORDER BY step_index, sort_order, id`, nodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FindingEvidence
	for rows.Next() {
		var e FindingEvidence
		if err := rows.Scan(&e.ID, &e.NodeID, &e.Filename, &e.Caption, &e.StepIndex, &e.SortOrder, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// CountFindingEvidence 批量统计一组漏洞各自的证据截图数量（供发现页列表显示"证据 N 张"）。
// node id 为 int64、直接内联拼 IN，无注入风险。
func (d *DB) CountFindingEvidence(nodeIDs []int64) map[int64]int {
	out := map[int64]int{}
	if len(nodeIDs) == 0 {
		return out
	}
	// 全参数化（$1,$2,…）：即使 node id 是 int64 本就无注入风险，也用占位符，杜绝任何拼接 SQL。
	parts := make([]string, len(nodeIDs))
	args := make([]any, len(nodeIDs))
	for i, id := range nodeIDs {
		parts[i] = "$" + strconv.Itoa(i+1)
		args[i] = id
	}
	rows, err := d.Query(`SELECT node_id, count(*) FROM finding_evidence WHERE node_id IN (`+strings.Join(parts, ",")+`) GROUP BY node_id`, args...)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var n int64
		var c int
		if rows.Scan(&n, &c) == nil {
			out[n] = c
		}
	}
	return out
}

// GetFindingEvidence 取单条（删除时需要文件名 + 校验 node 归属）。
func (d *DB) GetFindingEvidence(id int64) (*FindingEvidence, error) {
	var e FindingEvidence
	err := d.QueryRow(`
SELECT id, node_id, filename, caption, step_index, sort_order, created_at
FROM finding_evidence WHERE id=$1`, id).
		Scan(&e.ID, &e.NodeID, &e.Filename, &e.Caption, &e.StepIndex, &e.SortOrder, &e.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// UpdateFindingEvidence 改图注 / 对应步骤 / 排序。
func (d *DB) UpdateFindingEvidence(id int64, caption string, stepIndex, sortOrder int) error {
	_, err := d.Exec(`UPDATE finding_evidence SET caption=$1, step_index=$2, sort_order=$3 WHERE id=$4`,
		strings.TrimSpace(caption), stepIndex, sortOrder, id)
	return err
}

// DeleteFindingEvidence 删一条记录（调用方据返回的文件名删盘文件）。
func (d *DB) DeleteFindingEvidence(id int64) error {
	_, err := d.Exec(`DELETE FROM finding_evidence WHERE id=$1`, id)
	return err
}
