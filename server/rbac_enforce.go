package server

import (
	"net/http"
	"strings"

	"antifox/db"
)

// RBAC 权限强制拦截：路由 → 所需权限映射。
// 安全阀：未映射路由放行（不打成 403，避免遗漏破坏平台）；admin 拥有全部权限永不被拦。
// 开关：settings 键 rbac.enforce（默认 true）。

// isAdmin 报告当前请求是否由内置 admin 角色发起。用于额外收紧「能在宿主机执行命令」
// 这类高危操作（stdio MCP、command/script/shell 自定义工具）——这些等价于主机命令执行，
// 只应由 admin 使用，不随 tool:write / mcp:write 下放给 operator。无授权画像时按非 admin
// 处理（fail-closed）。
func isAdmin(r *http.Request) bool {
	acc := CurrentAccess(r)
	if acc == nil {
		return false
	}
	for _, role := range acc.Roles {
		if role.ID == db.RBACRoleAdmin {
			return true
		}
	}
	return false
}

// hostExecToolKind 报告某自定义工具类型是否会在宿主机上执行命令/脚本。
func hostExecToolKind(kind string) bool {
	switch kind {
	case "command", "script", "shell":
		return true
	}
	return false
}

// crudPerm 按 HTTP 方法给出 read/write/delete 权限。
func crudPerm(method, module string) string {
	switch method {
	case http.MethodGet, http.MethodHead:
		return module + ":read"
	case http.MethodDelete:
		// Some modules have no ":delete" permission in the catalog (llm/agent/mcp/
		// tool/intercept) — for those, delete is gated by ":write". Without this
		// fallback even admin (whose perm set == the catalog) hits a nonexistent
		// "<module>:delete" and gets 403 on every delete.
		if p := module + ":delete"; db.RBACPermissions[p] != "" {
			return p
		}
		return module + ":write"
	default:
		return module + ":write"
	}
}

// permissionForRequest 返回该请求所需权限；返回 "" 表示未映射（放行）。
func permissionForRequest(method, fullPath string) string {
	p := strings.TrimPrefix(fullPath, "/api")
	switch {
	case p == "/rbac/me":
		return "auth:self"
	case strings.HasPrefix(p, "/rbac"):
		if method == http.MethodGet {
			return "rbac:read"
		}
		return "rbac:write"
	case strings.HasPrefix(p, "/audit"):
		return "log:read"
	case strings.HasPrefix(p, "/logs"):
		return "log:read"
	case p == "/stats" || strings.HasPrefix(p, "/tokens"):
		return "dashboard:read"
	case strings.HasPrefix(p, "/tasks"), p == "/active", strings.HasPrefix(p, "/exploration"),
		strings.HasPrefix(p, "/chat"), strings.HasPrefix(p, "/conversations"):
		return crudPerm(method, "task")
	case strings.HasPrefix(p, "/findings"):
		return crudPerm(method, "finding")
	case strings.HasPrefix(p, "/traffic"):
		return "traffic:read"
	case strings.HasPrefix(p, "/assets"), strings.HasPrefix(p, "/companies"), strings.HasPrefix(p, "/sync"):
		return crudPerm(method, "asset")
	case strings.HasPrefix(p, "/llm"):
		return crudPerm(method, "llm")
	case strings.HasPrefix(p, "/agents"), strings.HasPrefix(p, "/triggers"), strings.HasPrefix(p, "/visibility"):
		return crudPerm(method, "agent")
	case strings.HasPrefix(p, "/mcp"):
		return crudPerm(method, "mcp")
	case strings.HasPrefix(p, "/skills"):
		return crudPerm(method, "skill")
	case strings.HasPrefix(p, "/tools"):
		return crudPerm(method, "tool")
	case strings.HasPrefix(p, "/intercept"):
		return crudPerm(method, "intercept")
	case strings.HasPrefix(p, "/knowledge"):
		// search/categories/logs are read actions even though search is POST.
		if p == "/knowledge/search" || p == "/knowledge/categories" || p == "/knowledge/logs" {
			return "knowledge:read"
		}
		return crudPerm(method, "knowledge")
	case strings.HasPrefix(p, "/settings"):
		return crudPerm(method, "config")
	case strings.HasPrefix(p, "/update"):
		// 一键更新归在系统配置下：检查/进度 = config:read；apply/rollback(POST) = config:write
		// （config:write 仅给 admin，故高危的下载换装/回滚只有 admin 能触发）。
		return crudPerm(method, "config")
	case strings.HasPrefix(p, "/report"):
		// 覆盖 /report, /reports, /report/generate, /report-settings,
		// /report-templates, /report-assets（均以 /report 开头）。
		// GET=read(查看/下载/状态)，POST/PUT=write(生成报告/管理模版设置)，
		// DELETE=delete(删报告/模版)。report 模块 read/write/delete 齐全。
		return crudPerm(method, "report")
	default:
		return "" // 未映射 → 放行
	}
}
