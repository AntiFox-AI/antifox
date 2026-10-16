package server

import (
	"context"
	"crypto/rand"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"antifox/db"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const (
	jwtKeyFilename = "jwt.key"
	authPassKey    = "auth.password_hash" // 旧单用户密码（仅用于首启迁移到 rbac_users）
	// defaultSessionTTL 是会话（JWT）时长的默认值——同时是"空闲超时"窗口：
	// 活跃使用时后端会滑动续期（见 requireAuth），空闲超过该时长则 token 过期需重新登录。
	// 可用设置 auth.session_ttl_minutes 覆盖（分钟）。
	defaultSessionTTL = 60 * time.Minute
	sessionTTLKey     = "auth.session_ttl_minutes"
	keyChars          = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
)

type ctxKey int

const accessCtxKey ctxKey = 1

// authClaims 携带用户 id(Subject) + 用户名 + 签发时的密码版本（token_version）。
// Ver 让「改密/停用即踢下线」成立：校验时与库里当前 token_version 比对，不等即拒。
type authClaims struct {
	Username string `json:"usr"`
	Ver      int    `json:"ver"`
	jwt.RegisteredClaims
}

// CurrentAccess 从请求上下文取当前登录用户的 RBAC 授权画像（requireAuth 注入）。
func CurrentAccess(r *http.Request) *db.RBACAccess {
	acc, _ := r.Context().Value(accessCtxKey).(*db.RBACAccess)
	return acc
}

// loadOrCreateJWTKey reads / generates the 32-byte HS256 signing key.
func loadOrCreateJWTKey(dataDir string) ([]byte, error) {
	path := filepath.Join(dataDir, jwtKeyFilename)
	if data, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(data))) >= 32 {
		return []byte(strings.TrimSpace(string(data))), nil
	}
	buf := make([]byte, 32)
	for i := range buf {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(keyChars))))
		if err != nil {
			return nil, fmt.Errorf("generate jwt key: %w", err)
		}
		buf[i] = keyChars[n.Int64()]
	}
	if err := os.WriteFile(path, buf, 0600); err != nil {
		return nil, fmt.Errorf("write jwt key: %w", err)
	}
	log.Printf("[auth] 新 JWT key 已写入 %s", path)
	return buf, nil
}

// sessionTTL 读取会话时长（分钟）设置，未设/非法则回退默认。
func (s *Server) sessionTTL() time.Duration {
	if s.m != nil && s.m.pg != nil {
		if m := s.m.pg.GetInt(sessionTTLKey, 0); m > 0 {
			return time.Duration(m) * time.Minute
		}
	}
	return defaultSessionTTL
}

// signJWT issues an HS256 token with the default session TTL (tests use this).
func signJWT(key []byte, userID, username string) (string, error) {
	return signJWTTTL(key, userID, username, 0, defaultSessionTTL)
}

// signJWTTTL issues an HS256 token that expires after ttl, stamped with the user's
// current token_version (ver) so a later password change / disable invalidates it.
func signJWTTTL(key []byte, userID, username string, ver int, ttl time.Duration) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodHS256, authClaims{
		Username: username,
		Ver:      ver,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}).SignedString(key)
}

// parseJWT validates and returns the claims.
func parseJWT(tokenStr string, key []byte) (*authClaims, bool) {
	var c authClaims
	t, err := jwt.ParseWithClaims(tokenStr, &c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return key, nil
	})
	if err != nil || !t.Valid {
		return nil, false
	}
	return &c, true
}

// extractToken reads the JWT from Authorization: Bearer, antifox_token cookie, or ?token=.
func extractToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	if c, err := r.Cookie("antifox_token"); err == nil && c.Value != "" {
		return c.Value
	}
	return r.URL.Query().Get("token")
}

// requireAuth 校验 JWT + 解析用户/权限注入 context。/api/auth/* 与 /api/health 豁免。
func (s *Server) requireAuth(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/api/auth/") || p == "/api/health" {
			h.ServeHTTP(w, r)
			return
		}
		claims, ok := parseJWT(extractToken(r), s.jwtKey)
		if !ok {
			writeErr(w, 401, "未授权或 token 已过期")
			return
		}
		// 解析授权画像（供 RBAC 强制与管理），账号停用 / token 版本过期即拒。
		if s.m != nil && s.m.pg != nil && claims.Subject != "" {
			acc, err := s.m.pg.ResolveRBACAccess(claims.Subject)
			if err == nil && acc != nil {
				if !acc.User.Enabled {
					writeErr(w, 403, "账号已停用")
					return
				}
				// token 版本校验：改密 / 停用后 token_version 自增，旧 token 携带的 Ver
				// 落后即失效，强制重新登录。
				if claims.Ver != acc.User.TokenVersion {
					writeErr(w, 401, "登录状态已失效，请重新登录")
					return
				}
				// 滑动续期（= 空闲超时）：token 走过半程且仍在活跃使用，就签发新 token 经
				// X-Refresh-Token 响应头回传，前端替换存储；空闲超过会话时长则自然过期需重登。
				if claims.ExpiresAt != nil {
					ttl := s.sessionTTL()
					if rem := time.Until(claims.ExpiresAt.Time); rem > 0 && rem < ttl/2 {
						if fresh, err := signJWTTTL(s.jwtKey, claims.Subject, claims.Username, acc.User.TokenVersion, ttl); err == nil {
							w.Header().Set("Access-Control-Expose-Headers", "X-Refresh-Token")
							w.Header().Set("X-Refresh-Token", fresh)
						}
					}
				}
				r = r.WithContext(context.WithValue(r.Context(), accessCtxKey, acc))
				// 权限强制拦截。安全阀：未映射路由放行；admin(全权)永不被拦；开关 rbac.enforce 默认 true。
				if s.m.pg.GetBool("rbac.enforce", true) {
					if perm := permissionForRequest(r.Method, r.URL.Path); perm != "" && !acc.Permissions[perm] {
						writeErr(w, 403, "权限不足："+perm)
						return
					}
				}
			}
		}
		h.ServeHTTP(w, r)
	})
}

