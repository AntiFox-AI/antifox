// Package traffic implements the request-recording subsystem (docs §10): an
// embedded go-mitmproxy proxy whose addon writes every target HTTP exchange into
// a human-browsable file tree, with a sidecar SQLite index for paged queries.
// Full capture, plaintext (no redaction), target HTTP only.
package traffic

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"antifox/engine/permission"
	actool "antifox/engine/tool"
	"antifox/db"
	mproxy "github.com/lqqyt2423/go-mitmproxy/proxy"
	_ "modernc.org/sqlite"
)

const indexSchema = `
CREATE TABLE IF NOT EXISTS exchanges (
  id           TEXT PRIMARY KEY,
  ts           INTEGER,
  host         TEXT,
  method       TEXT,
  url_template TEXT,
  url          TEXT,
  status       INTEGER,
  content_type TEXT,
  req_len      INTEGER,
  resp_len     INTEGER,
  path         TEXT
);
CREATE INDEX IF NOT EXISTS idx_ex_host ON exchanges(host);
CREATE INDEX IF NOT EXISTS idx_ex_tmpl ON exchanges(host, url_template);
CREATE INDEX IF NOT EXISTS idx_ex_ts   ON exchanges(ts);
`

const maxInlineBody = 256 * 1024

// maxIndexBody caps how much of each decoded req/resp body goes into the full-text
// body index — enough for keyword search + snippets while bounding index growth on
// large HTML/asset responses.
const maxIndexBody = 64 * 1024

// bodyFTSSchema is the trigram FTS5 index over DECODED request/response bodies,
// powering "正文搜索" (human keyword search) AND step↔exchange correlation. It is a
// search aux keyed by exchange id (UNINDEXED, stored for retrieval); the exchanges
// table stays the source of truth, so any stale id here is harmless (it just won't
// join a real row). Created separately + guarded so a build lacking FTS5 degrades
// to metadata-only search instead of failing to open the store.
const bodyFTSSchema = `CREATE VIRTUAL TABLE IF NOT EXISTS bodies USING fts5(req, resp, id UNINDEXED, tokenize='trigram')`

// Traffic runs the recording proxy and owns the file tree + index.
type Traffic struct {
	dir   string
	addr  string
	db    *sql.DB
	wmu   sync.Mutex
	seq   atomic.Int64
	proxy *mproxy.Proxy
	ftsOK bool // trigram body index available (CREATE succeeded); false ⇒ degrade
	// pass is the set of hosts whose MITM interception failed for a proxy/protocol
	// reason; connections to them are tunneled transparently (fail-open) so the
	// request still reaches the target — unrecorded — instead of being killed.
	pass sync.Map // hostname(string) -> struct{}
}

// Open initializes the traffic tree, blob store and SQLite index under dir.
func Open(dir, addr string) (*Traffic, error) {
	for _, d := range []string{dir, filepath.Join(dir, "_index"), filepath.Join(dir, "_blobs"), filepath.Join(dir, "_ca")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "_index", "index.sqlite"))
	if err != nil {
		return nil, err
	}
	for _, p := range []string{"PRAGMA journal_mode=WAL", "PRAGMA busy_timeout=5000"} {
		if _, err := db.Exec(p); err != nil {
			db.Close()
			return nil, err
		}
	}
	if _, err := db.Exec(indexSchema); err != nil {
		db.Close()
		return nil, err
	}
	t := &Traffic{dir: dir, addr: addr, db: db}
	// Trigram body index (guarded): powers full-text 正文搜索 + step↔exchange
	// correlation. If FTS5 is unavailable we degrade to metadata-only search rather
	// than refusing to open the store.
	if _, err := db.Exec(bodyFTSSchema); err != nil {
		log.Printf("[traffic] 正文索引(FTS5 trigram)不可用，降级为仅元数据搜索：%v", err)
	} else {
		t.ftsOK = true
		go t.backfillBodies() // 已有记录的正文补进索引（后台、不阻塞启动）
	}

	p, err := mproxy.NewProxy(&mproxy.Options{
		Addr:        addr,
		SslInsecure: true,
		CaRootPath:  filepath.Join(dir, "_ca"),
	})
	if err != nil {
		db.Close()
		return nil, err
	}
	// Dial targets DIRECTLY. go-mitmproxy's default upstream uses
	// http.ProxyFromEnvironment, so an HTTP_PROXY/HTTPS_PROXY in the environment
	// (a VPN/system proxy) would make it forward target requests through that
	// external proxy — which can't reach the target → 502. We capture target
	// traffic directly, never via the host's proxy.
	p.SetUpstreamProxy(func(*http.Request) (*url.URL, error) { return nil, nil })
	// Fail-open: MITM every host by default, EXCEPT ones a prior request proved we
	// can't intercept without breaking (see maybePassthrough). Those are tunneled
	// transparently so the request still reaches the target instead of being killed.
	p.SetShouldInterceptRule(func(req *http.Request) bool {
		_, tunnel := t.pass.Load(hostOnly(req.Host))
		return !tunnel
	})
	p.AddAddon(&sink{t: t})
	t.proxy = p
	return t, nil
}

