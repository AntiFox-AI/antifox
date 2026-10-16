package server

import (
	"net/http"
	"strconv"
	"strings"

	"antifox/db"
)

// 审计日志 API（/api/audit/logs）。完整审计中心后续增强。

// GET /api/audit/logs?category=&actor=&action=&result=&limit=&offset=
func (s *Server) auditLogs(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	q := r.URL.Query()
	category := strings.TrimSpace(q.Get("category"))
	actor := strings.TrimSpace(q.Get("actor"))
	action := strings.TrimSpace(q.Get("action"))
	result := strings.TrimSpace(q.Get("result"))
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))
	logs, total, err := pg.ListAuditLogs(category, actor, action, result, limit, offset)
	if err != nil {
		writeErr(w, 500, "获取审计日志失败")
		return
	}
	if logs == nil {
		logs = []db.AuditLog{}
	}
	writeJSON(w, 200, map[string]any{"logs": logs, "total": total})
}

// auditActor 从当前请求取操作者用户名（审计记录用）。
func auditActor(r *http.Request) string {
	if acc := CurrentAccess(r); acc != nil {
		return acc.User.Username
	}
	return ""
}
