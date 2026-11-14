package server

import "net/http"

// lerr picks a user-facing message language: English when content_lang is
// en-US, Chinese otherwise (zh-CN default). Only for API/JSON error strings;
// log lines stay English-only.
func (s *Server) lerr(en, zh string) string {
	if s.readContentLang() == "en-US" {
		return en
	}
	return zh
}

// writeErrL is the bilingual variant of writeErr for user-facing errors.
func (s *Server) writeErrL(w http.ResponseWriter, code int, en, zh string) {
	writeErr(w, code, s.lerr(en, zh))
}
