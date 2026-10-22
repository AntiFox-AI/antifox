package server

import (
	"bytes"
	"fmt"
	"image"
	_ "image/gif" // 注册 gif 解码器
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// 漏洞证据截图上传/展示/管理。文件存 dataDir/report_assets/evidence/<node_id>/（随 report_assets 备份）；
// 发现页 <img> 经 /api/findings/{id}/evidence/{file} 取图（cookie 鉴权，同 logo）；报告/MD 侧按磁盘路径内嵌。
//
// 安全基线（本身是安全平台，上传点不能成为恶意文件入口）：
//   - 不信任扩展名/客户端 MIME：按内容判定类型 + 解码校验是真图片 + 重编码（剥离追加/内嵌载荷、
//     EXIF、polyglot），统一落盘为干净 png/jpg；
//   - 解压炸弹防护：先读 DecodeConfig 校验尺寸上限再整幅解码；
//   - 取图响应强制 X-Content-Type-Options: nosniff + 固定图片 Content-Type + inline，杜绝存储型 XSS。

const (
	evidenceMaxBytes  = 16 << 20   // 单图 16MB
	evidenceMaxPixels = 50_000_000 // 5000 万像素上限（防解压炸弹）
	evidenceMaxDim    = 20000
)

// sanitizeImage 按内容校验并重编码图片；仅接受 png/jpeg/gif，统一输出 png（或 jpg）。
func sanitizeImage(raw []byte) (out []byte, ext string, err error) {
	ct := http.DetectContentType(raw)
	switch ct {
	case "image/png", "image/jpeg", "image/gif":
	default:
		return nil, "", fmt.Errorf("仅支持 png/jpg/gif 图片（检测到 %s）", ct)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, "", fmt.Errorf("不是有效图片")
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > evidenceMaxDim || cfg.Height > evidenceMaxDim ||
		cfg.Width*cfg.Height > evidenceMaxPixels {
		return nil, "", fmt.Errorf("图片尺寸超限")
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, "", fmt.Errorf("图片解码失败")
	}
	var buf bytes.Buffer
	if ct == "image/jpeg" {
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
			return nil, "", fmt.Errorf("图片处理失败")
		}
		return buf.Bytes(), ".jpg", nil
	}
	if err := png.Encode(&buf, img); err != nil {
		return nil, "", fmt.Errorf("图片处理失败")
	}
	return buf.Bytes(), ".png", nil
}

// evidenceDir 返回某漏洞证据文件目录（绝对路径）。
func (s *Server) evidenceDir(nodeID int64) string {
	return filepath.Join(s.dataDir, "report_assets", "evidence", strconv.FormatInt(nodeID, 10))
}

// evidenceURL 构造前端取图 URL。
func evidenceURL(nodeID int64, filename string) string {
	return fmt.Sprintf("/api/findings/%d/evidence/%s", nodeID, filename)
}

// POST /api/findings/{id}/evidence — multipart "file" + 可选 caption / step_index。
func (s *Server) uploadFindingEvidence(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	nodeID, ok := pathInt(r, "id")
	if !ok {
		writeErr(w, 400, "无效的漏洞 id")
		return
	}
	if err := r.ParseMultipartForm(16 << 20); err != nil { // 16 MB
		writeErr(w, 400, "上传解析失败")
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, 400, "缺少文件")
		return
	}
	defer file.Close()
	// 读入内存(限 16MB)→内容级校验+重编码，不信任扩展名/客户端 MIME。
	raw, err := io.ReadAll(io.LimitReader(file, evidenceMaxBytes+1))
	if err != nil {
		writeErr(w, 400, "读取文件失败")
		return
	}
	if len(raw) > evidenceMaxBytes {
		writeErr(w, 400, "图片过大（上限 16MB）")
		return
	}
	clean, ext, err := sanitizeImage(raw)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	dir := s.evidenceDir(nodeID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeErr(w, 500, "创建目录失败")
		return
	}
	name := fmt.Sprintf("ev-%d%s", time.Now().UnixNano(), ext)
	if err := os.WriteFile(filepath.Join(dir, name), clean, 0o644); err != nil {
		writeErr(w, 500, "写入失败")
		return
	}
	caption := strings.TrimSpace(r.FormValue("caption"))
	stepIndex, _ := strconv.Atoi(r.FormValue("step_index"))
	ev, err := pg.CreateFindingEvidence(nodeID, name, caption, stepIndex)
	if err != nil {
		_ = os.Remove(filepath.Join(dir, name)) // 回滚落盘
		writeErr(w, 500, "保存失败: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"evidence": ev, "url": evidenceURL(nodeID, name)})
}

// GET /api/findings/{id}/evidence — 列出某漏洞全部证据（带取图 url）。
func (s *Server) listFindingEvidence(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	nodeID, ok := pathInt(r, "id")
	if !ok {
		writeErr(w, 400, "无效的漏洞 id")
		return
	}
	list, err := pg.ListFindingEvidence(nodeID)
	if err != nil {
		writeErr(w, 500, "获取失败")
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, e := range list {
		out = append(out, map[string]any{"evidence": e, "url": evidenceURL(e.NodeID, e.Filename)})
	}
	writeJSON(w, 200, map[string]any{"items": out})
}

// PATCH /api/findings/{id}/evidence/{eid} — 改图注 / 对应步骤 / 排序。
func (s *Server) updateFindingEvidence(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	eid, ok := pathInt(r, "eid")
	if !ok {
		writeErr(w, 400, "无效的证据 id")
		return
	}
	var req struct {
		Caption   string `json:"caption"`
		StepIndex int    `json:"step_index"`
		SortOrder int    `json:"sort_order"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if err := pg.UpdateFindingEvidence(eid, req.Caption, req.StepIndex, req.SortOrder); err != nil {
		writeErr(w, 500, "保存失败: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// DELETE /api/findings/{id}/evidence/{eid} — 删记录 + 盘文件。
func (s *Server) deleteFindingEvidence(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	eid, ok := pathInt(r, "eid")
	if !ok {
		writeErr(w, 400, "无效的证据 id")
		return
	}
	ev, err := pg.GetFindingEvidence(eid)
	if err != nil {
		writeErr(w, 404, "证据不存在")
		return
	}
	if err := pg.DeleteFindingEvidence(eid); err != nil {
		writeErr(w, 500, "删除失败: "+err.Error())
		return
	}
	_ = os.Remove(filepath.Join(s.evidenceDir(ev.NodeID), filepath.Base(ev.Filename)))
	writeJSON(w, 200, map[string]any{"deleted": eid})
}

// GET /api/findings/{id}/evidence/{file} — 取证据图（base name，防穿越；cookie 鉴权同 logo）。
func (s *Server) serveFindingEvidence(w http.ResponseWriter, r *http.Request) {
	nodeID, ok := pathInt(r, "id")
	if !ok {
		writeErr(w, 400, "无效的漏洞 id")
		return
	}
	file := filepath.Base(r.PathValue("file"))
	// 固定图片 Content-Type + 禁嗅探 + 内联：即使磁盘上文件被篡改，浏览器也不会当作 HTML/脚本执行。
	w.Header().Set("X-Content-Type-Options", "nosniff")
	switch strings.ToLower(filepath.Ext(file)) {
	case ".png":
		w.Header().Set("Content-Type", "image/png")
	case ".jpg", ".jpeg":
		w.Header().Set("Content-Type", "image/jpeg")
	default:
		writeErr(w, 404, "not found")
		return
	}
	w.Header().Set("Content-Disposition", "inline")
	http.ServeFile(w, r, filepath.Join(s.evidenceDir(nodeID), file))
}