// hostOnly strips an optional :port, so passthrough keys match whether the host
// arrives as "example.com:443" (CONNECT) or "example.com" (request URL).
func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return h
	}
	return hostport
}

// ProxyAddr returns the address workers should set as HTTP(S)_PROXY.
func (t *Traffic) ProxyAddr() string { return "http://127.0.0.1" + t.addr }

// CACertPath returns the PEM CA cert clients must trust to verify HTTPS through
// the MITM proxy (go-mitmproxy writes it here on first start).
func (t *Traffic) CACertPath() string {
	return filepath.Join(t.dir, "_ca", "mitmproxy-ca-cert.pem")
}

// Start runs the proxy (blocking); run in a goroutine.
func (t *Traffic) Start() error { return t.proxy.Start() }

func (t *Traffic) Close() error {
	// 优雅关闭时显式 checkpoint WAL 落盘：WAL 对崩溃本就持久(下次打开重放)，但显式合并
	// 可避免 WAL 无界增长，并保证主库文件始终是全量最新——外部备份/工具无需依赖重放即可读全。
	_, _ = t.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	return t.db.Close()
}
func (t *Traffic) DB() *sql.DB  { return t.db }

// sink is the go-mitmproxy addon that records completed exchanges.
type sink struct {
	mproxy.BaseAddon
	t *Traffic
}

func (s *sink) Response(f *mproxy.Flow) {
	if f.Request == nil || f.Response == nil {
		return
	}
	s.t.record(f)
}

// RequestError fires when a request through an established MITM tunnel fails. If
// the failure looks proxy/protocol-caused (h2 quirks, HEAD-with-body, protocol
// errors) — not a plain target-unreachable error — we flag the host for
// transparent passthrough so future requests to it succeed instead of dying.
func (s *sink) RequestError(f *mproxy.Flow, err error) { s.t.maybePassthrough(f, err) }

// maybePassthrough marks a host to be tunneled transparently on the next
// connection, but only for errors the proxy itself caused — a target that is
// simply down/filtered would fail without us too, and must stay MITM'd+recorded.
func (t *Traffic) maybePassthrough(f *mproxy.Flow, err error) {
	if err == nil || f == nil || f.Request == nil || f.Request.URL == nil || !proxyCausedErr(err) {
		return
	}
	host := f.Request.URL.Hostname()
	if host == "" {
		return
	}
	if _, loaded := t.pass.LoadOrStore(host, struct{}{}); !loaded {
		log.Printf("[traffic] 与 %s 的 MITM 出错，改为透传（该 host 后续直连目标、不再记录，但请求照常）：%v", host, err)
	}
}

// proxyCausedErr reports whether err indicates the interception layer (not the
// target) is at fault — HTTP/2 handling, HEAD-with-body, or a protocol violation.
func proxyCausedErr(err error) bool {
	s := strings.ToLower(err.Error())
	for _, p := range []string{"head request", "http2", "http/2", "protocol error", "protocol_error", "malformed"} {
		if strings.Contains(s, p) {
			return true
		}
	}
	return false
}

