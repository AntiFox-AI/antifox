# syntax=docker/dockerfile:1
#
# 运行镜像（不在镜像里编译）：只装常用工具，放入**预编译好的 Linux 单二进制**。
# 二进制由 CI 的 binaries job 交叉编译（纯 Go、无 QEMU），按目标架构放在
# 构建上下文的 dist/<TARGETARCH>/antifox。这样多架构构建时 arm64 只需模拟 apt 层，
# 不再模拟 Next/Go 编译，速度快得多。
#
# 本地手动构建镜像时，先自行准备二进制：
#   cd web && npm run build:static && cd ..
#   cp -r web/out server/webui/dist
#   CGO_ENABLED=0 GOARCH=amd64 go build -tags embedui -o dist/amd64/antifox ./cmd/antifox
#   docker build -t antifox:local .
FROM python:3.12-slim-bookworm
ARG TARGETARCH
# 常用工具：ripgrep / curl / vim，加一批 recon 常备件（按需增删）。
# Node 从 NodeSource 装 20.x：bookworm 自带的 apt nodejs 是 18，Playwright 要求 >=20。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates ripgrep curl wget vim git jq unzip \
      dnsutils iputils-ping netcat-openbsd whois nmap \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
# 预装 Playwright MCP/CLI + Chromium，让容器内 browser MCP 开箱即用。
# 注意：上一层清了 apt lists，而 `--with-deps` 要用 apt 装 chromium 的系统依赖，
# 故本层先 apt-get update 重建列表，否则 playwright install 会以 exit 100 失败。
RUN apt-get update \
    && npm install -g @playwright/mcp@latest @playwright/cli@latest playwright@latest \
    && playwright-cli --help \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*
# 报告生成依赖 python-docx（Go 侧渲染 .docx 时作为子进程调用 report_builder.py）
RUN pip install --no-cache-dir python-docx
WORKDIR /app
# 预编译好的对应架构二进制（dist/amd64/antifox 或 dist/arm64/antifox）
COPY dist/${TARGETARCH}/antifox /app/antifox
RUN chmod +x /app/antifox
COPY skills/ /app/skills/
# data/（SQLite + jwt.key）持久化点
VOLUME ["/app/data"]
EXPOSE 8787 8788
ENTRYPOINT ["/app/antifox"]
CMD ["-addr", ":8787", "-proxy", ":8788"]
