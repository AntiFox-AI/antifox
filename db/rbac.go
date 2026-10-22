package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// 多用户 RBAC 数据层（AntiFox 平台权限，基于 PostgreSQL + 模块化设计）。

const (
	RBACRoleAdmin    = "admin"
	RBACRoleOperator = "operator"
	RBACRoleAuditor  = "auditor"
	RBACRoleViewer   = "viewer"

	RBACScopeAll      = "all"
	RBACScopeAssigned = "assigned"
	RBACScopeOwn      = "own"
)

// RBACPermissions —— 平台权限目录（module:action），按 AntiFox 实际模块定义。
var RBACPermissions = map[string]string{
	"auth:self":       "管理自己的会话和密码",
	"dashboard:read":  "查看仪表盘总览",
	"task:read":       "查看任务 / 探索链路 / 会话",
	"task:write":      "创建 / 控制任务、发送对话引导",
	"task:delete":     "删除任务",
	"finding:read":    "查看漏洞发现",
	"finding:write":   "创建 / 更新漏洞发现",
	"finding:delete":  "删除漏洞发现",
	"traffic:read":    "查看流量录制",
	"asset:read":      "查看资产 / 公司",
	"asset:write":     "创建 / 导入 / 同步资产",
	"asset:delete":    "删除资产",
	"llm:read":        "查看 LLM 配置",
	"llm:write":       "管理 LLM 配置与模型",
	"agent:read":      "查看 Agent 配置",
	"agent:write":     "管理 Agent / 提示词 / 触发器",
	"mcp:read":        "查看 MCP 服务",
	"mcp:write":       "管理 MCP 服务",
	"skill:read":      "查看技能",
	"skill:write":     "创建 / 更新技能",
	"skill:delete":    "删除技能",
	"tool:read":       "查看工具",
	"tool:write":      "管理工具 / 自定义工具",
	"intercept:read":  "查看拦截规则 / 审批",
	"intercept:write": "管理拦截规则 / 处理审批",
	"log:read":        "查看后端日志 / 审计",
	"config:read":     "查看系统配置",
	"config:write":    "修改系统配置",
	"knowledge:read":   "查看知识库 / 检索",
	"knowledge:write":  "创建 / 更新知识库文档、配置 embedder",
	"knowledge:delete": "删除知识库文档",
	"report:read":      "查看 / 下载报告、模版与报告设置",
	"report:write":     "生成报告、管理模版与报告设置",
	"report:delete":    "删除报告 / 模版",
	"rbac:read":       "查看用户 / 角色 / 权限",
	"rbac:write":      "管理用户 / 角色 / 权限",
}

// RBACUser 平台账号。
type RBACUser struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	DisplayName  string    `json:"display_name"`
	PasswordHash string    `json:"-"`
	Enabled      bool      `json:"enabled"`
	IsBuiltin    bool      `json:"is_builtin"`
	TokenVersion int       `json:"-"` // 改密/停用自增；签 JWT 时写入，校验时比对，不匹配即失效
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// RBACRole 角色（权限集合 + 资源范围）。
type RBACRole struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Scope       string    `json:"scope"`
	IsSystem    bool      `json:"is_system"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// RBACAccess 某用户解析后的授权画像。
type RBACAccess struct {
	User        RBACUser        `json:"user"`
	Roles       []RBACRole      `json:"roles"`
	Permissions map[string]bool `json:"permissions"`
	Scope       string          `json:"scope"`
}

func newRBACID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func mergeScope(a, b string) string {
	if a == RBACScopeAll || b == RBACScopeAll {
		return RBACScopeAll
	}
	if a == RBACScopeAssigned || b == RBACScopeAssigned {
		return RBACScopeAssigned
	}
	return RBACScopeOwn
}

// RBACNeedsBootstrap 报告是否还没有任何平台用户（首启需迁移/建 admin）。
func (d *DB) RBACNeedsBootstrap() (bool, error) {
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM rbac_users`).Scan(&n); err != nil {
		return false, err
	}
	return n == 0, nil
}

