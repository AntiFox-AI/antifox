// Package knowledge implements the two-layer RAG knowledge base (global +
// per-task): document ingestion (chunk → embed), semantic + keyword retrieval,
// and the OpenAI-compatible embeddings client. It degrades to keyword search when
// no embedder is configured or pgvector is unavailable.
package knowledge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// EmbedConfig is one OpenAI-compatible embeddings endpoint (works with 智谱/
// SiliconFlow/OpenAI/Ollama — all expose POST {base}/embeddings).
type EmbedConfig struct {
	BaseURL string
	Model   string
	APIKey  string
	Dim     int
}

type embedReq struct {
	Model      string   `json:"model"`
	Input      []string `json:"input"`
	Dimensions int      `json:"dimensions,omitempty"`
}

type embedResp struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// EmbedTexts calls the /embeddings endpoint once for the given inputs (keep the
// batch modest — callers chunk large sets). Preserves input order via the
// response's index field.
func EmbedTexts(ctx context.Context, cfg EmbedConfig, texts []string) ([][]float32, error) {
	if strings.TrimSpace(cfg.APIKey) == "" {
		return nil, fmt.Errorf("embedder 未配置 api_key")
	}
	if strings.TrimSpace(cfg.Model) == "" {
		return nil, fmt.Errorf("embedder 未配置 model")
	}
	if len(texts) == 0 {
		return nil, nil
	}
	url := strings.TrimRight(cfg.BaseURL, "/") + "/embeddings"
	payload := embedReq{Model: cfg.Model, Input: texts}
	if cfg.Dim > 0 {
		payload.Dimensions = cfg.Dim
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	resp, err := (&http.Client{Timeout: 90 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("embeddings 请求失败: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	var out embedResp
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("embeddings 响应解析失败 (HTTP %d): %s", resp.StatusCode, snippet(raw))
	}
	if out.Error != nil && out.Error.Message != "" {
		return nil, fmt.Errorf("embeddings 错误: %s", out.Error.Message)
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("embeddings HTTP %d: %s", resp.StatusCode, snippet(raw))
	}
	if len(out.Data) != len(texts) {
		return nil, fmt.Errorf("embeddings 数量不符: got %d want %d", len(out.Data), len(texts))
	}
	res := make([][]float32, len(texts))
	for _, d := range out.Data {
		if d.Index >= 0 && d.Index < len(res) {
			res[d.Index] = d.Embedding
		}
	}
	for i := range res {
		if res[i] == nil { // provider didn't return index order — fall back to positional
			for j := range out.Data {
				res[j] = out.Data[j].Embedding
			}
			break
		}
	}
	return res, nil
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}
