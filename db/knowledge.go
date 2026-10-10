package db

// Knowledge base (two-layer RAG): global library + per-task library.
// Docs live in knowledge_docs (scope=global|task). Semantic search adds
// knowledge_chunks (pgvector, created best-effort by ensureKnowledgeVectorSchema);
// when pgvector is absent everything degrades to keyword (ILIKE) search over docs.

import (
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type KnowledgeDoc struct {
	ID        int64     `json:"id"`
	Scope     string    `json:"scope"` // global | task
	TaskID    *int64    `json:"task_id,omitempty"`
	Category  string    `json:"category"`
	Title     string    `json:"title"`
	Content   string    `json:"content,omitempty"` // omitted in list views
	Source    string    `json:"source"`            // manual | upload | migrated
	FileName  string    `json:"file_name,omitempty"`
	Bytes     int64     `json:"bytes"`
	Indexed   bool      `json:"indexed"`
	Chunks    int       `json:"chunks"` // vector chunk count (computed, 0 if keyword-only)
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// KnowledgeConfig is the singleton OpenAI-compatible embedder config.
type KnowledgeConfig struct {
	Enabled bool   `json:"enabled"`
	BaseURL string `json:"base_url"`
	Model   string `json:"model"`
	APIKey  string `json:"-"` // never serialized to the UI
	HasKey  bool   `json:"has_key"`
	Dim     int    `json:"dim"`
}

// KnowledgeHit is one retrieved chunk (or doc, in keyword mode).
type KnowledgeHit struct {
	DocID    int64   `json:"doc_id"`
	Title    string  `json:"title"`
	Category string  `json:"category"`
	Scope    string  `json:"scope"`
	Content  string  `json:"content"` // the matching chunk (or doc excerpt)
	Score    float64 `json:"score"`   // cosine similarity (semantic) or lexical rank
}

// KnowledgeChunkInsert is one chunk + its embedding to persist.
type KnowledgeChunkInsert struct {
	Index     int
	Content   string
	Embedding []float32
}

type KnowledgeRetrievalLog struct {
	ID        int64     `json:"id"`
	TaskID    *int64    `json:"task_id,omitempty"`
	AgentKey  string    `json:"agent_key"`
	Query     string    `json:"query"`
	Scope     string    `json:"scope"`
	Mode      string    `json:"mode"`
	TopK      int       `json:"top_k"`
	Hits      int       `json:"hits"`
	CreatedAt time.Time `json:"created_at"`
}

// KnowledgeVectorAvailable reports whether the pgvector semantic layer exists.
func (d *DB) KnowledgeVectorAvailable() bool { return d.GetBool("knowledge.vector_available", false) }

// ---------- embedder config ----------

func (d *DB) GetKnowledgeConfig() (*KnowledgeConfig, error) {
	var c KnowledgeConfig
	err := d.QueryRow(`SELECT enabled, base_url, model, COALESCE(api_key,''), dim FROM knowledge_config WHERE id=1`).
		Scan(&c.Enabled, &c.BaseURL, &c.Model, &c.APIKey, &c.Dim)
	if err == sql.ErrNoRows {
		return &KnowledgeConfig{BaseURL: "https://open.bigmodel.cn/api/paas/v4", Model: "embedding-3", Dim: 1024}, nil
	}
	if err != nil {
		return nil, err
	}
	c.HasKey = strings.TrimSpace(c.APIKey) != ""
	return &c, nil
}

// SaveKnowledgeConfig upserts the embedder config. Empty apiKey keeps the existing key.
func (d *DB) SaveKnowledgeConfig(enabled bool, baseURL, model, apiKey string, dim int) error {
	if dim <= 0 {
		dim = 1024
	}
	if strings.TrimSpace(apiKey) == "" {
		_, err := d.Exec(`UPDATE knowledge_config SET enabled=$1, base_url=$2, model=$3, dim=$4, updated_at=now() WHERE id=1`,
			enabled, baseURL, model, dim)
		return err
	}
	_, err := d.Exec(`UPDATE knowledge_config SET enabled=$1, base_url=$2, model=$3, api_key=$4, dim=$5, updated_at=now() WHERE id=1`,
		enabled, baseURL, model, apiKey, dim)
	return err
}

// AdoptKnowledgeKeyFromProfile copies an LLM profile's api_key into knowledge_config
// when the embedder has no key yet — convenience for reusing a configured provider
// (e.g. a 智谱 profile) as the embedder. No-op if a key is already set or the
// profile has none. Returns whether a key was adopted.
func (d *DB) AdoptKnowledgeKeyFromProfile(profileID int64) (bool, error) {
	var res sql.Result
	res, err := d.Exec(`UPDATE knowledge_config
		SET api_key = p.api_key, updated_at = now()
		FROM llm_profiles p
		WHERE knowledge_config.id = 1
		  AND COALESCE(knowledge_config.api_key,'') = ''
		  AND p.id = $1 AND COALESCE(p.api_key,'') <> ''`, profileID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ---------- documents ----------

func (d *DB) AddKnowledgeDoc(doc *KnowledgeDoc) (int64, error) {
	scope := "global"
	var tid *int64
	if doc.Scope == "task" && doc.TaskID != nil && *doc.TaskID > 0 {
		scope, tid = "task", doc.TaskID
	}
	source := doc.Source
	if source == "" {
		source = "manual"
	}
	bytes := doc.Bytes
	if bytes == 0 {
		bytes = int64(len(doc.Content))
	}
	var id int64
	err := d.QueryRow(`INSERT INTO knowledge_docs (scope, task_id, category, title, content, source, file_name, bytes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		scope, tid, strings.TrimSpace(doc.Category), strings.TrimSpace(doc.Title), doc.Content, source, doc.FileName, bytes).Scan(&id)
	return id, err
}

func (d *DB) UpdateKnowledgeDoc(id int64, category, title, content string) error {
	_, err := d.Exec(`UPDATE knowledge_docs SET category=$2, title=$3, content=$4, bytes=$5, indexed=false, updated_at=now() WHERE id=$1`,
		id, strings.TrimSpace(category), strings.TrimSpace(title), content, int64(len(content)))
	return err
}

func (d *DB) GetKnowledgeDoc(id int64) (*KnowledgeDoc, error) {
	var doc KnowledgeDoc
	var tid sql.NullInt64
	err := d.QueryRow(`SELECT id, scope, task_id, category, title, content, source, file_name, bytes, indexed, created_at, updated_at
		FROM knowledge_docs WHERE id=$1`, id).
		Scan(&doc.ID, &doc.Scope, &tid, &doc.Category, &doc.Title, &doc.Content, &doc.Source, &doc.FileName, &doc.Bytes, &doc.Indexed, &doc.CreatedAt, &doc.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if tid.Valid {
		v := tid.Int64
		doc.TaskID = &v
	}
	return &doc, nil
}

// ListKnowledgeDocs returns docs for a scope. scope="global" → global only;
// scope="task"+taskID → that task only; taskID>0 with empty scope → global + that
// task (what an agent sees); otherwise all. Content is omitted (use GetKnowledgeDoc).
func (d *DB) ListKnowledgeDocs(scope string, taskID int64) ([]*KnowledgeDoc, error) {
	var where string
	var args []any
	switch {
	case scope == "global":
		where = "WHERE scope='global'"
	case scope == "task" && taskID > 0:
		where = "WHERE scope='task' AND task_id=$1"
		args = append(args, taskID)
	case taskID > 0:
		where = "WHERE scope='global' OR (scope='task' AND task_id=$1)"
		args = append(args, taskID)
	}
	q := `SELECT id, scope, task_id, category, title, source, file_name, bytes, indexed, created_at, updated_at
		FROM knowledge_docs ` + where + ` ORDER BY scope, category, created_at DESC`
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*KnowledgeDoc{}
	for rows.Next() {
		var doc KnowledgeDoc
		var tid sql.NullInt64
		if err := rows.Scan(&doc.ID, &doc.Scope, &tid, &doc.Category, &doc.Title, &doc.Source, &doc.FileName, &doc.Bytes, &doc.Indexed, &doc.CreatedAt, &doc.UpdatedAt); err != nil {
			return nil, err
		}
		if tid.Valid {
			v := tid.Int64
			doc.TaskID = &v
		}
		out = append(out, &doc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Attach vector-chunk counts (best-effort; only when the semantic layer exists).
	if d.KnowledgeVectorAvailable() && len(out) > 0 {
		if cr, e := d.Query(`SELECT doc_id, count(*) FROM knowledge_chunks GROUP BY doc_id`); e == nil {
			counts := map[int64]int{}
			for cr.Next() {
				var id int64
				var n int
				if cr.Scan(&id, &n) == nil {
					counts[id] = n
				}
			}
			cr.Close()
			for _, doc := range out {
				doc.Chunks = counts[doc.ID]
			}
		}
	}
	return out, nil
}

func (d *DB) DeleteKnowledgeDoc(id int64) error {
	_, err := d.Exec(`DELETE FROM knowledge_docs WHERE id=$1`, id) // chunks cascade
	return err
}

// ListKnowledgeCategories returns distinct non-empty categories for the scope an
// agent/user can see (global always; + the given task when taskID>0).
func (d *DB) ListKnowledgeCategories(taskID int64) ([]string, error) {
	q := `SELECT DISTINCT category FROM knowledge_docs WHERE category<>'' AND (scope='global'`
	var args []any
	if taskID > 0 {
		q += ` OR (scope='task' AND task_id=$1)`
		args = append(args, taskID)
	}
	q += `) ORDER BY category`
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// KnowledgeDocCount returns total docs (for the stats/empty-state UI).
func (d *DB) KnowledgeDocCount() (global int, task int, err error) {
	err = d.QueryRow(`SELECT
		count(*) FILTER (WHERE scope='global'),
		count(*) FILTER (WHERE scope='task') FROM knowledge_docs`).Scan(&global, &task)
	return
}

// ---------- chunks (semantic layer) ----------

// ReplaceKnowledgeChunks re-indexes a doc: deletes its old chunks and inserts the
// new ones with embeddings, marking the doc indexed. Requires the vector layer.
func (d *DB) ReplaceKnowledgeChunks(docID int64, model string, dim int, chunks []KnowledgeChunkInsert) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM knowledge_chunks WHERE doc_id=$1`, docID); err != nil {
		return err
	}
	for _, c := range chunks {
		if _, err := tx.Exec(`INSERT INTO knowledge_chunks (doc_id, chunk_index, content, embedding, embed_model, embed_dim)
			VALUES ($1,$2,$3,$4::vector,$5,$6)`,
			docID, c.Index, c.Content, vecLiteral(c.Embedding), model, dim); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE knowledge_docs SET indexed=true, updated_at=now() WHERE id=$1`, docID); err != nil {
		return err
	}
	return tx.Commit()
}

// ClearKnowledgeChunks removes all chunks + marks all docs unindexed (reindex reset).
func (d *DB) ClearKnowledgeChunks() error {
	if !d.KnowledgeVectorAvailable() {
		return nil
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`TRUNCATE knowledge_chunks`); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE knowledge_docs SET indexed=false`); err != nil {
		return err
	}
	return tx.Commit()
}

// SearchKnowledgeVector runs cosine similarity over chunks embedded with the given
// model (rows from other models/dims are skipped — the model-swap safety valve),
// scoped to global + the given task. Returns hits sorted by similarity desc.
func (d *DB) SearchKnowledgeVector(queryVec []float32, model string, taskID int64, topK int) ([]KnowledgeHit, error) {
	if topK <= 0 {
		topK = 5
	}
	scopeClause := "(dc.scope='global'"
	args := []any{vecLiteral(queryVec), model}
	if taskID > 0 {
		scopeClause += " OR (dc.scope='task' AND dc.task_id=$3)"
		args = append(args, taskID)
	}
	scopeClause += ")"
	q := `SELECT dc.id, dc.title, dc.category, dc.scope, kc.content,
		1 - (kc.embedding <=> $1::vector) AS score
		FROM knowledge_chunks kc JOIN knowledge_docs dc ON dc.id = kc.doc_id
		WHERE kc.embed_model = $2 AND ` + scopeClause + `
		ORDER BY kc.embedding <=> $1::vector
		LIMIT ` + strconv.Itoa(topK)
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanKnowledgeHits(rows)
}

// SearchKnowledgeKeyword is the no-embedder fallback: ILIKE over title/content/
// category, scoped to global + the given task. Returns doc excerpts.
func (d *DB) SearchKnowledgeKeyword(query string, taskID int64, topK int) ([]KnowledgeHit, error) {
	if topK <= 0 {
		topK = 5
	}
	like := "%" + strings.TrimSpace(query) + "%"
	scopeClause := "(scope='global'"
	args := []any{like}
	if taskID > 0 {
		scopeClause += " OR (scope='task' AND task_id=$2)"
		args = append(args, taskID)
	}
	scopeClause += ")"
	q := `SELECT id, title, category, scope, LEFT(content, 1200) AS content,
		(CASE WHEN title ILIKE $1 THEN 1.0 WHEN category ILIKE $1 THEN 0.8 ELSE 0.5 END) AS score
		FROM knowledge_docs
		WHERE (title ILIKE $1 OR content ILIKE $1 OR category ILIKE $1) AND ` + scopeClause + `
		ORDER BY score DESC, updated_at DESC
		LIMIT ` + strconv.Itoa(topK)
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanKnowledgeHits(rows)
}

func scanKnowledgeHits(rows *sql.Rows) ([]KnowledgeHit, error) {
	out := []KnowledgeHit{}
	for rows.Next() {
		var h KnowledgeHit
		if err := rows.Scan(&h.DocID, &h.Title, &h.Category, &h.Scope, &h.Content, &h.Score); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// ---------- retrieval logs ----------

func (d *DB) AddKnowledgeRetrievalLog(taskID int64, agentKey, query, scope, mode string, topK, hits int, docIDs []int64) {
	var tid *int64
	if taskID > 0 {
		tid = &taskID
	}
	ids := make([]string, 0, len(docIDs))
	for _, id := range docIDs {
		ids = append(ids, strconv.FormatInt(id, 10))
	}
	arrLit := "{" + strings.Join(ids, ",") + "}" // ints only — safe to inline
	_, _ = d.Exec(`INSERT INTO knowledge_retrieval_logs (task_id, agent_key, query, scope, mode, top_k, hits, doc_ids)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8::bigint[])`, tid, agentKey, query, scope, mode, topK, hits, arrLit)
}

func (d *DB) ListKnowledgeRetrievalLogs(limit int) ([]*KnowledgeRetrievalLog, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := d.Query(`SELECT id, task_id, agent_key, query, scope, mode, top_k, hits, created_at
		FROM knowledge_retrieval_logs ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*KnowledgeRetrievalLog{}
	for rows.Next() {
		var l KnowledgeRetrievalLog
		var tid sql.NullInt64
		if err := rows.Scan(&l.ID, &tid, &l.AgentKey, &l.Query, &l.Scope, &l.Mode, &l.TopK, &l.Hits, &l.CreatedAt); err != nil {
			return nil, err
		}
		if tid.Valid {
			v := tid.Int64
			l.TaskID = &v
		}
		out = append(out, &l)
	}
	return out, rows.Err()
}

// vecLiteral renders a float32 slice as a pgvector text literal "[1,2,3]".
func vecLiteral(v []float32) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, x := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(x), 'f', -1, 32))
	}
	b.WriteByte(']')
	return b.String()
}

var _ = fmt.Sprintf