// BootstrapRBAC 幂等地播种权限目录 + 4 个系统角色 + 授权；
// 若无用户且传入 adminHash，则用它建内置 admin 账号（从旧单用户密码迁移）。
func (d *DB) BootstrapRBAC(adminHash string) error {
	now := time.Now()
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// 权限目录（upsert desc；清掉过时 key）
	for key, desc := range RBACPermissions {
		if _, err := tx.Exec(`INSERT INTO rbac_permissions(key, description) VALUES ($1,$2)
			ON CONFLICT (key) DO UPDATE SET description=EXCLUDED.description`, key, desc); err != nil {
			return err
		}
	}
	rows, err := tx.Query(`SELECT key FROM rbac_permissions`)
	if err != nil {
		return err
	}
	var stale []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			return err
		}
		if _, ok := RBACPermissions[k]; !ok {
			stale = append(stale, k)
		}
	}
	rows.Close()
	for _, k := range stale {
		tx.Exec(`DELETE FROM rbac_role_permissions WHERE permission_key=$1`, k) //nolint:errcheck
		tx.Exec(`DELETE FROM rbac_permissions WHERE key=$1`, k)                 //nolint:errcheck
	}

	// 系统角色
	sysRoles := []RBACRole{
		{ID: RBACRoleAdmin, Name: "管理员", Description: "全局管理权限", Scope: RBACScopeAll, IsSystem: true},
		{ID: RBACRoleOperator, Name: "操作员", Description: "可执行日常安全工作流，不能管理账号与核心配置", Scope: RBACScopeAssigned, IsSystem: true},
		{ID: RBACRoleAuditor, Name: "审计员", Description: "只读查看审计、监控与资产", Scope: RBACScopeAll, IsSystem: true},
		{ID: RBACRoleViewer, Name: "只读用户", Description: "只读查看被授权资源", Scope: RBACScopeAssigned, IsSystem: true},
	}
	for _, r := range sysRoles {
		if _, err := tx.Exec(`INSERT INTO rbac_roles(id,name,description,scope,is_system,created_at,updated_at)
			VALUES ($1,$2,$3,$4,true,$5,$5)
			ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, scope=EXCLUDED.scope, is_system=true, updated_at=EXCLUDED.updated_at`,
			r.ID, r.Name, r.Description, r.Scope, now); err != nil {
			return err
		}
	}

	// 系统角色授权：确定性重建
	if _, err := tx.Exec(`DELETE FROM rbac_role_permissions WHERE role_id IN ($1,$2,$3,$4)`,
		RBACRoleAdmin, RBACRoleOperator, RBACRoleAuditor, RBACRoleViewer); err != nil {
		return err
	}
	for key := range RBACPermissions {
		// admin：全部
		if _, err := tx.Exec(`INSERT INTO rbac_role_permissions(role_id,permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, RBACRoleAdmin, key); err != nil {
			return err
		}
		isRead := strings.HasSuffix(key, ":read")
		switch {
		case key == "auth:self":
			for _, rid := range []string{RBACRoleOperator, RBACRoleAuditor, RBACRoleViewer} {
				tx.Exec(`INSERT INTO rbac_role_permissions(role_id,permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, rid, key) //nolint:errcheck
			}
		case isRead:
			// 所有 :read 都给 operator/auditor/viewer —— 只读/操作员角色可【查看】全部页面
			// （含报告管理 / 日志·审计 / 系统配置 / 用户管理 / LLM），只是不能操作。
			// （此 case 在下面 rbac/config/llm 之前，故那些模块的 read 也走这里。）
			for _, rid := range []string{RBACRoleOperator, RBACRoleAuditor, RBACRoleViewer} {
				tx.Exec(`INSERT INTO rbac_role_permissions(role_id,permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, rid, key) //nolint:errcheck
			}
		case strings.HasPrefix(key, "rbac:"), strings.HasPrefix(key, "config:"), strings.HasPrefix(key, "llm:"):
			// 平台管理类（rbac/config/llm）的写/删：仅 admin（上面已授），operator 也不得
			// 管理账号 / 核心配置 / LLM。此处 read 已被上面的 isRead 命中，这里只剩写/删 → 不授任何非 admin 角色。
		default:
			// 功能类写/删：给 operator（+ admin）
			tx.Exec(`INSERT INTO rbac_role_permissions(role_id,permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, RBACRoleOperator, key) //nolint:errcheck
		}
	}

	// 首启：无用户则建内置 admin（迁移旧密码）
	var userCount int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM rbac_users`).Scan(&userCount); err != nil {
		return err
	}
	if userCount == 0 && strings.TrimSpace(adminHash) != "" {
		id := "admin"
		if _, err := tx.Exec(`INSERT INTO rbac_users(id,username,display_name,password_hash,enabled,is_builtin,created_at,updated_at)
			VALUES ($1,'admin','管理员',$2,true,true,$3,$3)`, id, adminHash, now); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO rbac_user_roles(user_id,role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, RBACRoleAdmin); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func scanRBACUser(row interface{ Scan(...any) error }) (*RBACUser, error) {
	var u RBACUser
	if err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Enabled, &u.IsBuiltin, &u.TokenVersion, &u.CreatedAt, &u.UpdatedAt); err != nil {
		return nil, err
	}
	return &u, nil
}

const rbacUserCols = `id,username,display_name,password_hash,enabled,is_builtin,token_version,created_at,updated_at`

func (d *DB) GetRBACUserByUsername(username string) (*RBACUser, error) {
	username = strings.TrimSpace(strings.ToLower(username))
	if username == "" {
		return nil, sql.ErrNoRows
	}
	return scanRBACUser(d.QueryRow(`SELECT `+rbacUserCols+` FROM rbac_users WHERE username=$1`, username))
}

func (d *DB) GetRBACUserByID(id string) (*RBACUser, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, sql.ErrNoRows
	}
	return scanRBACUser(d.QueryRow(`SELECT `+rbacUserCols+` FROM rbac_users WHERE id=$1`, id))
}

// ResolveRBACAccess 解析某用户的角色 + 权限 + 综合 scope。
func (d *DB) ResolveRBACAccess(userID string) (*RBACAccess, error) {
	u, err := d.GetRBACUserByID(userID)
	if err != nil {
		return nil, err
	}
	acc := &RBACAccess{User: *u, Permissions: map[string]bool{}, Scope: RBACScopeOwn}
	rows, err := d.Query(`SELECT r.id,r.name,r.description,r.scope,r.is_system,r.created_at,r.updated_at
		FROM rbac_roles r JOIN rbac_user_roles ur ON ur.role_id=r.id WHERE ur.user_id=$1 ORDER BY r.is_system DESC, r.name`, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r RBACRole
		if err := rows.Scan(&r.ID, &r.Name, &r.Description, &r.Scope, &r.IsSystem, &r.CreatedAt, &r.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		acc.Roles = append(acc.Roles, r)
		acc.Scope = mergeScope(acc.Scope, r.Scope)
	}
	rows.Close()
	prows, err := d.Query(`SELECT DISTINCT rp.permission_key FROM rbac_role_permissions rp
		JOIN rbac_user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=$1`, userID)
	if err != nil {
		return nil, err
	}
	defer prows.Close()
	for prows.Next() {
		var k string
		if err := prows.Scan(&k); err != nil {
			return nil, err
		}
		acc.Permissions[k] = true
	}
	return acc, prows.Err()
}

func (d *DB) ListRBACUsers() ([]RBACUser, error) {
	rows, err := d.Query(`SELECT ` + rbacUserCols + ` FROM rbac_users ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RBACUser
	for rows.Next() {
		u, err := scanRBACUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}
	return out, rows.Err()
}

