package server

import (
	"net/http"
	"strconv"
	"strings"

	"antifox/db"
)

// 审计日志 API（/api/audit/logs）。完整审计中心后续增强。

// GET /api/audit/logs?category=&actor=&limit=&offset=
func (s *Server) auditLogs(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	category := strings.TrimSpace(r.URL.Query().Get("category"))
	actor := strings.TrimSpace(r.URL.Query().Get("actor"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	logs, total, err := pg.ListAuditLogs(category, actor, limit, offset)
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
