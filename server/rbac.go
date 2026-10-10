package server

import (
	"net/http"
	"sort"
	"strings"

	"antifox/db"
	"golang.org/x/crypto/bcrypt"
)

// 平台权限管理 API（/api/rbac/*）。

type rbacUserView struct {
	db.RBACUser
	RoleIDs []string `json:"role_ids"`
}

type rbacRoleView struct {
	db.RBACRole
	Permissions []string `json:"permissions"`
}

// GET /api/rbac/me —— 当前登录用户的身份 + 角色 + 权限。
func (s *Server) rbacMe(w http.ResponseWriter, r *http.Request) {
	acc := CurrentAccess(r)
	if acc == nil {
		writeErr(w, 401, "会话无效")
		return
	}
	perms := make([]string, 0, len(acc.Permissions))
	for k, v := range acc.Permissions {
		if v {
			perms = append(perms, k)
		}
	}
	sort.Strings(perms)
	writeJSON(w, 200, map[string]any{
		"user":        acc.User,
		"roles":       acc.Roles,
		"permissions": perms,
		"scope":       acc.Scope,
	})
}

// GET /api/rbac/metadata —— 权限目录 + 角色（管理 UI 用）。
func (s *Server) rbacMetadata(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	roles, err := pg.ListRBACRoles()
	if err != nil {
		writeErr(w, 500, "获取角色失败")
		return
	}
	writeJSON(w, 200, map[string]any{
		"permissions": db.RBACPermissions,
		"roles":       roles,
		"scopes":      []string{db.RBACScopeAll, db.RBACScopeAssigned, db.RBACScopeOwn},
	})
}

// GET /api/rbac/users
func (s *Server) rbacListUsers(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	users, err := pg.ListRBACUsers()
	if err != nil {
		writeErr(w, 500, "获取用户失败")
		return
	}
	out := make([]rbacUserView, 0, len(users))
	for _, u := range users {
		ids, _ := pg.ListRBACUserRoleIDs(u.ID)
		if ids == nil {
			ids = []string{}
		}
		out = append(out, rbacUserView{RBACUser: u, RoleIDs: ids})
	}
	writeJSON(w, 200, map[string]any{"users": out})
}

// POST /api/rbac/users
func (s *Server) rbacCreateUser(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	var req struct {
		Username    string   `json:"username"`
		DisplayName string   `json:"display_name"`
		Password    string   `json:"password"`
		Enabled     *bool    `json:"enabled"`
		RoleIDs     []string `json:"role_ids"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, 400, "参数无效")
		return
	}
	username := strings.TrimSpace(strings.ToLower(req.Username))
	if username == "" || len(req.Password) < 8 {
		writeErr(w, 400, "用户名必填，密码至少 8 位")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, 500, "密码处理失败")
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	u, err := pg.CreateRBACUser(username, req.DisplayName, string(hash), enabled, req.RoleIDs)
	if err != nil {
		msg := "创建用户失败"
		if strings.Contains(strings.ToLower(err.Error()), "unique") || strings.Contains(err.Error(), "duplicate") {
			msg = "用户名已存在"
		}
		writeErr(w, 400, msg)
		return
	}
	pg.RecordAudit(auditActor(r), "rbac", "create_user", "success", clientIP(r), "创建用户 "+username, map[string]any{"user_id": u.ID})
	writeJSON(w, 200, map[string]any{"user": u})
}

// PUT /api/rbac/users/{id}
func (s *Server) rbacUpdateUser(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeErr(w, 400, "缺少用户 ID")
		return
	}
	var req struct {
		DisplayName string    `json:"display_name"`
		Enabled     *bool     `json:"enabled"`
		RoleIDs     *[]string `json:"role_ids"`
		Password    string    `json:"password"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, 400, "参数无效")
		return
	}
	if err := pg.UpdateRBACUser(id, req.DisplayName, req.Enabled, req.RoleIDs); err != nil {
		writeErr(w, 500, "更新用户失败")
		return
	}
	if pw := strings.TrimSpace(req.Password); pw != "" {
		if len(pw) < 8 {
			writeErr(w, 400, "密码至少 8 位")
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
		if err != nil {
			writeErr(w, 500, "密码处理失败")
			return
		}
		if err := pg.UpdateRBACUserPassword(id, string(hash)); err != nil {
			writeErr(w, 500, "重置密码失败")
			return
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// DELETE /api/rbac/users/{id}
func (s *Server) rbacDeleteUser(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if err := pg.DeleteRBACUser(id); err != nil {
		writeErr(w, 400, "删除失败: "+err.Error())
		return
	}
	pg.RecordAudit(auditActor(r), "rbac", "delete_user", "success", clientIP(r), "删除用户 "+id, nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// GET /api/rbac/roles
func (s *Server) rbacListRoles(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	roles, err := pg.ListRBACRoles()
	if err != nil {
		writeErr(w, 500, "获取角色失败")
		return
	}
	out := make([]rbacRoleView, 0, len(roles))
	for _, r := range roles {
		keys, _ := pg.ListRBACRolePermissionKeys(r.ID)
		if keys == nil {
			keys = []string{}
		}
		out = append(out, rbacRoleView{RBACRole: r, Permissions: keys})
	}
	writeJSON(w, 200, map[string]any{"roles": out})
}

type roleReq struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Scope       string   `json:"scope"`
	Permissions []string `json:"permissions"`
}

// POST /api/rbac/roles
func (s *Server) rbacCreateRole(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	var req roleReq
	if err := decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		writeErr(w, 400, "角色名不能为空")
		return
	}
	role, err := pg.UpsertRBACRole("", req.Name, req.Description, req.Scope, req.Permissions)
	if err != nil {
		writeErr(w, 400, "创建角色失败: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"role": role})
}

// PUT /api/rbac/roles/{id}
func (s *Server) rbacUpdateRole(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	var req roleReq
	if err := decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		writeErr(w, 400, "角色名不能为空")
		return
	}
	role, err := pg.UpsertRBACRole(id, req.Name, req.Description, req.Scope, req.Permissions)
	if err != nil {
		writeErr(w, 400, "更新角色失败: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"role": role})
}

// DELETE /api/rbac/roles/{id}
func (s *Server) rbacDeleteRole(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if err := pg.DeleteRBACRole(id); err != nil {
		writeErr(w, 400, "删除角色失败: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
