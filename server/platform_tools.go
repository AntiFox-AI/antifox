package server

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	actool "antifox/engine/tool"
	"antifox/db"
)

// 平台操作工具(给内置 Auto agent 用):建/改 skill、自定义工具、MCP。都是 host 工具,
// seed 进 tools 表、默认绑定 auto,经 hostTools 注入。复用现有 db/文件系统逻辑。

func (s *Server) platformTools() []actool.CoreTool {
	return []actool.CoreTool{
		s.toolCreateSkill(),
		s.toolUpdateSkillFile(),
		s.toolCreateCustomTool(),
		s.toolUpdateCustomTool(),
		s.toolCreateMCP(),
		s.toolUpdateMCP(),
	}
}

// platformToolKeys are the tool keys the Auto agent gets bound by default.
var platformToolKeys = []string{
	"create_skill", "update_skill_file",
	"create_custom_tool", "update_custom_tool",
	"create_mcp", "update_mcp",
}

// ---- skills ----

func (s *Server) toolCreateSkill() actool.CoreTool {
	return wrTool("create_skill",
		"创建一个新 skill(写 SKILL.md，agentskills.io 规范)。name 小写字母/数字/连字符。",
		objSchema(map[string]any{
			"name":         strParam("skill 名(小写字母开头，字母/数字/连字符)"),
			"description":  strParam("skill 描述(必填，说明它做什么/何时用)"),
			"instructions": strParam("Markdown 正文说明(可选)"),
		}, "name", "description"),
		func(_ context.Context, in json.RawMessage) (actool.Result, error) {
			var a struct{ Name, Description, Instructions string }
			_ = json.Unmarshal(in, &a)
			if !validSkillName(a.Name) {
				return actool.Errorf("skill 名不合法(小写字母开头，仅字母/数字/连字符，≤64)"), nil
			}
			if strings.TrimSpace(a.Description) == "" {
				return actool.Errorf("description 必填"), nil
			}
			path := filepath.Join(s.skillDir, a.Name)
			if _, err := os.Stat(path); err == nil {
				return actool.Errorf("skill 已存在: " + a.Name), nil
			}
			if err := os.MkdirAll(path, 0o755); err != nil {
				return actool.Errorf(err.Error()), nil
			}
			var b strings.Builder
			b.WriteString("---\n")
			fmt.Fprintf(&b, "name: %s\n", a.Name)
			fmt.Fprintf(&b, "description: %s\n", a.Description)
			b.WriteString("---\n")
			if strings.TrimSpace(a.Instructions) != "" {
				b.WriteString(a.Instructions)
			} else {
				fmt.Fprintf(&b, "## %s\n\n1. \n2. \n3. \n", a.Name)
			}
			if err := os.WriteFile(filepath.Join(path, "SKILL.md"), []byte(b.String()), 0o644); err != nil {
				_ = os.RemoveAll(path)
				return actool.Errorf(err.Error()), nil
			}
			return actool.Text("skill created: " + a.Name), nil
		})
}

func (s *Server) toolUpdateSkillFile() actool.CoreTool {
	return wrTool("update_skill_file",
		"写/覆盖某个 skill 内的一个文件(默认 SKILL.md)。用于修改技能内容或加脚本/引用。",
		objSchema(map[string]any{
			"name":    strParam("skill 名"),
			"file":    strParam("相对路径(可选，默认 SKILL.md，如 scripts/run.py)"),
			"content": strParam("文件完整内容"),
		}, "name", "content"),
		func(_ context.Context, in json.RawMessage) (actool.Result, error) {
			var a struct{ Name, File, Content string }
			_ = json.Unmarshal(in, &a)
			if !validSkillName(a.Name) {
				return actool.Errorf("skill 名不合法"), nil
			}
			skillPath := filepath.Join(s.skillDir, a.Name)
			if _, err := os.Stat(skillPath); os.IsNotExist(err) {
				return actool.Errorf("skill 不存在: " + a.Name), nil
			}
			rel := strings.TrimSpace(a.File)
			if rel == "" {
				rel = "SKILL.md"
			}
			clean, msg := skillRelPath(rel)
			if msg != "" {
				return actool.Errorf("非法路径: " + msg), nil
			}
			full := filepath.Join(skillPath, clean)
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				return actool.Errorf(err.Error()), nil
			}
			if err := os.WriteFile(full, []byte(a.Content), 0o644); err != nil {
				return actool.Errorf(err.Error()), nil
			}
			return actool.Text("skill file written: " + a.Name + "/" + clean), nil
		})
}

// ---- custom tools ----

type customToolToolInput struct {
	Key         string          `json:"key"`
	Description string          `json:"description"`
	Kind        string          `json:"kind"`
	Exec        json.RawMessage `json:"exec"`
	Schema      json.RawMessage `json:"schema"`
	Agents      []string        `json:"agents"`
	Deferred    bool            `json:"deferred"`
	Enabled     *bool           `json:"enabled"`
}

