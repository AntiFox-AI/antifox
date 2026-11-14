package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"antifox/db"
)

func TestDeletedUserTokenIsRejected(t *testing.T) {
	m, err := NewManager(t.TempDir(), "")
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	defer m.Close()
	if err := m.pg.BootstrapRBAC(""); err != nil {
		t.Fatal(err)
	}
	name := "security-test-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	u, err := m.pg.CreateRBACUser(name, "", "unused", true, []string{db.RBACRoleViewer})
	if err != nil {
		t.Fatal(err)
	}
	defer m.pg.DeleteRBACUser(u.ID)
	key := []byte("01234567890123456789012345678901")
	tok, err := signJWT(key, u.ID, u.Username)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{m: m, jwtKey: key}
	handler := s.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	request := func(token, path string) int {
		r := httptest.NewRequest(http.MethodPost, path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w.Code
	}
	if got := request(tok, "/api/rbac/users"); got != http.StatusForbidden {
		t.Fatalf("viewer before deletion: got %d", got)
	}
	if err := m.pg.DeleteRBACUser(u.ID); err != nil {
		t.Fatal(err)
	}
	if got := request(tok, "/api/rbac/users"); got != http.StatusUnauthorized {
		t.Fatalf("deleted user token: got %d", got)
	}
	emptySubject, err := signJWT(key, "", "test")
	if err != nil {
		t.Fatal(err)
	}
	if got := request(emptySubject, "/api/rbac/users"); got != http.StatusUnauthorized {
		t.Fatalf("empty subject: got %d", got)
	}
	unavailable := (&Server{jwtKey: key}).requireAuth(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("handler called without authorization database")
	}))
	r := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	unavailable.ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable database: got %d", w.Code)
	}
}

func TestMCPSecretsRedactedAndPreserved(t *testing.T) {
	m, err := NewManager(t.TempDir(), "")
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	defer m.Close()
	name := "security-mcp-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	mcp := &db.MCPServer{
		Name: name, Transport: "http", URL: "http://localhost:19090",
		Env:     json.RawMessage(`{"TOKEN":"test-only-secret"}`),
		Headers: json.RawMessage(`{"Authorization":"test-only-secret"}`),
	}
	id, err := m.pg.SaveMCP(mcp)
	if err != nil {
		t.Fatal(err)
	}
	defer m.pg.DeleteMCP(id)
	s := &Server{m: m}
	w := httptest.NewRecorder()
	s.pgListMCP(w, httptest.NewRequest(http.MethodGet, "/api/mcp", nil))
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "test-only-secret") {
		t.Fatalf("MCP list leaks secrets or failed: status %d", w.Code)
	}
	update := &db.MCPServer{ID: id, Name: name, Transport: "http", URL: mcp.URL, Enabled: true}
	if _, err := m.pg.SaveMCP(update); err != nil {
		t.Fatal(err)
	}
	check := func(want bool) {
		t.Helper()
		var env, headers []byte
		if err := m.pg.QueryRow(`SELECT env, headers FROM mcp_servers WHERE id=$1`, id).Scan(&env, &headers); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(env), "test-only-secret") != want || strings.Contains(string(headers), "test-only-secret") != want {
			t.Fatalf("incorrect secret retention, want %v", want)
		}
	}
	check(true)
	update.URL = "http://localhost:19091"
	if _, err := m.pg.SaveMCP(update); err != nil {
		t.Fatal(err)
	}
	check(false)

	req := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(`{"id":1,"transport":"http"}`))
	w = httptest.NewRecorder()
	s.pgSaveMCP(w, req.WithContext(context.Background()))
	if w.Code != http.StatusForbidden {
		t.Fatalf("non-admin MCP update: got %d", w.Code)
	}
}

func TestKnowledgeConfigRequiresAdmin(t *testing.T) {
	s := &Server{}
	for _, handler := range []http.HandlerFunc{s.saveKnowledgeConfig, s.testKnowledgeEmbedder} {
		w := httptest.NewRecorder()
		handler(w, httptest.NewRequest(http.MethodPost, "/", nil))
		if w.Code != http.StatusForbidden {
			t.Fatalf("non-admin configuration access: got %d", w.Code)
		}
	}
}

func TestKnowledgeKeyCannotFollowChangedEndpoint(t *testing.T) {
	m, err := NewManager(t.TempDir(), "")
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	defer m.Close()
	original, err := m.pg.GetKnowledgeConfig()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, err := m.pg.Exec(`UPDATE knowledge_config SET enabled=$1, base_url=$2, model=$3, api_key=$4, dim=$5 WHERE id=1`,
			original.Enabled, original.BaseURL, original.Model, original.APIKey, original.Dim)
		if err != nil {
			t.Errorf("restore knowledge config: %v", err)
		}
	}()
	if err := m.pg.SaveKnowledgeConfig(true, "http://localhost:19090", "test", "test-only-secret", 1); err != nil {
		t.Fatal(err)
	}
	if err := m.pg.SaveKnowledgeConfig(true, "http://localhost:19090", "test", "", 1); err != nil {
		t.Fatalf("same endpoint should preserve key: %v", err)
	}
	if err := m.pg.SaveKnowledgeConfig(true, "http://localhost:19091", "test", "", 1); !errors.Is(err, db.ErrKnowledgeKeyRequired) {
		t.Fatalf("changed endpoint should require key: %v", err)
	}
	cfg, err := m.pg.GetKnowledgeConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BaseURL != "http://localhost:19090" || cfg.APIKey != "test-only-secret" {
		t.Fatal("rejected update modified the original configuration")
	}
}
