package knowledge

import (
	"context"
	"fmt"
	"strings"

	"antifox/db"
)

// Service orchestrates ingestion (chunk → embed → store) and retrieval over the
// two-layer knowledge base. It holds only a *db.DB; embedder config is read fresh
// each call so a settings change takes effect without a restart.
type Service struct{ pg *db.DB }

func NewService(pg *db.DB) *Service { return &Service{pg: pg} }

const (
	chunkChars   = 700
	chunkOverlap = 80
	embedBatch   = 16 // inputs per /embeddings call (safe across providers)
)

// SemanticReady reports whether vector search can run: pgvector present + embedder
// enabled + a key configured. When false, retrieval uses keyword search.
func (s *Service) SemanticReady() bool {
	if s == nil || s.pg == nil || !s.pg.KnowledgeVectorAvailable() {
		return false
	}
	cfg, err := s.pg.GetKnowledgeConfig()
	if err != nil || cfg == nil {
		return false
	}
	return cfg.Enabled && strings.TrimSpace(cfg.APIKey) != ""
}

// Categories lists knowledge categories visible for the scope (global + task).
func (s *Service) Categories(taskID int64) ([]string, error) {
	return s.pg.ListKnowledgeCategories(taskID)
}

func (s *Service) embedConfig() (EmbedConfig, error) {
	cfg, err := s.pg.GetKnowledgeConfig()
	if err != nil {
		return EmbedConfig{}, err
	}
	return EmbedConfig{BaseURL: cfg.BaseURL, Model: cfg.Model, APIKey: cfg.APIKey, Dim: cfg.Dim}, nil
}

// IndexDoc chunks + embeds a document and stores its chunks. No-op when semantic
// search isn't ready (keyword mode reads doc content directly, no chunks needed).
func (s *Service) IndexDoc(ctx context.Context, docID int64) error {
	if !s.SemanticReady() {
		return nil
	}
	doc, err := s.pg.GetKnowledgeDoc(docID)
	if err != nil || doc == nil {
		return err
	}
	chunks := ChunkText(doc.Content, chunkChars, chunkOverlap)
	if len(chunks) == 0 {
		return s.pg.ReplaceKnowledgeChunks(docID, "", 0, nil) // clear + mark indexed
	}
	cfg, err := s.embedConfig()
	if err != nil {
		return err
	}
	inputs := make([]string, len(chunks))
	for i, c := range chunks {
		inputs[i] = embedInput(doc.Category, doc.Title, c)
	}
	vecs := make([][]float32, 0, len(inputs))
	for i := 0; i < len(inputs); i += embedBatch {
		j := i + embedBatch
		if j > len(inputs) {
			j = len(inputs)
		}
		part, err := EmbedTexts(ctx, cfg, inputs[i:j])
		if err != nil {
			return err
		}
		vecs = append(vecs, part...)
	}
	ins := make([]db.KnowledgeChunkInsert, len(chunks))
	for i := range chunks {
		ins[i] = db.KnowledgeChunkInsert{Index: i, Content: chunks[i], Embedding: vecs[i]}
	}
	return s.pg.ReplaceKnowledgeChunks(docID, cfg.Model, cfg.Dim, ins)
}

// Search retrieves the top-k relevant chunks/docs for a query across global + the
// given task. Returns the hits and the mode used ("semantic" | "keyword").
func (s *Service) Search(ctx context.Context, query string, taskID int64, topK int) ([]db.KnowledgeHit, string, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, "keyword", nil
	}
	if s.SemanticReady() {
		if cfg, err := s.embedConfig(); err == nil {
			if vecs, err := EmbedTexts(ctx, cfg, []string{query}); err == nil && len(vecs) == 1 {
				if hits, err := s.pg.SearchKnowledgeVector(vecs[0], cfg.Model, taskID, topK); err == nil {
					return hits, "semantic", nil
				}
			}
		}
		// any semantic failure (embed/query) silently falls through to keyword
	}
	hits, err := s.pg.SearchKnowledgeKeyword(query, taskID, topK)
	return hits, "keyword", err
}

// SearchAndLog runs Search and records a retrieval-log row (used by agent tools).
func (s *Service) SearchAndLog(ctx context.Context, query string, taskID int64, topK int, agentKey string) ([]db.KnowledgeHit, string, error) {
	hits, mode, err := s.Search(ctx, query, taskID, topK)
	if err == nil {
		scope := "global"
		if taskID > 0 {
			scope = "global+task"
		}
		ids := make([]int64, 0, len(hits))
		for _, h := range hits {
			ids = append(ids, h.DocID)
		}
		s.pg.AddKnowledgeRetrievalLog(taskID, agentKey, query, scope, mode, topK, len(hits), ids)
	}
	return hits, mode, err
}

// Reindex re-embeds every document (after an embedder/model change). Requires
// semantic search to be ready.
func (s *Service) Reindex(ctx context.Context) (int, error) {
	if !s.SemanticReady() {
		return 0, fmt.Errorf("语义检索未就绪：需 pgvector + 启用 embedder + 配置 api_key")
	}
	if err := s.pg.ClearKnowledgeChunks(); err != nil {
		return 0, err
	}
	docs, err := s.pg.ListKnowledgeDocs("", 0) // all docs
	if err != nil {
		return 0, err
	}
	n := 0
	for _, doc := range docs {
		if err := s.IndexDoc(ctx, doc.ID); err != nil {
			return n, fmt.Errorf("文档 #%d(%s) 索引失败: %w", doc.ID, doc.Title, err)
		}
		n++
	}
	return n, nil
}

// TestEmbedder verifies the configured embedder by embedding a probe string.
// Returns the vector dimension actually returned.
func (s *Service) TestEmbedder(ctx context.Context) (int, error) {
	cfg, err := s.embedConfig()
	if err != nil {
		return 0, err
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		return 0, fmt.Errorf("未配置 api_key")
	}
	vecs, err := EmbedTexts(ctx, cfg, []string{"知识库连通性测试 knowledge base connectivity test"})
	if err != nil {
		return 0, err
	}
	if len(vecs) != 1 || len(vecs[0]) == 0 {
		return 0, fmt.Errorf("embedder 返回空向量")
	}
	return len(vecs[0]), nil
}