func customToolSchema(keyDesc string) map[string]any {
	return objSchema(map[string]any{
		"key":         strParam(keyDesc),
		"description": strParam("发给模型的描述"),
		"kind":        strParam("shell | command | script(仅Python) | http。shell=bash 环境声明(仅告知模型该工具可在 bash 中直接调用，无需 exec/schema)；其余三种需提供 exec"),
		"exec":        map[string]any{"type": "object", "description": "执行规格(shell 类型不需要): command→{command}; script→{code}; http→{method,url,headers,body,proxy,use_recording_proxy}"},
		"schema":      map[string]any{"type": "object", "description": "参数 JSON-Schema(shell/command/script 可留空; http 必填且需含 properties)"},
		"agents":      map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "绑定的 agent key(可选)"},
		"deferred":    map[string]any{"type": "boolean", "description": "是否延迟(shell 类型无效；仅 command/script/http 的不常用工具才开)"},
		"enabled":     map[string]any{"type": "boolean", "description": "是否启用(默认 true)"},
	}, "key", "kind")
}

func toDBTool(a customToolToolInput) *db.Tool {
	enabled := true
	if a.Enabled != nil {
		enabled = *a.Enabled
	}
	return &db.Tool{
		Key: a.Key, Description: a.Description, Schema: a.Schema, Agents: a.Agents,
		Enabled: enabled, Kind: a.Kind, Exec: a.Exec, Deferred: a.Deferred,
	}
}

func (s *Server) toolCreateCustomTool() actool.CoreTool {
	return wrTool("create_custom_tool", "创建一个自定义工具(shell/command/script/http)。shell=bash 环境声明，只需 key+description+agents，无需 exec/schema。",
		customToolSchema("工具 key(小写字母开头，字母/数字/下划线)"),
		func(ctx context.Context, in json.RawMessage) (actool.Result, error) {
			var a customToolToolInput
			_ = json.Unmarshal(in, &a)
			a.Key = strings.TrimSpace(a.Key)
			if !reToolKey.MatchString(a.Key) {
				return actool.Errorf("key 需小写字母开头，仅含小写字母/数字/下划线"), nil
			}
			if a.Kind != "shell" && a.Kind != "command" && a.Kind != "script" && a.Kind != "http" {
				return actool.Errorf("kind 需为 shell / command / script / http"), nil
			}
			// 宿主命令执行类(command/script/shell)与 HTTP 层一致收归 admin：非 admin 会话的
			// agent 不得创建会在宿主机执行命令的工具。
			if hostExecToolKind(a.Kind) && !ctxIsAdmin(ctx) {
				return actool.Errorf("仅管理员可创建 command/script/shell 类自定义工具（宿主机命令执行）"), nil
			}
			if a.Kind == "http" && !hasSchemaProps(a.Schema) {
				return actool.Errorf("http 工具必须提供参数 JSON Schema(不能留空)"), nil
			}
			if exist, _ := s.m.pg.GetTool(a.Key); exist != nil {
				return actool.Errorf("该 key 已存在: " + a.Key), nil
			}
			if err := s.m.pg.CreateCustomTool(toDBTool(a)); err != nil {
				return actool.Errorf(err.Error()), nil
			}
			return actool.Text("custom tool created: " + a.Key), nil
		})
}

func (s *Server) toolUpdateCustomTool() actool.CoreTool {
	return wrTool("update_custom_tool", "修改一个已有的自定义工具(按 key)。",
		customToolSchema("要修改的自定义工具 key"),
		func(ctx context.Context, in json.RawMessage) (actool.Result, error) {
			var a customToolToolInput
			_ = json.Unmarshal(in, &a)
			existing, _ := s.m.pg.GetTool(a.Key)
			if existing == nil || existing.System {
				return actool.Errorf("只能修改自定义工具: " + a.Key), nil
			}
			if a.Kind != "shell" && a.Kind != "command" && a.Kind != "script" && a.Kind != "http" {
				return actool.Errorf("kind 需为 shell / command / script / http"), nil
			}
			// 新旧任一为宿主命令执行类都收归 admin（防把 http 工具改成 command 绕过）。
			if (hostExecToolKind(a.Kind) || hostExecToolKind(existing.Kind)) && !ctxIsAdmin(ctx) {
				return actool.Errorf("仅管理员可修改为/从 command/script/shell 类自定义工具（宿主机命令执行）"), nil
			}
			if a.Kind == "http" && !hasSchemaProps(a.Schema) {
				return actool.Errorf("http 工具必须提供参数 JSON Schema(不能留空)"), nil
			}
			if err := s.m.pg.UpdateCustomTool(toDBTool(a)); err != nil {
				return actool.Errorf(err.Error()), nil
			}
			return actool.Text("custom tool updated: " + a.Key), nil
		})
}

// ---- MCP ----