func (d *DB) ListRBACUserRoleIDs(userID string) ([]string, error) {
	rows, err := d.Query(`SELECT role_id FROM rbac_user_roles WHERE user_id=$1 ORDER BY role_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (d *DB) CreateRBACUser(username, displayName, passwordHash string, enabled bool, roleIDs []string) (*RBACUser, error) {
	username = strings.TrimSpace(strings.ToLower(username))
	if username == "" || passwordHash == "" {
		return nil, errors.New("用户名与密码必填")
	}
	id := newRBACID()
	now := time.Now()
	tx, err := d.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO rbac_users(id,username,display_name,password_hash,enabled,is_builtin,created_at,updated_at)
		VALUES ($1,$2,$3,$4,$5,false,$6,$6)`, id, username, strings.TrimSpace(displayName), passwordHash, enabled, now); err != nil {
		return nil, err
	}
	for _, rid := range roleIDs {
		if rid = strings.TrimSpace(rid); rid != "" {
			if _, err := tx.Exec(`INSERT INTO rbac_user_roles(user_id,role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, rid); err != nil {
				return nil, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return d.GetRBACUserByID(id)
}

func (d *DB) UpdateRBACUser(userID, displayName string, enabled *bool, roleIDs *[]string) error {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return errors.New("缺少用户 ID")
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if enabled != nil {
		// 停用账号时 token_version+1，立即作废其已签发 token（不等它自然过期）。
		bump := ""
		if !*enabled {
			bump = ",token_version=token_version+1"
		}
		if _, err := tx.Exec(`UPDATE rbac_users SET display_name=$1,enabled=$2`+bump+`,updated_at=now() WHERE id=$3`, strings.TrimSpace(displayName), *enabled, userID); err != nil {
			return err
		}
	} else {
		if _, err := tx.Exec(`UPDATE rbac_users SET display_name=$1,updated_at=now() WHERE id=$2`, strings.TrimSpace(displayName), userID); err != nil {
			return err
		}
	}
	if roleIDs != nil {
		if _, err := tx.Exec(`DELETE FROM rbac_user_roles WHERE user_id=$1`, userID); err != nil {
			return err
		}
		for _, rid := range *roleIDs {
			if rid = strings.TrimSpace(rid); rid != "" {
				if _, err := tx.Exec(`INSERT INTO rbac_user_roles(user_id,role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, userID, rid); err != nil {
					return err
				}
			}
		}
	}
	return tx.Commit()
}