// bootstrapRBAC 首启把旧单用户密码迁移成内置 admin，并播种角色/权限（幂等）。
func (s *Server) bootstrapRBAC() {
	if s.m == nil || s.m.pg == nil {
		return
	}
	legacyHash, _, _ := s.m.pg.GetSetting(authPassKey)
	if err := s.m.pg.BootstrapRBAC(legacyHash); err != nil {
		log.Printf("[rbac] bootstrap 失败: %v", err)
		return
	}
	if strings.TrimSpace(legacyHash) != "" {
		log.Printf("[rbac] 多用户权限就绪（已迁移旧密码为内置 admin）")
	} else {
		log.Printf("[rbac] 多用户权限就绪")
	}
}

// GET /api/auth/status — 是否已初始化（有平台用户）。
func (s *Server) authStatus(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	needs, err := pg.RBACNeedsBootstrap()
	if err != nil {
		writeErr(w, 500, "查询失败")
		return
	}
	writeJSON(w, 200, map[string]any{"initialized": !needs})
}

// POST /api/auth/init — 首启设管理员密码（建内置 admin）。
func (s *Server) authInit(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	ip := clientIP(r)
	// fail-closed：初始化守卫查询出错时一律拒绝，绝不把查询失败当成「未初始化」而放行设置
	// 密码（否则查询失败可被用来重置管理员口令）。
	needs, err := pg.RBACNeedsBootstrap()
	if err != nil {
		pg.RecordAudit("", "auth", "init", "fail", ip, "初始化守卫查询失败（已拒绝）", nil)
		writeErr(w, 503, "服务暂时不可用")
		return
	}
	if !needs {
		pg.RecordAudit("", "auth", "init", "fail", ip, "平台已初始化，拒绝重复设置密码", nil)
		writeErr(w, 403, "已初始化")
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if msg := validatePasswordStrength(req.Password); msg != "" {
		writeErr(w, 400, msg)
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, 500, "密码加密失败")
		return
	}
	if err := pg.BootstrapRBAC(string(hash)); err != nil {
		writeErr(w, 500, "初始化失败: "+err.Error())
		return
	}
	_ = pg.SetSetting(authPassKey, string(hash)) // 兼容保留
	ver := 0
	if u, e := pg.GetRBACUserByID("admin"); e == nil && u != nil {
		ver = u.TokenVersion
	}
	tok, err := signJWTTTL(s.jwtKey, "admin", "admin", ver, s.sessionTTL())
	if err != nil {
		writeErr(w, 500, "token 生成失败")
		return
	}
	pg.RecordAudit("admin", "auth", "init", "success", ip, "首启初始化管理员密码", nil)
	writeJSON(w, 200, map[string]any{"token": tok})
}

// POST /api/auth/change-password — 改当前登录用户的密码。
func (s *Server) authChangePassword(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	claims, ok := parseJWT(extractToken(r), s.jwtKey)
	if !ok {
		writeErr(w, 401, "未授权")
		return
	}
	u, err := pg.GetRBACUserByID(claims.Subject)
	if err != nil {
		writeErr(w, 401, "用户不存在")
		return
	}
	var req struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if msg := validatePasswordStrength(req.NewPassword); msg != "" {
		writeErr(w, 400, msg)
		return
	}
	ip := clientIP(r)
	if err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(req.OldPassword)); err != nil {
		pg.RecordAudit(u.Username, "auth", "change_password", "fail", ip, "当前密码错误", nil)
		writeErr(w, 401, "当前密码错误")
		return
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, 500, "密码加密失败")
		return
	}
	// UpdateRBACUserPassword 会自增 token_version，作废含本次请求 token 在内的所有旧 token。
	if err := pg.UpdateRBACUserPassword(u.ID, string(newHash)); err != nil {
		writeErr(w, 500, "保存失败: "+err.Error())
		return
	}
	pg.RecordAudit(u.Username, "auth", "change_password", "success", ip, "修改密码成功", nil)
	// 用新版本号给调用方补发一张 token，避免「刚改完密码自己就被踢」；其它设备的旧 token 仍失效。
	fresh := ""
	if nu, e := pg.GetRBACUserByID(u.ID); e == nil && nu != nil {
		fresh, _ = signJWTTTL(s.jwtKey, nu.ID, nu.Username, nu.TokenVersion, s.sessionTTL())
	}
	writeJSON(w, 200, map[string]any{"ok": true, "token": fresh})
}