func (t *Traffic) record(f *mproxy.Flow) {
	host := f.Request.URL.Hostname()
	method := f.Request.Method
	tmpl := db.TemplatePath(f.Request.URL.EscapedPath())
	n := t.seq.Add(1)
	now := time.Now()
	id := fmt.Sprintf("%d-%04d", now.Unix(), n%10000)

	// dir mirrors the URL path as a browsable file tree:
	//   <host>/<seg1>/<seg2>/.../<METHOD>/<id>/{request.http,response.http,meta.json}
	// e.g. http://h/api/v1/login → traffic/h/api/v1/login/GET/<id>/
	parts := []string{t.dir, sanitize(host)}
	for _, seg := range strings.Split(strings.Trim(tmpl, "/"), "/") {
		if seg != "" {
			parts = append(parts, sanitize(seg))
		}
	}
	parts = append(parts, method, id)
	exDir := filepath.Join(parts...)
	if err := os.MkdirAll(exDir, 0o755); err != nil {
		return
	}

	reqBody := t.bodyOrBlob(f.Request.Body)
	respBody := t.bodyOrBlob(f.Response.Body)
	ct := f.Response.Header.Get("Content-Type")

	reqTxt := fmt.Sprintf("%s %s %s\n%s\n%s", method, f.Request.URL.RequestURI(), f.Request.Proto, headerLines(f.Request.Header), reqBody)
	respTxt := fmt.Sprintf("HTTP %d\n%s\n%s", f.Response.StatusCode, headerLines(f.Response.Header), respBody)
	_ = os.WriteFile(filepath.Join(exDir, "request.http"), []byte(reqTxt), 0o644)
	_ = os.WriteFile(filepath.Join(exDir, "response.http"), []byte(respTxt), 0o644)
	meta := fmt.Sprintf(`{"id":%q,"host":%q,"method":%q,"url":%q,"template":%q,"status":%d,"content_type":%q}`,
		id, host, method, f.Request.URL.String(), tmpl, f.Response.StatusCode, ct)
	_ = os.WriteFile(filepath.Join(exDir, "meta.json"), []byte(meta), 0o644)

	rel, _ := filepath.Rel(t.dir, exDir)
	t.wmu.Lock()
	_, _ = t.db.Exec(`INSERT OR REPLACE INTO exchanges(id,ts,host,method,url_template,url,status,content_type,req_len,resp_len,path)
VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		id, now.Unix(), host, method, tmpl, f.Request.URL.String(), f.Response.StatusCode, ct,
		len(f.Request.Body), len(f.Response.Body), rel)
	t.wmu.Unlock()

	// Full-text body index (decoded + capped). Stored bodies stay raw-on-wire; the
	// index holds decoded text so "正文搜索" and step correlation work on readable
	// content. Separate so a disabled/absent FTS never blocks capture.
	if t.ftsOK {
		t.indexBody(id, decodedForIndex(f.Request.Body, f.Request.DecodedBody), decodedForIndex(f.Response.Body, f.Response.DecodedBody))
	}
}

// decodedForIndex decodes a flow body via its own Content-Encoding codec and caps
// it for the index. Falls back to the raw bytes on decode failure.
func decodedForIndex(raw []byte, dec func() ([]byte, error)) string {
	b := raw
	if d, err := dec(); err == nil && d != nil {
		b = d
	}
	return capStr(string(b), maxIndexBody)
}

// indexBody inserts one exchange's decoded bodies into the trigram FTS index.
func (t *Traffic) indexBody(id, req, resp string) {
	if req == "" && resp == "" {
		return
	}
	t.wmu.Lock()
	_, _ = t.db.Exec(`INSERT INTO bodies(id, req, resp) VALUES(?,?,?)`, id, req, resp)
	t.wmu.Unlock()
}

// bodyOrBlob returns the body inline if small, else stores it content-addressed
// and returns a human-readable pointer.
func (t *Traffic) bodyOrBlob(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	if len(body) <= maxInlineBody {
		return string(body)
	}
	sum := sha256.Sum256(body)
	h := hex.EncodeToString(sum[:])
	blobDir := filepath.Join(t.dir, "_blobs", "sha256", h[:2], h[2:4])
	_ = os.MkdirAll(blobDir, 0o755)
	blobPath := filepath.Join(blobDir, h+".bin")
	if _, err := os.Stat(blobPath); os.IsNotExist(err) {
		_ = os.WriteFile(blobPath, body, 0o644)
	}
	return fmt.Sprintf("@blob sha256:%s (len=%d)", h, len(body))
}

func headerLines(h map[string][]string) string {
	var b strings.Builder
	for k, vs := range h {
		for _, v := range vs {
			b.WriteString(k)
			b.WriteString(": ")
			b.WriteString(v)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func sanitize(s string) string {
	r := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "?", "_", "*", "_", "\"", "_", "<", "_", ">", "_", "|", "_")
	out := r.Replace(s)
	if out == "" || out == "_" {
		return "root"
	}
	if len(out) > 120 {
		out = out[:120]
	}
	return out
}

// ExchangeMeta is one row of the index (returned by Search).
type ExchangeMeta struct {
	ID          string `json:"id"`
	TS          int64  `json:"ts"`
	Host        string `json:"host"`
	Method      string `json:"method"`
	URLTemplate string `json:"url_template"`
	URL         string `json:"url"`
	Status      int    `json:"status"`
	ContentType string `json:"content_type"`
	RespLen     int    `json:"resp_len"`
	Path        string `json:"path"`
}

// Search returns paged exchange metadata (never bodies).
func (t *Traffic) Search(host string, page, size int) ([]ExchangeMeta, error) {
	if size <= 0 || size > 500 {
		size = 100
	}
	q := `SELECT id,ts,host,method,url_template,url,status,content_type,resp_len,path FROM exchanges`
	args := []any{}
	if host != "" {
		q += ` WHERE host=?`
		args = append(args, host)
	}
	q += ` ORDER BY ts DESC LIMIT ? OFFSET ?`
	args = append(args, size, page*size)
	rows, err := t.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ExchangeMeta
	for rows.Next() {
		var m ExchangeMeta
		if err := rows.Scan(&m.ID, &m.TS, &m.Host, &m.Method, &m.URLTemplate, &m.URL, &m.Status, &m.ContentType, &m.RespLen, &m.Path); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Page returns one page of exchange metadata filtered by an optional host
// substring, exact method, and a free-text query q that fuzzy-matches across all
// indexed metadata columns (host/url/method/content-type/status), together with
// the total number of rows matching that filter (for the UI's pagination).
// Newest first. Bodies are never included.
// TrafficFilter 高级筛选条件。path/status/resp_len 走索引列；Body 走 FTS trigram
// 正文索引（请求+响应解码后内容，≥3 字）。
type TrafficFilter struct {
	Path      string // 路径关键词（path/url LIKE）
	StatusMin int    // 状态码区间下限（0=不限）
	StatusMax int    // 状态码区间上限
	RespMin   int    // 响应长度下限(字节，0=不限)
	RespMax   int    // 响应长度上限(字节，0=不限)
	Body      string // 正文关键词（请求/响应解码后全文，FTS trigram，≥3 字）
}

// fts5Quote wraps a user keyword as a literal FTS5 phrase ("…") with embedded
// double-quotes doubled, so special characters are matched literally (via trigram)
// instead of being parsed as FTS query syntax.
func fts5Quote(kw string) string {
	return `"` + strings.ReplaceAll(kw, `"`, `""`) + `"`
}

// bodyCond returns an SQL fragment + arg restricting to exchanges whose decoded
// request/response body matches the trigram keyword. ok=false when body search is
// unavailable (FTS disabled) or the keyword is shorter than the 3-char trigram
// minimum. Callers AND-join it into their WHERE.
func (t *Traffic) bodyCond(keyword string) (cond, arg string, ok bool) {
	kw := strings.TrimSpace(keyword)
	if !t.ftsOK || len([]rune(kw)) < 3 {
		return "", "", false
	}
	return "id IN (SELECT id FROM bodies WHERE bodies MATCH ?)", fts5Quote(kw), true
}

// BodyMatchSnippets returns id→highlighted snippet for the given page's exchange
// ids, showing WHERE the body keyword matched. Markers \x01/\x02 wrap the hit for
// the UI to render; empty map when body search isn't applicable.
func (t *Traffic) BodyMatchSnippets(ids []string, keyword string) map[string]string {
	out := map[string]string{}
	kw := strings.TrimSpace(keyword)
	if !t.ftsOK || len([]rune(kw)) < 3 || len(ids) == 0 {
		return out
	}
	ph := make([]string, len(ids))
	args := make([]any, 0, len(ids)+1)
	for i, id := range ids {
		ph[i] = "?"
		args = append(args, id)
	}
	args = append(args, fts5Quote(kw))
	// snippet(tbl, -1, open, close, ellipsis, maxTokens): -1 picks the best-matching
	// column (req or resp), so the excerpt comes from wherever the hit is.
	q := `SELECT id, snippet(bodies, -1, char(1), char(2), '…', 12) FROM bodies WHERE id IN (` +
		strings.Join(ph, ",") + `) AND bodies MATCH ?`
	rows, err := t.db.Query(q, args...)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id, snip string
		if rows.Scan(&id, &snip) == nil {
			out[id] = snip
		}
	}
	return out
}

