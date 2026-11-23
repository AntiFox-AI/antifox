package server

// Project docs: project-specific knowledge (authorization letter, test scope,
// scoring rules …) uploaded in the new-task dialog. Files are text-extracted and
// stored; their text is injected deterministically into the planner/worker SYSTEM
// prompt (always read). During the draft flow they're staged under a draft_id and
// bound to the task on create. Optionally also pushed into the task's RAG library.

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"antifox/db"
	"antifox/knowledge"
)

const maxProjectDocUpload = 16 << 20 // 16 MiB per file

// sanitizeDocName strips control chars + trims, and caps length — the name is shown
// in the UI and injected as a doc header, so keep it clean and bounded.
func sanitizeDocName(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f { // drop control characters
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	if len(s) > 120 {
		// 字节截断会切断多字节字符；ToValidUTF8 丢弃末尾半个字符，避免入库/显示出错。
		s = strings.ToValidUTF8(s[:120], "")
	}
	if s == "" {
		s = "文档"
	}
	return s
}

// newDraftID returns a short random staging key for the new-task draft flow.
func newDraftID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "draft_" + hex.EncodeToString(b)
}

// POST /api/tasks/project-docs — multipart: file + optional draft_id. Extracts text,
// stages it under the draft, returns {draft_id, doc}. First call omits draft_id and
// gets one back; subsequent files reuse it.
// allowedProjectDocExt 是项目知识上传的扩展名白名单（纯文本 + 可安全抽取文本的文档）。
// 后端强校验，不只依赖前端 accept——拒绝可执行/未知类型，只接受能安全抽取为文本的格式。
var allowedProjectDocExt = map[string]bool{
	".md": true, ".markdown": true, ".txt": true, ".text": true,
	".csv": true, ".json": true, ".log": true, ".yaml": true, ".yml": true,
	".docx": true, ".pdf": true,
}

// maxDraftProjectDocs 限制单个 draft 的文件数，防滥用撑爆存储。
const maxDraftProjectDocs = 20

func (s *Server) uploadProjectDoc(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeErr(w, 400, "上传解析失败")
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, 400, "缺少文件")
		return
	}
	defer file.Close()
	// 扩展名白名单强校验（取 base 防路径分隔符；无扩展名/未知类型一律拒绝）。
	ext := strings.ToLower(filepath.Ext(filepath.Base(hdr.Filename)))
	if !allowedProjectDocExt[ext] {
		writeErr(w, 400, "不支持的文件类型，仅接受 .md/.txt/.csv/.json/.yaml/.docx/.pdf")
		return
	}
	draftID := strings.TrimSpace(r.FormValue("draft_id"))
	if draftID == "" {
		draftID = newDraftID()
	}
	// 单 draft 文件数上限：防一次性上传大量文件撑爆存储。
	if existing, _ := s.m.pg.ListDraftProjectDocs(draftID); len(existing) >= maxDraftProjectDocs {
		writeErr(w, 400, fmt.Sprintf("单个任务最多上传 %d 个项目知识文件", maxDraftProjectDocs))
		return
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxProjectDocUpload))
	if err != nil {
		writeErr(w, 400, "读取失败")
		return
	}
	text, err := knowledge.ExtractText(hdr.Filename, raw)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if strings.TrimSpace(text) == "" {
		writeErr(w, 400, "文档内容为空或无法抽取文本")
		return
	}
	toRAG := r.FormValue("to_rag") == "true" // 也加入任务知识库供语义检索（大文件/参考资料）
	// 文件名只取 base + 去扩展名，作为显示名（不落盘到该路径，无路径遍历风险）。
	name := sanitizeDocName(strings.TrimSuffix(filepath.Base(hdr.Filename), filepath.Ext(hdr.Filename)))
	id, err := s.m.pg.AddDraftProjectDoc(draftID, name, text, toRAG)
	if err != nil {
		writeErr(w, 500, "保存失败: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"draft_id": draftID,
		"doc":      map[string]any{"id": id, "name": name, "bytes": len(raw), "to_rag": toRAG},
	})
}

// GET /api/tasks/project-docs?draft_id=X — list docs staged under a draft.
func (s *Server) listDraftProjectDocs(w http.ResponseWriter, r *http.Request) {
	docs, err := s.m.pg.ListDraftProjectDocs(r.URL.Query().Get("draft_id"))
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"docs": projectDocCards(docs)})
}

// DELETE /api/tasks/project-docs?draft_id=X&id=N — remove one staged doc.
func (s *Server) deleteDraftProjectDoc(w http.ResponseWriter, r *http.Request) {
	draftID := r.URL.Query().Get("draft_id")
	id, _ := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if draftID == "" || id <= 0 {
		writeErr(w, 400, "draft_id / id 必填")
		return
	}
	if err := s.m.pg.DeleteDraftProjectDoc(draftID, id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// GET /api/tasks/{id}/project-docs — list a task's bound project docs (detail page).
func (s *Server) listTaskProjectDocs(w http.ResponseWriter, r *http.Request) {
	taskID, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	docs, err := s.m.pg.ListTaskProjectDocs(taskID)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"docs": projectDocCards(docs)})
}

// pushProjectDocsToRAG adds a task's to_rag-flagged project docs into the task-scoped
// knowledge base (semantic search), in addition to the deterministic SYSTEM injection.
// Best-effort + async indexing; failures are logged, not fatal to task creation.
func (s *Server) pushProjectDocsToRAG(taskID int64) {
	docs, err := s.m.pg.ListTaskProjectDocs(taskID)
	if err != nil {
		return
	}
	for _, d := range docs {
		if !d.ToRAG || strings.TrimSpace(d.Content) == "" {
			continue
		}
		tid := taskID
		id, err := s.m.pg.AddKnowledgeDoc(&db.KnowledgeDoc{
			Scope: "task", TaskID: &tid, Category: "项目知识",
			Title: d.Name, Content: d.Content, Source: "project-doc",
		})
		if err != nil {
			log.Printf("[task] 项目知识入库失败(task=%d, %s): %v", taskID, d.Name, err)
			continue
		}
		go s.indexKnowledgeAsync(id)
	}
}

// taskProjectDocsBlock returns the 「项目知识」 SYSTEM block for a task — its uploaded
// authorization/scope/scoring docs, injected verbatim (must-read) into planner/worker.
// Empty when the task has none. Wired as the agents' projectDocs resolver.
func (s *Server) taskProjectDocsBlock(taskID int64) string {
	if s.m == nil || s.m.pg == nil {
		return ""
	}
	docs, err := s.m.pg.ListTaskProjectDocs(taskID)
	if err != nil || len(docs) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\n【项目知识（本次测试的授权书/测试范围/评分规则/已获取凭据等专有信息，务必通读并严格遵守——尤其授权边界与测试范围，不得越界；已提供的凭据/入口直接用，别重复爆破）】\n")
	for _, d := range docs {
		b.WriteString("\n—— " + d.Name + " ——\n")
		b.WriteString(d.Content)
		b.WriteString("\n")
	}
	return b.String()
}

// projectDocCards strips the full content (only name/size/preview go to the UI).
func projectDocCards(docs []db.ProjectDoc) []map[string]any {
	out := make([]map[string]any, 0, len(docs))
	for _, d := range docs {
		preview := d.Content
		if len(preview) > 160 {
			// 字节截断会切断多字节字符；ToValidUTF8 丢弃末尾半个字符，避免预览出现乱码。
			preview = strings.ToValidUTF8(preview[:160], "")
		}
		out = append(out, map[string]any{
			"id": d.ID, "name": d.Name, "chars": len(d.Content), "preview": preview,
		})
	}
	return out
}
