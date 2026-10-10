// Command antifox runs the AntiFox backend: the dual SQLite graph stores,
// the event-driven exploration engine, and the JSON HTTP API consumed by the
// shadcn/ui frontend.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"antifox/config"
	"antifox/server"
)

// version is the build version, injected at release time via
// -ldflags "-X main.version=<tag>". Defaults to "dev" for local builds.
var version = "dev"

const banner = `
   _   _  _ _____ ___ ___ _____  __
  /_\ | \| |_   _|_ _| __/ _ \ \/ /
 / _ \| .  | | |  | || _| (_) >  <
/_/ \_\_|\_| |_| |___|_| \___/_/\_\
`

// printBanner writes the startup banner + version/runtime info to stdout.
func printBanner(addr string) {
	fmt.Print(banner)
	fmt.Println("  AI 自主渗透测试系统")
	fmt.Printf("  版本 %s  ·  %s/%s  ·  %s  ·  监听 %s\n\n",
		version, runtime.GOOS, runtime.GOARCH, runtime.Version(), addr)
}

func main() {
	var (
		addr    = flag.String("addr", ":8787", "HTTP listen address")
		dataDir = flag.String("data", filepath.Join(config.BaseDir(), "data"), "data directory for SQLite stores (default: data/ next to the executable)")
		proxy   = flag.String("proxy", ":8788", "traffic recording proxy address (empty to disable)")
	)
	flag.Parse()

	printBanner(*addr)

	// capture backend logs into the in-memory sink (still to stderr) so the /logs
	// page can show a live log stream. Do this first, to catch startup logs too.
	server.StartLogCapture()

	// surface which config file the binary reads (absolute, so `go run`'s relative
	// "config.json" — resolved against the CWD — is unambiguous).
	cfgPath := config.Path()
	if abs, e := filepath.Abs(cfgPath); e == nil {
		cfgPath = abs
	}
	if _, e := os.Stat(cfgPath); e == nil {
		log.Printf("[config] 配置文件: %s", cfgPath)
	} else {
		log.Printf("[config] 配置文件: %s (不存在 — 将仅尝试环境变量 ANTIFOX_PG_DSN)", cfgPath)
	}

	// 数据目录持久化守卫：dataDir 落在 /tmp 或系统临时目录时，重启即清空——流量/报告/转录
	// 全部静默丢失。DB 另存(持久)，但文件数据必须在持久卷上。大声告警，避免把工作数据放临时目录。
	if abs, _ := filepath.Abs(*dataDir); abs != "" {
		if abs == "/tmp" || strings.HasPrefix(abs, "/tmp/") || strings.HasPrefix(abs, os.TempDir()) {
			log.Printf("⚠️  [data] dataDir=%s 位于临时目录，重启即清空(流量/报告/转录会全部丢失)！请用 -data 指向持久目录，如 ~/antifox-data 或 /opt/antifox/data。", abs)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	mgr, err := server.NewManager(*dataDir, *proxy)
	if err != nil {
		log.Fatalf("open stores: %v", err)
	}
	defer mgr.Close()

	// Default skillDir to <dataDir>/skills so bundled skills materialize into the
	// writable, persistent data volume (portable across cloud / on-prem deploys).
	skillDir := config.SkillDir(filepath.Join(*dataDir, "skills"))
	if abs, err := filepath.Abs(skillDir); err == nil {
		skillDir = abs
	}
	log.Printf("[config] skill 目录: %s", skillDir)
	srv := server.New(ctx, mgr, skillDir, *dataDir)
	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("AntiFox %s backend listening on %s (data=%s, workers=%d)", version, *addr, *dataDir, mgr.Workers())
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
}