func (d *DB) UpdateRBACUserPassword(userID, passwordHash string) error {
	if strings.TrimSpace(userID) == "" || passwordHash == "" {
		return errors.New("参数缺失")
	}
	// token_version+1：改密即作废该用户此前签发的所有 JWT（旧 token 下次请求被拒）。
	_, err := d.Exec(`UPDATE rbac_users SET password_hash=$1,token_version=token_version+1,updated_at=now() WHERE id=$2`, passwordHash, userID)
	return err
}

func (d *DB) DeleteRBACUser(userID string) error {
	userID = strings.TrimSpace(userID)
	if userID == "" || userID == "admin" {
		return errors.New("该用户不可删除")
	}
	_, err := d.Exec(`DELETE FROM rbac_users WHERE id=$1 AND is_builtin=false`, userID)
	return err
}

// ----- 角色 -----

func (d *DB) ListRBACRoles() ([]RBACRole, error) {
	rows, err := d.Query(`SELECT id,name,description,scope,is_system,created_at,updated_at FROM rbac_roles ORDER BY is_system DESC, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RBACRole
	for rows.Next() {
		var r RBACRole
		if err := rows.Scan(&r.ID, &r.Name, &r.Description, &r.Scope, &r.IsSystem, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (d *DB) GetRBACRoleByID(id string) (*RBACRole, error) {
	var r RBACRole
	err := d.QueryRow(`SELECT id,name,description,scope,is_system,created_at,updated_at FROM rbac_roles WHERE id=$1`, strings.TrimSpace(id)).
		Scan(&r.ID, &r.Name, &r.Description, &r.Scope, &r.IsSystem, &r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (d *DB) ListRBACRolePermissionKeys(roleID string) ([]string, error) {
	rows, err := d.Query(`SELECT permission_key FROM rbac_role_permissions WHERE role_id=$1 ORDER BY permission_key`, roleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// UpsertRBACRole 新建/更新自定义角色（系统角色不可改）。
func (d *DB) UpsertRBACRole(id, name, description, scope string, permKeys []string) (*RBACRole, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("角色名不能为空")
	}
	if scope != RBACScopeAll && scope != RBACScopeAssigned && scope != RBACScopeOwn {
		scope = RBACScopeAssigned
	}
	if id == RBACRoleAdmin || id == RBACRoleOperator || id == RBACRoleAuditor || id == RBACRoleViewer {
		return nil, errors.New("系统角色不可编辑")
	}
	if strings.TrimSpace(id) == "" {
		id = newRBACID()
	}
	now := time.Now()
	tx, err := d.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO rbac_roles(id,name,description,scope,is_system,created_at,updated_at)
		VALUES ($1,$2,$3,$4,false,$5,$5)
		ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, scope=EXCLUDED.scope, updated_at=EXCLUDED.updated_at`,
		id, name, strings.TrimSpace(description), scope, now); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`DELETE FROM rbac_role_permissions WHERE role_id=$1`, id); err != nil {
		return nil, err
	}
	for _, k := range permKeys {
		if k = strings.TrimSpace(k); k == "" {
			continue
		}
		if _, ok := RBACPermissions[k]; !ok {
			return nil, errors.New("未知权限: " + k)
		}
		if _, err := tx.Exec(`INSERT INTO rbac_role_permissions(role_id,permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, k); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return d.GetRBACRoleByID(id)
}

func (d *DB) DeleteRBACRole(id string) error {
	id = strings.TrimSpace(id)
	if id == RBACRoleAdmin || id == RBACRoleOperator || id == RBACRoleAuditor || id == RBACRoleViewer {
		return errors.New("系统角色不可删除")
	}
	_, err := d.Exec(`DELETE FROM rbac_roles WHERE id=$1 AND is_system=false`, id)
	return err
}
