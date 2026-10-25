package traffic

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// newTestTraffic spins up a Traffic backed by a temp sqlite with both the metadata
// index and the trigram body index, no proxy.
func newTestTraffic(t *testing.T) *Traffic {
	t.Helper()
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "idx.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{indexSchema, bodyFTSSchema} {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("schema: %v", err)
		}
	}
	tr := &Traffic{dir: dir, db: db, ftsOK: true}
	t.Cleanup(func() { db.Close() })
	return tr
}

func insertExchange(t *testing.T, tr *Traffic, id, method, url, reqBody, respBody string) {
	t.Helper()
	_, err := tr.db.Exec(`INSERT INTO exchanges(id,ts,host,method,url_template,url,status,content_type,req_len,resp_len,path)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		id, 1, "h", method, "/t", url, 200, "application/json", len(reqBody), len(respBody), id)
	if err != nil {
		t.Fatal(err)
	}
	tr.indexBody(id, reqBody, respBody)
}

func pageIDs(t *testing.T, tr *Traffic, f TrafficFilter) []string {
	t.Helper()
	rows, _, err := tr.Page("", "", "", f, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	return ids
}

func TestBodySearch(t *testing.T) {
	tr := newTestTraffic(t)
	// Two same-path enum requests differing only by the username in the BODY (the
	// exact disambiguation case that metadata filters can't resolve), plus an unrelated one.
	insertExchange(t, tr, "1-0001", "POST", "https://h/api/users/authenticate",
		`{"username":"qqwwzz124","loginMethod":"E"}`, `{"body":"ANF"}`)
	insertExchange(t, tr, "1-0002", "POST", "https://h/api/users/authenticate",
		`{"username":"taiman","loginMethod":"E"}`, `{"body":"N"}`)
	insertExchange(t, tr, "1-0003", "GET", "https://h/other",
		`nothing here`, `账号不存在 account not found`)

	// Body keyword in REQUEST pins the exact enum request.
	if got := pageIDs(t, tr, TrafficFilter{Body: "qqwwzz124"}); len(got) != 1 || got[0] != "1-0001" {
		t.Fatalf("req body search: want [1-0001], got %v", got)
	}
	// Body keyword in RESPONSE (we search both req+resp — beats response-only).
	if got := pageIDs(t, tr, TrafficFilter{Body: "ANF"}); len(got) != 1 || got[0] != "1-0001" {
		t.Fatalf("resp body search: want [1-0001], got %v", got)
	}
	// CJK substring search (trigram).
	if got := pageIDs(t, tr, TrafficFilter{Body: "不存在"}); len(got) != 1 || got[0] != "1-0003" {
		t.Fatalf("cjk body search: want [1-0003], got %v", got)
	}
	// < 3 chars: body filter is skipped (not applicable) → all rows returned.
	if got := pageIDs(t, tr, TrafficFilter{Body: "ab"}); len(got) != 3 {
		t.Fatalf("short keyword should not filter: got %v", got)
	}
	// Snippet highlights the hit with the \x01/\x02 markers around the keyword.
	snips := tr.BodyMatchSnippets([]string{"1-0001"}, "qqwwzz124")
	s := snips["1-0001"]
	if !strings.Contains(s, "\x01") || !strings.Contains(s, "qqwwzz124") {
		t.Fatalf("snippet should highlight keyword, got %q", s)
	}
}

func TestResolveStepExchange(t *testing.T) {
	tr := newTestTraffic(t)
	// Same endpoint, three enum attempts differing only by the username in the body.
	insertExchange(t, tr, "1-0001", "POST", "https://h/api/users/authenticate",
		`{"username":"qqwwzz124","captchaAnswer":"95284","loginMethod":"E"}`, `{"body":"ANF"}`)
	insertExchange(t, tr, "1-0002", "POST", "https://h/api/users/authenticate",
		`{"username":"taiman","captchaAnswer":"11111","loginMethod":"E"}`, `{"body":"N"}`)
	insertExchange(t, tr, "1-0003", "POST", "https://h/api/users/authenticate",
		`{"username":"user","captchaAnswer":"22222","loginMethod":"E"}`, `{"body":"L5"}`)

	// A verbatim step request (with query string + headers + body) resolves to the
	// ONE exchange whose body carries that username — not the other same-path requests.
	step := "POST /api/users/authenticate?language=zh_HK HTTP/1.1\n" +
		"Host: h\nContent-Type: application/json\n\n" +
		`{"username":"qqwwzz124","captchaAnswer":"95284","loginMethod":"E"}`
	if id, ok := tr.ResolveStepExchange(step, ""); !ok || id != "1-0001" {
		t.Fatalf("resolve by body: want 1-0001/true, got %q/%v", id, ok)
	}

	// Same endpoint, no distinguishing body → ambiguous → abstain (no wrong link).
	bare := "POST /api/users/authenticate HTTP/1.1\nHost: h\n\n"
	if id, ok := tr.ResolveStepExchange(bare, ""); ok {
		t.Fatalf("ambiguous (no body) should abstain, got %q", id)
	}

	// Unique endpoint resolves even without a body.
	insertExchange(t, tr, "1-0009", "GET", "https://h/admin/config.json", ``, `{"secret":"x"}`)
	if id, ok := tr.ResolveStepExchange("GET /admin/config.json HTTP/1.1\nHost: h\n\n", ""); !ok || id != "1-0009" {
		t.Fatalf("unique endpoint: want 1-0009/true, got %q/%v", id, ok)
	}
}

func TestResolveStepExchangeFromCurl(t *testing.T) {
	tr := newTestTraffic(t)
	// Two uploads to the SAME endpoint, differing only by the uploaded filename in the
	// multipart body — the ambiguity real fuzzing creates (many POSTs to one upload URL).
	insertExchange(t, tr, "2-0001", "POST", "http://h/upload.php",
		`Content-Disposition: form-data; name="avatar"; filename="probe_alpha.bin"\n\nAAA`, `{"ok":true,"path":"/uploads/probe_alpha.bin"}`)
	insertExchange(t, tr, "2-0002", "POST", "http://h/upload.php",
		`Content-Disposition: form-data; name="avatar"; filename="probe_beta.bin"\n\nBBB`, `{"ok":true,"path":"/uploads/probe_beta.bin"}`)
	insertExchange(t, tr, "2-0003", "GET", "http://h/uploads/probe_alpha.bin", ``, `AAA`)

	// Step recorded as the SHELL COMMAND the agent ran resolves to the exact upload via
	// the filename discriminator — not the other same-endpoint upload.
	cmd1 := `printf 'AAA' > f.bin; curl -s -F "avatar=@f.bin;filename=probe_alpha.bin;type=image/png" http://h/upload.php`
	if id, ok := tr.ResolveStepExchange(cmd1, ""); !ok || id != "2-0001" {
		t.Fatalf("curl upload resolve: want 2-0001/true, got %q/%v", id, ok)
	}
	// A curl GET command resolves by method+path (unique).
	if id, ok := tr.ResolveStepExchange(`curl -s "http://h/uploads/probe_alpha.bin"`, ""); !ok || id != "2-0003" {
		t.Fatalf("curl GET resolve: want 2-0003/true, got %q/%v", id, ok)
	}
	// A raw HTTP packet still resolves (regression over the format change).
	raw := "POST /upload.php HTTP/1.1\nHost: h\n\n" + `Content-Disposition: form-data; name="avatar"; filename="probe_beta.bin"\n\nBBB`
	if id, ok := tr.ResolveStepExchange(raw, ""); !ok || id != "2-0002" {
		t.Fatalf("raw packet resolve: want 2-0002/true, got %q/%v", id, ok)
	}
}

func TestResolveStepByResponse(t *testing.T) {
	tr := newTestTraffic(t)
	// Same GET made twice: first 200 with output, then 404 (target cleaned up). The
	// request alone is ambiguous; the step's verbatim RESPONSE picks the 200.
	insertExchange(t, tr, "3-0001", "GET", "http://h/status.php?q=1", ``, `OK:ready`)
	insertExchange(t, tr, "3-0002", "GET", "http://h/status.php?q=1", ``, `Not Found`)
	cmd := `curl -s "http://h/status.php?q=1"`
	if id, ok := tr.ResolveStepExchange(cmd, `OK:ready`); !ok || id != "3-0001" {
		t.Fatalf("response tie-break: want 3-0001/true, got %q/%v", id, ok)
	}
	// Ambiguous request + a prose response that matches neither → abstain (no guess).
	if id, ok := tr.ResolveStepExchange(cmd, "HTTP 200 ... 成功 ..."); ok {
		t.Fatalf("ambiguous + non-matching response should abstain, got %q", id)
	}
}

func TestResolveSteps(t *testing.T) {
	tr := newTestTraffic(t)
	// A task's traffic window [100, 200]. Reconstruct the file-upload finding shape:
	// many identical GET /upload.php (the form page), then the distinct POST upload,
	// then the GET of the uploaded file — the exact scenario where view-time content matching fails
	// (identical GETs) but time+order succeeds.
	ins := func(id string, ts int64, method, url, reqB, respB string) {
		t.Helper()
		if _, err := tr.db.Exec(`INSERT INTO exchanges(id,ts,host,method,url_template,url,status,content_type,req_len,resp_len,path)
			VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
			id, ts, "h", method, "/t", url, 200, "text/html", len(reqB), len(respB), id); err != nil {
			t.Fatal(err)
		}
		tr.indexBody(id, reqB, respB)
	}
	// step1 candidate pool: three identical "GET /upload.php" (form page), ts 110/120/130.
	ins("g1", 110, "GET", "http://h/upload.php", "", "<form action=/upload.php enctype=multipart/form-data>")
	ins("g2", 120, "GET", "http://h/upload.php", "", "<form action=/upload.php enctype=multipart/form-data>")
	ins("g3", 130, "GET", "http://h/upload.php", "", "<form action=/upload.php enctype=multipart/form-data>")
	// step2: the distinct POST upload (filename discriminator), ts 140.
	ins("p1", 140, "POST", "http://h/upload.php", "Content-Disposition: form-data; name=\"avatar\"; filename=\"avatar.png\"", "<div>头像上传成功</div>")
	// step3: exec GET, ts 150.
	ins("e1", 150, "GET", "http://h/uploads/avatar.png", "", "OK")

	steps := []StepRef{
		{Request: "GET /upload.php HTTP/1.1\nHost: h\n\n", Response: "HTTP/1.1 200 OK\n\n<form action=/upload.php enctype=multipart/form-data>"},
		{Request: "POST /upload.php HTTP/1.1\nContent-Type: multipart/form-data; boundary=----B\n\n------B\nContent-Disposition: form-data; name=\"avatar\"; filename=\"avatar.png\"\n\nAAA\n------B--\n", Response: "HTTP/1.1 200 OK\n\n<div>头像上传成功</div>"},
		{Request: "GET /uploads/avatar.png HTTP/1.1\nHost: h\n\n", Response: "HTTP/1.1 200 OK\n\nOK"},
	}
	ids := tr.ResolveSteps(100, 200, steps)
	// step1 → earliest GET (g1); step2 → the filename-matching POST (p1); step3 → exec (e1).
	want := []string{"g1", "p1", "e1"}
	for i, w := range want {
		if ids[i] != w {
			t.Errorf("step%d: want %s, got %q", i+1, w, ids[i])
		}
	}
	// A step whose endpoint isn't in the window resolves to "".
	ids2 := tr.ResolveSteps(100, 200, []StepRef{{Request: "GET /nope HTTP/1.1\n\n", Response: ""}})
	if ids2[0] != "" {
		t.Errorf("out-of-window endpoint should resolve empty, got %q", ids2[0])
	}
}

func TestBackfillBodies(t *testing.T) {
	tr := newTestTraffic(t)
	// Simulate pre-existing captures on disk (not yet in the body index), including a
	// gzip-encoded response so backfill decodes before indexing.
	exDir := filepath.Join(tr.dir, "ex1")
	if err := os.MkdirAll(exDir, 0o755); err != nil {
		t.Fatal(err)
	}
	reqRaw := "POST /authenticate HTTP/1.1\nHost: h\nContent-Type: application/json\n\n" + `{"username":"zzz999"}`
	respRaw := "HTTP 200\nContent-Encoding: gzip\nContent-Type: application/json\n\n" + string(gzipBytes(`{"body":"ANF"}`))
	os.WriteFile(filepath.Join(exDir, "request.http"), []byte(reqRaw), 0o644)
	os.WriteFile(filepath.Join(exDir, "response.http"), []byte(respRaw), 0o644)
	if _, err := tr.db.Exec(`INSERT INTO exchanges(id,ts,host,method,url_template,url,status,content_type,req_len,resp_len,path)
		VALUES('ex1',1,'h','POST','/t','https://h/authenticate',200,'application/json',10,10,'ex1')`); err != nil {
		t.Fatal(err)
	}

	tr.backfillBodies()

	// Request body indexed.
	if got := pageIDs(t, tr, TrafficFilter{Body: "zzz999"}); len(got) != 1 || got[0] != "ex1" {
		t.Fatalf("backfill req: want [ex1], got %v", got)
	}
	// gzip response DECODED then indexed — searchable by its plaintext content.
	if got := pageIDs(t, tr, TrafficFilter{Body: "ANF"}); len(got) != 1 || got[0] != "ex1" {
		t.Fatalf("backfill decoded resp: want [ex1], got %v", got)
	}
	// Re-running backfill is idempotent (id already indexed → skipped, no dup rows).
	tr.backfillBodies()
	if got := pageIDs(t, tr, TrafficFilter{Body: "zzz999"}); len(got) != 1 {
		t.Fatalf("backfill not idempotent: got %v", got)
	}
}