// POST /api/auth/login — 校验用户名/密码返回 JWT。
func (s *Server) authLogin(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	ip := clientIP(r)
	uname := strings.TrimSpace(req.Username)
	// 暴力破解防护：按 IP + 账号双维度检查锁定状态。命中锁定直接 429，不再做任何
	// 口令比对（bcrypt 本身耗 CPU，先挡在前面同时也缓解了「海量尝试打满 CPU/连接」）。
	if locked, retry := s.loginLimiter.locked(ip, uname); locked {
		w.Header().Set("Retry-After", strconv.Itoa(int(retry.Seconds())))
		pg.RecordAudit(uname, "auth", "login_locked", "fail", ip,
			fmt.Sprintf("触发暴力破解锁定，剩余冷却 %ds", int(retry.Seconds())), nil)
		writeErr(w, 429, fmt.Sprintf("尝试过于频繁，账号/来源已临时锁定，请 %d 秒后再试", int(retry.Seconds())))
		return
	}
	u, err := pg.GetRBACUserByUsername(req.Username)
	if err != nil || u == nil || !u.Enabled {
		reason := "用户名或密码错误"
		if u != nil && !u.Enabled {
			reason = "账号已停用"
		}
		s.registerLoginFailure(pg, ip, uname)
		pg.RecordAudit(uname, "auth", "login_failed", "fail", ip, reason, nil)
		log.Printf("[auth] 登录失败 用户=%q ip=%s 原因=%s", uname, ip, reason)
		writeErr(w, 401, reason)
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(req.Password)); err != nil {
		s.registerLoginFailure(pg, ip, u.Username)
		pg.RecordAudit(u.Username, "auth", "login_failed", "fail", ip, "密码错误", nil)
		log.Printf("[auth] 登录失败 用户=%q ip=%s 原因=密码错误", u.Username, ip)
		writeErr(w, 401, "用户名或密码错误")
		return
	}
	tok, err := signJWTTTL(s.jwtKey, u.ID, u.Username, u.TokenVersion, s.sessionTTL())
	if err != nil {
		writeErr(w, 500, "token 生成失败")
		return
	}
	s.loginLimiter.reset(ip, u.Username) // 成功登录清零该 IP+账号的失败计数
	pg.RecordAudit(u.Username, "auth", "login", "success", ip, "登录成功", nil)
	log.Printf("[auth] 登录成功 用户=%q ip=%s", u.Username, ip)
	writeJSON(w, 200, map[string]any{"token": tok})
}

// registerLoginFailure 记一次失败到限流器；若恰好触发锁定则写一条审计便于在日志页看到。
func (s *Server) registerLoginFailure(pg *db.DB, ip, username string) {
	if s.loginLimiter.fail(ip, username, s.loginPolicy()) {
		pg.RecordAudit(username, "auth", "login_locked", "fail", ip, "失败次数超阈值，已临时锁定", nil)
		log.Printf("[auth] 暴力破解锁定 用户=%q ip=%s", username, ip)
	}
}

// validatePasswordStrength 返回空串=通过，否则=给用户的中文原因。
// 规则：长度 8–128 位，至少包含两类字符（字母 / 数字 / 符号），且不能是单一重复字符。
func validatePasswordStrength(pw string) string {
	if len(pw) < 8 {
		return "密码至少 8 位"
	}
	if len(pw) > 128 {
		return "密码过长（最多 128 位）"
	}
	var hasLetter, hasDigit, hasOther bool
	allSame := true
	for i, r := range pw {
		switch {
		case unicode.IsLetter(r):
			hasLetter = true
		case unicode.IsDigit(r):
			hasDigit = true
		default:
			hasOther = true
		}
		if i > 0 && rune(pw[i]) != rune(pw[0]) {
			allSame = false
		}
	}
	if allSame {
		return "密码不能是单一重复字符"
	}
	classes := 0
	for _, b := range []bool{hasLetter, hasDigit, hasOther} {
		if b {
			classes++
		}
	}
	if classes < 2 {
		return "密码需至少包含两类字符（字母 / 数字 / 符号）"
	}
	return ""
}

// clientIP 提取客户端 IP（优先 X-Forwarded-For / X-Real-IP，回退 RemoteAddr）。
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if xr := r.Header.Get("X-Real-IP"); xr != "" {
		return strings.TrimSpace(xr)
	}
	host := r.RemoteAddr
	if i := strings.LastIndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	return host
}