// backfillBodies populates the trigram index for already-recorded exchanges.
// NEWEST first, so the traffic a user is actively working with becomes searchable
// within seconds while the long historical tail fills in behind it. Append-only and
// resumable across restarts (already-indexed ids are skipped), batched in
// transactions to stay fast and keep the write lock held only briefly per batch.
func (t *Traffic) backfillBodies() {
	if !t.ftsOK {
		return
	}
	rows, err := t.db.Query(`SELECT id, path FROM exchanges WHERE id NOT IN (SELECT id FROM bodies) ORDER BY ts DESC`)
	if err != nil {
		return
	}
	type row struct{ id, path string }
	var todo []row
	for rows.Next() {
		var r row
		if rows.Scan(&r.id, &r.path) == nil {
			todo = append(todo, r)
		}
	}
	rows.Close()
	if len(todo) == 0 {
		return
	}
	log.Printf("[traffic] 正文索引回填开始：%d 条（最新优先）", len(todo))
	const batch = 1000
	type ent struct{ id, req, resp string }
	done := 0
	for i := 0; i < len(todo); i += batch {
		end := i + batch
		if end > len(todo) {
			end = len(todo)
		}
		// Read + decode OUTSIDE the write lock — disk I/O (the slow part) must not
		// block live capture. Only the batched insert holds the lock, briefly.
		ents := make([]ent, 0, end-i)
		for _, r := range todo[i:end] {
			rb, _ := os.ReadFile(filepath.Join(t.dir, r.path, "request.http"))
			pb, _ := os.ReadFile(filepath.Join(t.dir, r.path, "response.http"))
			// Insert even when a body is empty, so the id is marked done and not
			// re-scanned next restart.
			ents = append(ents, ent{r.id, decodedBodyText(string(rb), maxIndexBody), decodedBodyText(string(pb), maxIndexBody)})
		}
		t.wmu.Lock()
		if tx, err := t.db.Begin(); err == nil {
			for _, e := range ents {
				_, _ = tx.Exec(`INSERT INTO bodies(id, req, resp) VALUES(?,?,?)`, e.id, e.req, e.resp)
			}
			_ = tx.Commit()
		}
		t.wmu.Unlock()
		done = end
		if done%20000 < batch {
			log.Printf("[traffic] 正文索引回填进度：%d / %d", done, len(todo))
		}
	}
	log.Printf("[traffic] 正文索引回填完成：%d 条", done)
}

