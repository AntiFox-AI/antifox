package db

import (
	"encoding/json"
	"strconv"
	"time"
)

// 审计日志数据层（登录/平台操作审计；后续可扩展为完整审计中心）。

type AuditLog struct {
	ID        int64          `json:"id"`
	CreatedAt time.Time      `json:"created_at"`
	Actor     string         `json:"actor"`
	Category  string         `json:"category"`
	Action    string         `json:"action"`
	Result    string         `json:"result"`
	IP        string         `json:"ip"`
	Message   string         `json:"message"`
	Detail    map[string]any `json:"detail"`
}

// RecordAudit 写一条审计日志（best-effort，出错只吞不影响主流程）。
func (d *DB) RecordAudit(actor, category, action, result, ip, message string, detail map[string]any) {
	if result == "" {
		result = "success"
	}
	var dj []byte
	if detail != nil {
		dj, _ = json.Marshal(detail)
	} else {
		dj = []byte("{}")
	}
	_, _ = d.Exec(`INSERT INTO audit_logs(actor,category,action,result,ip,message,detail)
		VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, actor, category, action, result, ip, message, string(dj))
}

// ListAuditLogs 分页倒序列出审计日志（可按 category/actor/action/result 过滤）。
func (d *DB) ListAuditLogs(category, actor, action, result string, limit, offset int) ([]AuditLog, int, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	where := "WHERE 1=1"
	args := []any{}
	if category != "" {
		args = append(args, category)
		where += " AND category=$" + strconv.Itoa(len(args))
	}
	if actor != "" {
		args = append(args, actor)
		where += " AND actor=$" + strconv.Itoa(len(args))
	}
	if action != "" {
		args = append(args, action)
		where += " AND action=$" + strconv.Itoa(len(args))
	}
	if result != "" {
		args = append(args, result)
		where += " AND result=$" + strconv.Itoa(len(args))
	}
	var total int
	if err := d.QueryRow(`SELECT COUNT(*) FROM audit_logs `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args = append(args, limit, offset)
	rows, err := d.Query(`SELECT id,created_at,actor,category,action,result,ip,message,detail FROM audit_logs `+
		where+` ORDER BY id DESC LIMIT $`+strconv.Itoa(len(args)-1)+` OFFSET $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []AuditLog
	for rows.Next() {
		var a AuditLog
		var detailRaw []byte
		if err := rows.Scan(&a.ID, &a.CreatedAt, &a.Actor, &a.Category, &a.Action, &a.Result, &a.IP, &a.Message, &detailRaw); err != nil {
			return nil, 0, err
		}
		if len(detailRaw) > 0 {
			_ = json.Unmarshal(detailRaw, &a.Detail)
		}
		out = append(out, a)
	}
	return out, total, rows.Err()
}