type mcpToolInput struct {
	ID        int64           `json:"id"`
	Name      string          `json:"name"`
	Transport string          `json:"transport"`
	Command   string          `json:"command"`
	Args      json.RawMessage `json:"args"`
	Env       json.RawMessage `json:"env"`
	URL       string          `json:"url"`
	Enabled   *bool           `json:"enabled"`
}

func mcpSchema(withID bool) map[string]any {
	props := map[string]any{
		"name":      strParam("MCP 服务器名"),
		"transport": strParam("stdio | http / sse"),
		"command":   strParam("stdio 的启动命令(如 npx)"),
		"args":      map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "命令参数数组"},
		"env":       map[string]any{"type": "object", "description": "环境变量 {KEY:VALUE}"},
		"url":       strParam("http/sse 的 URL"),
		"enabled":   map[string]any{"type": "boolean", "description": "是否启用(默认 true)"},
	}
	required := []string{"name", "transport"}
	if withID {
		props["id"] = map[string]any{"type": "integer", "description": "要修改的 MCP 服务器 id"}
		required = []string{"id", "name", "transport"}
	}
	return objSchema(props, required...)
}

func (a mcpToolInput) toDB() *db.MCPServer {
	enabled := true
	if a.Enabled != nil {
		enabled = *a.Enabled
	}
	return &db.MCPServer{
		ID: a.ID, Name: a.Name, Transport: a.Transport, Command: a.Command,
		Args: a.Args, Env: a.Env, URL: a.URL, Enabled: enabled,
	}
}

func (s *Server) toolCreateMCP() actool.CoreTool {
	return wrTool("create_mcp", "创建一个 MCP 服务器(stdio/http)。创建后其工具需按 agent 可见性授权。",
		mcpSchema(false),
		func(ctx context.Context, in json.RawMessage) (actool.Result, error) {
			var a mcpToolInput
			_ = json.Unmarshal(in, &a)
			a.ID = 0
			if strings.TrimSpace(a.Name) == "" || strings.TrimSpace(a.Transport) == "" {
				return actool.Errorf("name / transport 必填"), nil
			}
			// stdio MCP 由服务端把 command/args 作为子进程拉起 = 宿主机命令执行，与 HTTP 层一致收归 admin。
			if strings.EqualFold(strings.TrimSpace(a.Transport), "stdio") && !ctxIsAdmin(ctx) {
				return actool.Errorf("仅管理员可创建 stdio 类型的 MCP 服务（会在宿主机启动子进程）"), nil
			}
			id, err := s.m.pg.SaveMCP(a.toDB())
			if err != nil {
				return actool.Errorf(err.Error()), nil
			}
			return actool.Text(fmt.Sprintf("mcp created: id=%d name=%s", id, a.Name)), nil
		})
}

func (s *Server) toolUpdateMCP() actool.CoreTool {
	return wrTool("update_mcp", "修改一个已有的 MCP 服务器(按 id)。",
		mcpSchema(true),
		func(ctx context.Context, in json.RawMessage) (actool.Result, error) {
			// 与 HTTP 层一致：修改已有 MCP 收归 admin（已有配置可能含凭据，非 admin 会话的
			// agent 不得改地址/命令转发凭据）。调度器/普通会话触发的 agent run 为 admin=false。
			if !ctxIsAdmin(ctx) {
				return actool.Errorf("仅管理员可修改已有 MCP 配置"), nil
			}
			var a mcpToolInput
			_ = json.Unmarshal(in, &a)
			if a.ID == 0 {
				return actool.Errorf("id 必填"), nil
			}
			// 读现有 MCP 填充 input 未提供的连接要素(name/transport/command/args/url)——否则只改
			// 部分字段时这些字段变空，会被 SaveMCP 误判为"端点变更"而清空已存凭据(env/headers)。
			var cur *db.MCPServer
			if list, err := s.m.pg.ListMCP(); err == nil {
				for _, m := range list {
					if m.ID == a.ID {
						cur = m
						break
					}
				}
			}
			if cur == nil {
				return actool.Errorf(fmt.Sprintf("MCP 不存在: id=%d", a.ID)), nil
			}
			d := a.toDB()
			if strings.TrimSpace(d.Name) == "" {
				d.Name = cur.Name
			}
			if strings.TrimSpace(d.Transport) == "" {
				d.Transport = cur.Transport
			}
			if strings.TrimSpace(d.Command) == "" {
				d.Command = cur.Command
			}
			if len(d.Args) == 0 {
				d.Args = cur.Args
			}
			if strings.TrimSpace(d.URL) == "" {
				d.URL = cur.URL
			}
			// mcpToolInput 不含 description/timeout 字段 → 总是保留现有值，不被置空/归零。
			d.Description = cur.Description
			d.TimeoutSeconds = cur.TimeoutSeconds
			if _, err := s.m.pg.SaveMCP(d); err != nil {
				return actool.Errorf(err.Error()), nil
			}
			return actool.Text(fmt.Sprintf("mcp updated: id=%d", a.ID)), nil
		})
}
