package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	actool "antifox/engine/tool"

	"antifox/knowledge"
)

// SetKnowledgeStore wires the knowledge-base service so search_knowledge /
// list_knowledge_categories are active. nil = the tools report "not enabled".
func (t *ToolSet) SetKnowledgeStore(kb *knowledge.Service) { t.kb = kb }

// search_knowledge — semantic (or keyword-fallback) retrieval over the two-layer
// knowledge base: global common knowledge + this task's uploaded background.
func (t *ToolSet) searchKnowledge() actool.CoreTool {
	return readTool("search_knowledge",
		"检索知识库：全局通用知识(漏洞库/0day/技巧/方法论) + 当前任务专属资料(评分规则/授权范围/目标/检查项)。用自然语言描述你要找什么，返回最相关的知识片段。执行任务时应主动检索相关知识来指导方法选择与判定标准。",
		obj(map[string]any{
			"query": str("要检索的问题或主题，自然语言描述"),
			"top_k": intp("返回条数，默认 5"),
		}, "query"),
		func(ctx context.Context, in json.RawMessage) (actool.Result, error) {
			var a struct {
				Query string `json:"query"`
				TopK  int    `json:"top_k"`
			}
			_ = json.Unmarshal(in, &a)
			if strings.TrimSpace(a.Query) == "" {
				return actool.Errorf("query 不能为空"), nil
			}
			if t.kb == nil {
				return actool.Text("知识库未启用。"), nil
			}
			if a.TopK <= 0 {
				a.TopK = 5
			}
			hits, mode, err := t.kb.SearchAndLog(ctx, a.Query, t.taskID, a.TopK, t.worker)
			if err != nil {
				return actool.Errorf(fmt.Sprintf("检索失败: %v", err)), nil
			}
			if len(hits) == 0 {
				return actool.Text("知识库中未找到相关内容。"), nil
			}
			var b strings.Builder
			fmt.Fprintf(&b, "检索模式: %s，命中 %d 条：\n", mode, len(hits))
			for i, h := range hits {
				scope := "全局"
				if h.Scope == "task" {
					scope = "任务专属"
				}
				fmt.Fprintf(&b, "\n--- 结果 %d (相似度 %.0f%%, %s) ---\n[%s] %s\n%s\n",
					i+1, h.Score*100, scope, h.Category, h.Title, strings.TrimSpace(h.Content))
			}
			return actool.Text(b.String()), nil
		})
}

// list_knowledge_categories — enumerate categories so the agent can browse before
// a targeted search_knowledge call.
func (t *ToolSet) listKnowledgeCategories() actool.CoreTool {
	return readTool("list_knowledge_categories",
		"列出知识库现有分类（全局 + 当前任务）。先看有哪些类，再用 search_knowledge 针对性检索。",
		obj(map[string]any{}),
		func(ctx context.Context, _ json.RawMessage) (actool.Result, error) {
			if t.kb == nil {
				return actool.Text("知识库未启用。"), nil
			}
			cats, err := t.kb.Categories(t.taskID)
			if err != nil {
				return actool.Errorf(fmt.Sprintf("读取失败: %v", err)), nil
			}
			if len(cats) == 0 {
				return actool.Text("知识库暂无分类。"), nil
			}
			return actool.Text("知识库分类：\n- " + strings.Join(cats, "\n- ")), nil
		})
}
