//go:build embedui

package server

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// webuiDist holds the statically-exported frontend (built with
// `cd web && npm run build:static`, then copied into server/webui/dist). Compiled
// into the binary only when building with `-tags embedui`. The `all:` prefix is
// required so Next's `_next/` asset dir (leading underscore) is included.
//
//go:embed all:webui/dist
var webuiDist embed.FS

// webuiHandler serves the embedded SPA. Public (no JWT) — auth is enforced
// client-side and on /api. Serves the exported per-route index.html files and
// falls back to index.html so client-side routing still resolves unknown paths.
func (s *Server) webuiHandler() http.Handler {
	root, err := fs.Sub(webuiDist, "webui/dist")
	if err != nil {
		panic(err)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" {
			p = "index.html"
		}
		// 1) exact file (assets: _next/*, favicon.ico, ...)
		// 2) route dir → <p>/index.html (trailingSlash export)
		// 3) <p>.html
		// 4) SPA 兜底 → index.html（交给客户端路由）
		for _, cand := range []string{p, p + "/index.html", p + ".html"} {
			if serveFileIfExists(w, r, root, cand) {
				return
			}
		}
		// SPA 兜底也是 HTML——必须 no-cache，否则更新后浏览器拿旧 HTML（引用旧 chunk）看旧版。
		setWebUICache(w, "index.html")
		http.ServeFileFS(w, r, root, "index.html")
	})
}

// setWebUICache sets caching policy by asset kind. HTML（index.html / *.html）必须
// no-cache——它引用带 hash 的 chunk，更新后 HTML 变、hash 变，HTML 被强缓存会让用户
// 一直看旧版（自更新后尤其明显）。带 hash 的静态资源（_next/static/**）可长缓存不可变。
func setWebUICache(w http.ResponseWriter, name string) {
	switch {
	case strings.HasPrefix(name, "_next/static/"):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	case strings.HasSuffix(name, ".html") || name == "index.html":
		w.Header().Set("Cache-Control", "no-cache")
	}
}

// serveFileIfExists serves name from fsys when it exists as a regular file.
func serveFileIfExists(w http.ResponseWriter, r *http.Request, fsys fs.FS, name string) bool {
	f, err := fsys.Open(name)
	if err != nil {
		return false
	}
	st, statErr := f.Stat()
	_ = f.Close()
	if statErr != nil || st.IsDir() {
		return false
	}
	setWebUICache(w, name)
	http.ServeFileFS(w, r, fsys, name)
	return true
}
