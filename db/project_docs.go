package db

// Project docs: per-task project-specific knowledge (authorization letter, test
// scope, scoring rules …) uploaded at task-create time. Their extracted text is
// injected deterministically into the planner/worker SYSTEM prompt (always read),
// unlike the semantic-search knowledge base. During the new-task draft flow a doc
// has task_id=NULL + a draft_id; BindDraftProjectDocs attaches them to the task.

import (
	"strings"
	"time"
)

// maxProjectDocContent caps a single stored doc's text so injecting several into
// the system prompt can't blow the context window. Longer uploads are truncated.
const maxProjectDocContent = 16 << 10 // 16 KiB

type ProjectDoc struct {
	ID        int64     `json:"id"`
	TaskID    *int64    `json:"task_id,omitempty"`
	Name      string    `json:"name"`
	Content   string    `json:"content"`
	ToRAG     bool      `json:"to_rag"`
	CreatedAt time.Time `json:"created_at"`
}

// AddDraftProjectDoc stores one uploaded doc in the draft staging area (task_id
// NULL, keyed by draftID). Content is trimmed to maxProjectDocContent. toRAG marks
// whether it should also enter the task's semantic knowledge base on task create.
func (d *DB) AddDraftProjectDoc(draftID, name, content string, toRAG bool) (int64, error) {
	if len(content) > maxProjectDocContent {
		// 按字节截断会切断多字节 UTF-8 字符（如中文），留下半个字符的悬空字节——
		// PG 的 text 列会以 "invalid byte sequence" 拒绝入库。ToValidUTF8 丢弃末尾那半个字符。
		content = strings.ToValidUTF8(content[:maxProjectDocContent], "")
	}
	var id int64
	err := d.QueryRow(`INSERT INTO task_project_docs(draft_id, name, content, to_rag)
		VALUES ($1,$2,$3,$4) RETURNING id`, draftID, name, content, toRAG).Scan(&id)
	return id, err
}

// ListDraftProjectDocs returns the docs staged under a draft (for the create-task UI).
func (d *DB) ListDraftProjectDocs(draftID string) ([]ProjectDoc, error) {
	if strings.TrimSpace(draftID) == "" {
		return nil, nil
	}
	return d.scanProjectDocs(d.Query(`SELECT id, task_id, name, content, to_rag, created_at
		FROM task_project_docs WHERE draft_id=$1 ORDER BY id`, draftID))
}

// DeleteDraftProjectDoc removes one staged doc (user removed it before creating the task).
func (d *DB) DeleteDraftProjectDoc(draftID string, id int64) error {
	_, err := d.Exec(`DELETE FROM task_project_docs WHERE draft_id=$1 AND id=$2 AND task_id IS NULL`, draftID, id)
	return err
}

// BindDraftProjectDocs attaches a draft's staged docs to a freshly created task
// (task_id set, draft_id cleared). Called inside the create-task flow.
func (d *DB) BindDraftProjectDocs(draftID string, taskID int64) error {
	if strings.TrimSpace(draftID) == "" {
		return nil
	}
	_, err := d.Exec(`UPDATE task_project_docs SET task_id=$1, draft_id='' WHERE draft_id=$2 AND task_id IS NULL`, taskID, draftID)
	return err
}

// ListTaskProjectDocs returns the project docs bound to a task (for injection + UI).
func (d *DB) ListTaskProjectDocs(taskID int64) ([]ProjectDoc, error) {
	return d.scanProjectDocs(d.Query(`SELECT id, task_id, name, content, to_rag, created_at
		FROM task_project_docs WHERE task_id=$1 ORDER BY id`, taskID))
}

// PurgeStaleDraftProjectDocs deletes orphan draft docs older than age (drafts never
// turned into tasks). Called best-effort on a schedule to bound table growth.
func (d *DB) PurgeStaleDraftProjectDocs(age time.Duration) (int64, error) {
	res, err := d.Exec(`DELETE FROM task_project_docs
		WHERE task_id IS NULL AND created_at < now() - $1::interval`,
		age.String())
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func (d *DB) scanProjectDocs(rows interface {
	Next() bool
	Scan(...any) error
	Close() error
	Err() error
}, err error) ([]ProjectDoc, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProjectDoc
	for rows.Next() {
		var p ProjectDoc
		if err := rows.Scan(&p.ID, &p.TaskID, &p.Name, &p.Content, &p.ToRAG, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