// conds 把高级筛选编译成 SQL 条件片段 + 参数（按出现顺序一一对应 ? 占位）。
func (f TrafficFilter) conds() (parts []string, args []any) {
	if p := strings.TrimSpace(f.Path); p != "" {
		parts = append(parts, "(path LIKE ? OR url LIKE ?)")
		args = append(args, "%"+p+"%", "%"+p+"%")
	}
	if f.StatusMin > 0 && f.StatusMax >= f.StatusMin {
		parts = append(parts, "status BETWEEN ? AND ?")
		args = append(args, f.StatusMin, f.StatusMax)
	}
	if f.RespMin > 0 {
		parts = append(parts, "resp_len >= ?")
		args = append(args, f.RespMin)
	}
	if f.RespMax > 0 {
		parts = append(parts, "resp_len <= ?")
		args = append(args, f.RespMax)
	}
	return
}

func (t *Traffic) Page(host, method, q string, filter TrafficFilter, page, size int) (rows []ExchangeMeta, total int, err error) {
	if size <= 0 || size > 500 {
		size = 100
	}
	if page < 0 {
		page = 0
	}
	where := ""
	var args []any
	add := func(cond string, vs ...any) {
		if where == "" {
			where = " WHERE "
		} else {
			where += " AND "
		}
		where += cond
		args = append(args, vs...)
	}
	if h := strings.TrimSpace(host); h != "" {
		add("host LIKE ?", "%"+h+"%")
	}
	if m := strings.TrimSpace(method); m != "" {
		add("method=?", strings.ToUpper(m))
	}
	if s := strings.TrimSpace(q); s != "" {
		like := "%" + s + "%"
		// Fuzzy match across every indexed column (bodies aren't indexed).
		add("(host LIKE ? OR url LIKE ? OR url_template LIKE ? OR method LIKE ? OR content_type LIKE ? OR CAST(status AS TEXT) LIKE ?)",
			like, like, like, like, like, like)
	}
	if fp, fa := filter.conds(); len(fp) > 0 {
		for _, part := range fp {
			add(part)
		}
		args = append(args, fa...)
	}
	if cond, arg, ok := t.bodyCond(filter.Body); ok {
		add(cond, arg)
	}
	if err = t.db.QueryRow(`SELECT COUNT(*) FROM exchanges`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	sel := `SELECT id,ts,host,method,url_template,url,status,content_type,resp_len,path FROM exchanges` +
		where + ` ORDER BY ts DESC LIMIT ? OFFSET ?`
	qargs := append(append([]any{}, args...), size, page*size)
	rs, err := t.db.Query(sel, qargs...)
	if err != nil {
		return nil, 0, err
	}
	defer rs.Close()
	for rs.Next() {
		var m ExchangeMeta
		if err := rs.Scan(&m.ID, &m.TS, &m.Host, &m.Method, &m.URLTemplate, &m.URL, &m.Status, &m.ContentType, &m.RespLen, &m.Path); err != nil {
			return nil, 0, err
		}
		rows = append(rows, m)
	}
	return rows, total, rs.Err()
}

// MetaByIDs 按 exchange id 批量取元数据（供漏洞"关联流量"展示；报文正文仍按需另取）。
// 全参数化(? 占位)，保持传入顺序。
func (t *Traffic) MetaByIDs(ids []string) ([]ExchangeMeta, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i] = "?"
		args[i] = id
	}
	rs, err := t.db.Query(`SELECT id,ts,host,method,url_template,url,status,content_type,resp_len,path FROM exchanges WHERE id IN (`+strings.Join(ph, ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	byID := map[string]ExchangeMeta{}
	for rs.Next() {
		var m ExchangeMeta
		if err := rs.Scan(&m.ID, &m.TS, &m.Host, &m.Method, &m.URLTemplate, &m.URL, &m.Status, &m.ContentType, &m.RespLen, &m.Path); err != nil {
			return nil, err
		}
		byID[m.ID] = m
	}
	if err := rs.Err(); err != nil {
		return nil, err
	}
	out := make([]ExchangeMeta, 0, len(ids))
	for _, id := range ids {
		if m, ok := byID[id]; ok {
			out = append(out, m)
		}
	}
	return out, nil
}

// PageHosts is Page restricted to a set of hostnames (a task's asset hosts), so
// the task-agnostic MITM store can be scoped to one task/engagement. An empty
// hosts slice matches nothing (a task with no known hosts has no traffic).
// Newest first; bodies never included.
func (t *Traffic) PageHosts(hosts []string, method, q string, filter TrafficFilter, page, size int) (rows []ExchangeMeta, total int, err error) {
	if len(hosts) == 0 {
		return nil, 0, nil
	}
	if size <= 0 || size > 500 {
		size = 100
	}
	if page < 0 {
		page = 0
	}
	ph := make([]string, len(hosts))
	var args []any
	for i, h := range hosts {
		ph[i] = "?"
		args = append(args, strings.ToLower(strings.TrimSpace(h)))
	}
	where := " WHERE lower(host) IN (" + strings.Join(ph, ",") + ")"
	if m := strings.TrimSpace(method); m != "" {
		where += " AND method=?"
		args = append(args, strings.ToUpper(m))
	}
	if s := strings.TrimSpace(q); s != "" {
		like := "%" + s + "%"
		where += " AND (host LIKE ? OR url LIKE ? OR url_template LIKE ? OR method LIKE ? OR content_type LIKE ? OR CAST(status AS TEXT) LIKE ?)"
		args = append(args, like, like, like, like, like, like)
	}
	if fp, fa := filter.conds(); len(fp) > 0 {
		for _, part := range fp {
			where += " AND " + part
		}
		args = append(args, fa...)
	}
	if cond, arg, ok := t.bodyCond(filter.Body); ok {
		where += " AND " + cond
		args = append(args, arg)
	}
	if err = t.db.QueryRow(`SELECT COUNT(*) FROM exchanges`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	sel := `SELECT id,ts,host,method,url_template,url,status,content_type,resp_len,path FROM exchanges` +
		where + ` ORDER BY ts DESC LIMIT ? OFFSET ?`
	qargs := append(append([]any{}, args...), size, page*size)
	rs, err := t.db.Query(sel, qargs...)
	if err != nil {
		return nil, 0, err
	}
	defer rs.Close()
	for rs.Next() {
		var m ExchangeMeta
		if err := rs.Scan(&m.ID, &m.TS, &m.Host, &m.Method, &m.URLTemplate, &m.URL, &m.Status, &m.ContentType, &m.RespLen, &m.Path); err != nil {
			return nil, 0, err
		}
		rows = append(rows, m)
	}
	return rows, total, rs.Err()
}

// StatusCounts returns exchange counts grouped by status-code class (2/3/4/5 =
// 2xx/3xx/4xx/5xx) over the WHOLE store (not a 50-row page), so the dashboard's
// status distribution is accurate. hosts empty ⇒ all exchanges (global); non-empty
// ⇒ restricted to that host set (a task's asset hosts).
func (t *Traffic) StatusCounts(hosts []string) (map[int]int, error) {
	where := ""
	var args []any
	if len(hosts) > 0 {
		ph := make([]string, len(hosts))
		for i, h := range hosts {
			ph[i] = "?"
			args = append(args, strings.ToLower(strings.TrimSpace(h)))
		}
		where = " WHERE lower(host) IN (" + strings.Join(ph, ",") + ")"
	}
	rows, err := t.db.Query(`SELECT status/100 AS bucket, COUNT(*) FROM exchanges`+where+` GROUP BY bucket`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]int{}
	for rows.Next() {
		var b, n int
		if err := rows.Scan(&b, &n); err != nil {
			return nil, err
		}
		out[b] = n
	}
	return out, rows.Err()
}

// Get returns the full request/response of one exchange (reads from the tree).
// Bodies are stored exactly as they crossed the wire (faithful capture); if the
// server used Content-Encoding (gzip/br/deflate/zstd) the stored body is the
// compressed bytes, which render as garbage. We decode for VIEWING here — keeping
// the original headers intact (so the real server behavior shows) but turning the
// body into readable text, like Burp does. Benefits detail view, 截图模式, report
// enrichment and the traffic_get tool in one place.
func (t *Traffic) Get(id string) (req, resp string, err error) {
	var rel string
	if err = t.db.QueryRow(`SELECT path FROM exchanges WHERE id=?`, id).Scan(&rel); err != nil {
		return "", "", err
	}
	rb, _ := os.ReadFile(filepath.Join(t.dir, rel, "request.http"))
	pb, _ := os.ReadFile(filepath.Join(t.dir, rel, "response.http"))
	return decodeForView(string(rb)), decodeForView(string(pb)), nil
}

// decodeForView splits a stored "<head>\n\n<body>" exchange, and if the head
// declares a Content-Encoding, decompresses the body for human display. On any
// failure (no blank-line boundary, unsupported/truncated encoding, or a @blob
// pointer instead of inline bytes) it returns the text unchanged — never losing
// data. Decoding reuses go-mitmproxy's codec (gzip/br/deflate/zstd) so we don't
// re-implement or pull extra deps.
func decodeForView(raw string) string {
	head, body, ok := splitExchange(raw)
	if !ok {
		return raw
	}
	return head + "\n\n" + decodeBody(head, body)
}

// splitExchange splits a stored "<head>\n\n<body>" exchange. ok=false when there
// is no blank-line boundary, the body is empty, or it is a large-body "@blob …"
// pointer rather than inline bytes (nothing to decode or index in those cases).
func splitExchange(raw string) (head, body string, ok bool) {
	i := strings.Index(raw, "\n\n")
	if i < 0 {
		return "", "", false
	}
	head, body = raw[:i], raw[i+2:]
	if body == "" || strings.HasPrefix(body, "@blob ") {
		return head, body, false
	}
	return head, body, true
}

// decodeBody decompresses body per head's Content-Encoding (gzip/br/deflate/zstd),
// reusing go-mitmproxy's codec so we add no deps. Returns body unchanged on no /
// unknown encoding or decode failure — never losing data.
func decodeBody(head, body string) string {
	enc := ""
	for _, line := range strings.Split(head, "\n") {
		if k, v, ok := strings.Cut(line, ":"); ok && strings.EqualFold(strings.TrimSpace(k), "Content-Encoding") {
			enc = strings.TrimSpace(v)
			break
		}
	}
	if enc == "" || strings.EqualFold(enc, "identity") {
		return body
	}
	h := http.Header{}
	h.Set("Content-Encoding", enc)
	r := &mproxy.Response{Header: h, Body: []byte(body)}
	if dec, err := r.DecodedBody(); err == nil && dec != nil {
		return string(dec)
	}
	return body
}

// decodedBodyText returns just the decoded body portion of a stored exchange file,
// capped and sanitized to valid UTF-8 — the text fed into the full-text body index.
// Empty when there is no inline body (blob/none).
func decodedBodyText(raw string, max int) string {
	head, body, ok := splitExchange(raw)
	if !ok {
		return ""
	}
	return capStr(decodeBody(head, body), max)
}

// capStr truncates s to at most max bytes, keeping the result valid UTF-8 so the
// trigram tokenizer never chokes on a split multibyte rune.
func capStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return strings.ToValidUTF8(s[:max], "")
}

// ResolveStepExchange maps a reproduction step's verbatim request back to the one
// real recorded exchange it cites. method+path narrow to the endpoint; a verbatim
// body slice disambiguates same-endpoint requests via the trigram index (e.g. the
// probed username in username-enumeration). Returns ok=false and abstains rather
// than guessing when the match is ambiguous — a wrong evidence link is worse than
// none. The agent's verbatim request IS the designation; this resolves it.
func (t *Traffic) ResolveStepExchange(reqText string) (string, bool) {
	method, path, body := parseReqLine(reqText)
	if method == "" || path == "" {
		return "", false
	}
	where := "method=? AND url LIKE ?"
	args := []any{strings.ToUpper(method), "%" + path + "%"}
	usedBody := false
	if t.ftsOK {
		if phrase := bodyPhrase(body); phrase != "" {
			where += " AND id IN (SELECT id FROM bodies WHERE bodies MATCH ?)"
			args = append(args, fts5Quote(phrase))
			usedBody = true
		}
	}
	rows, err := t.db.Query(`SELECT id FROM exchanges WHERE `+where+` ORDER BY ts DESC LIMIT 2`, args...)
	if err != nil {
		return "", false
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	switch {
	case len(ids) == 1:
		return ids[0], true // unambiguous
	case len(ids) >= 2 && usedBody:
		return ids[0], true // body-disambiguated; newest of the exact-body matches
	default:
		return "", false // ambiguous without a body discriminator → abstain
	}
}

// parseReqLine extracts the method, url PATH (query stripped), and body from a
// verbatim request text ("METHOD /path?q PROTO\n<headers>\n\n<body>").
func parseReqLine(raw string) (method, path, body string) {
	first := raw
	if nl := strings.IndexByte(raw, '\n'); nl >= 0 {
		first = raw[:nl]
	}
	if parts := strings.Fields(strings.TrimSpace(first)); len(parts) >= 2 {
		method = parts[0]
		target := parts[1]
		if i := strings.IndexByte(target, '?'); i >= 0 {
			path = target[:i]
		} else {
			path = target
		}
	}
	if i := strings.Index(raw, "\n\n"); i >= 0 {
		body = raw[i+2:]
	}
	return
}

// bodyPhrase returns a verbatim leading slice of the body to use as the trigram
// disambiguator (empty when too short for trigram). Capped so the FTS phrase stays
// cheap while still covering the discriminating value (usually early in the body).
func bodyPhrase(body string) string {
	b := strings.TrimSpace(body)
	r := []rune(b)
	if len(r) < 3 {
		return ""
	}
	if len(r) > 400 {
		r = r[:400]
	}
	return string(r)
}

// Count returns total recorded exchanges.
func (t *Traffic) Count() (int, error) {
	var n int
	err := t.db.QueryRow(`SELECT COUNT(*) FROM exchanges`).Scan(&n)
	return n, err
}

// query returns one page of exchange metadata filtered by host and/or a url
// substring. Default page size is intentionally small (3) to keep tool results
// lightweight and capped at 10; page is 0-based (page*limit offset).
func (t *Traffic) query(host, contains string, page, limit int) ([]ExchangeMeta, error) {
	if limit <= 0 {
		limit = 3
	}
	if limit > 10 {
		limit = 10
	}
	if page < 0 {
		page = 0
	}
	q := `SELECT id,ts,host,method,url_template,url,status,content_type,resp_len,path FROM exchanges WHERE 1=1`
	args := []any{}
	if host != "" {
		q += ` AND host=?`
		args = append(args, host)
	}
	if contains != "" {
		q += ` AND (url LIKE ? OR url_template LIKE ?)`
		args = append(args, "%"+contains+"%", "%"+contains+"%")
	}
	q += ` ORDER BY ts DESC LIMIT ? OFFSET ?`
	args = append(args, limit, page*limit)
	rows, err := t.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ExchangeMeta
	for rows.Next() {
		var m ExchangeMeta
		if err := rows.Scan(&m.ID, &m.TS, &m.Host, &m.Method, &m.URLTemplate, &m.URL, &m.Status, &m.ContentType, &m.RespLen, &m.Path); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Tools exposes traffic lookup to work agents so they query already-captured
// traffic instead of re-curling the same resource (token + dedup win).
func (t *Traffic) Tools() []actool.CoreTool {
	allow := func(context.Context, json.RawMessage, permission.Context) permission.Decision {
		return permission.Allowed()
	}
	ro := func(json.RawMessage) bool { return true }

	search := actool.Build(actool.Spec{
		Name:        "traffic_search",
		Description: "查询记录代理已抓取的目标流量（必须指定 host，可再按 URL 子串过滤）。仅返回极轻量索引(id/method/url/status/resp_len)，不含任何响应内容。默认只返回 3 条、每页最多 10 条；结果多时用 page 翻页（page=0 起）；要看某条的请求/响应原文用 traffic_get(id)。回看已访问资源、找端点先用它，避免重复 curl 同一 URL。",
		Schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"host":     map[string]any{"type": "string", "description": "按主机过滤（必填，如 '192.168.1.100:8082'）"},
				"contains": map[string]any{"type": "string", "description": "URL 子串过滤（可选，如 'api' / 'login'）"},
				"limit":    map[string]any{"type": "integer", "description": "每页条数，默认 3，最大 10"},
				"page":     map[string]any{"type": "integer", "description": "页码，从 0 开始，默认 0（按 ts 倒序分页）"},
			},
			"required": []any{"host"},
		},
		ReadOnly:    ro,
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var a struct {
				Host, Contains string
				Limit          int
				Page           int
			}
			_ = json.Unmarshal(in, &a)
			if strings.TrimSpace(a.Host) == "" {
				return actool.Errorf("host 为必填参数：请指定要查询的主机（如 '192.168.1.100:8082'），避免全库扫描。"), nil
			}
			rows, err := t.query(a.Host, a.Contains, a.Page, a.Limit)
			if err != nil {
				return actool.Errorf(err.Error()), nil
			}
			if len(rows) == 0 {
				return actool.Text("无匹配流量。"), nil
			}
			// 精简为最小索引：仅保留定位所需字段 + 响应码/长度，不带任何响应内容。
			type liteRow struct {
				ID      string `json:"id"`
				Method  string `json:"method"`
				URL     string `json:"url"`
				Status  int    `json:"status"`
				RespLen int    `json:"resp_len"`
			}
			lite := make([]liteRow, 0, len(rows))
			for _, r := range rows {
				lite = append(lite, liteRow{ID: r.ID, Method: r.Method, URL: r.URL, Status: r.Status, RespLen: r.RespLen})
			}
			b, _ := json.Marshal(lite)
			return actool.Text(string(b)), nil
		},
	})

	get := actool.Build(actool.Spec{
		Name:        "traffic_get",
		Description: "按 id 取一条已抓流量的请求/响应原文（过大会截断）。配合 traffic_search 用，避免重复 curl。",
		Schema: map[string]any{
			"type":       "object",
			"properties": map[string]any{"id": map[string]any{"type": "string", "description": "traffic_search 返回的 id"}},
			"required":   []any{"id"},
		},
		ReadOnly:    ro,
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var a struct{ ID string }
			_ = json.Unmarshal(in, &a)
			req, resp, err := t.Get(a.ID)
			if err != nil {
				return actool.Errorf(err.Error()), nil
			}
			return actool.Text("=== REQUEST ===\n" + clip(req, 2500) + "\n\n=== RESPONSE ===\n" + clip(resp, 4000)), nil
		},
	})
	return []actool.CoreTool{search, get}
}

// SeedToolMetas returns the traffic tools built on a ZERO receiver, for seeding the
// tools catalog (metadata only — Name/Description/InputSchema). The handlers close
// over the nil receiver but are never invoked on this instance, so it is safe.
func SeedToolMetas() []actool.CoreTool { return (&Traffic{}).Tools() }

func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + fmt.Sprintf("\n... [截断，共 %d 字节；完整在流量文件树] ...", len(s))
}
