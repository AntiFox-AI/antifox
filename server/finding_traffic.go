package server

import (
	"net/http"

	"antifox/traffic"
)

// 漏洞↔流量关联接口。关联在 PG，报文元数据从流量库(SQLite)按 id 解析。
// 手动关联走这里(source=manual)；任务引擎将来可直接调 pg.LinkFindingTraffic(..., "auto") 自动记录。

// POST /api/findings/{id}/traffic — body {exchange_ids:[]} 关联流量到漏洞。
func (s *Server) linkFindingTraffic(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	nodeID, ok := pathInt(r, "id")
	if !ok {
		writeErr(w, 400, "无效的漏洞 id")
		return
	}
	var req struct {
		ExchangeIDs []string `json:"exchange_ids"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if err := pg.LinkFindingTraffic(nodeID, req.ExchangeIDs, "manual"); err != nil {
		writeErr(w, 500, "关联失败: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "linked": len(req.ExchangeIDs)})
}

// GET /api/findings/{id}/traffic — 列出该漏洞关联的流量（带元数据；报文正文按需另取）。
func (s *Server) listFindingTraffic(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	nodeID, ok := pathInt(r, "id")
	if !ok {
		writeErr(w, 400, "无效的漏洞 id")
		return
	}
	ids, err := pg.ListFindingTrafficIDs(nodeID)
	if err != nil {
		writeErr(w, 500, "获取失败")
		return
	}
	var metas []traffic.ExchangeMeta
	if tr := s.m.Traffic(); tr != nil && len(ids) > 0 {
		metas, _ = tr.MetaByIDs(ids)
	}
	writeJSON(w, 200, map[string]any{"exchanges": trafficDTOs(metas)})
}

// DELETE /api/findings/{id}/traffic/{eid} — 解除关联。
func (s *Server) unlinkFindingTraffic(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	nodeID, ok := pathInt(r, "id")
	if !ok {
		writeErr(w, 400, "无效的漏洞 id")
		return
	}
	if err := pg.UnlinkFindingTraffic(nodeID, r.PathValue("eid")); err != nil {
		writeErr(w, 500, "解除失败: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
