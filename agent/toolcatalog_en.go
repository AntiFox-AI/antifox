package agent

// English (en-US) variants of the built-in tool descriptions and parameter
// schemas, keyed by tool key. Selected at seed/reset time by the content-language
// setting: an install seeds only ONE language, exactly like the prompt variants.
// The overlay is shipped as JSON (generated from the translated catalog) so it
// stays diff-friendly and never touches the Chinese definitions in code.

import (
	_ "embed"
	"encoding/json"
	"log"
	"sync"
)

//go:embed toolcatalog_en.json
var toolCatalogENJSON []byte

// englishToolVariant is one tool's English overlay.
type englishToolVariant struct {
	Description string         `json:"description"`
	Schema      map[string]any `json:"schema"`
}

var (
	englishToolsOnce sync.Once
	englishTools     map[string]englishToolVariant
)

// loadEnglishTools parses the embedded overlay once. Malformed JSON is fatal at
// first use — the file ships in-repo and is covered by the build.
func loadEnglishTools() map[string]englishToolVariant {
	englishToolsOnce.Do(func() {
		m := map[string]englishToolVariant{}
		if err := json.Unmarshal(toolCatalogENJSON, &m); err != nil {
			log.Fatalf("toolcatalog_en.json: %v", err)
		}
		englishTools = m
	})
	return englishTools
}

// EnglishToolVariant returns the English description+schema for a tool key.
// ok=false means no English variant exists (the Chinese default is used).
func EnglishToolVariant(key string) (desc string, schema map[string]any, ok bool) {
	v, hit := loadEnglishTools()[key]
	if !hit {
		return "", nil, false
	}
	return v.Description, v.Schema, true
}

// SeedInLanguage post-processes a ToolSeed with the English overlay when lang is
// en-US and a variant exists. Keys/Agents (behavioral wiring) are never touched —
// only the model-facing prose.
func SeedInLanguage(s ToolSeed, lang string) ToolSeed {
	if lang != "en-US" {
		return s
	}
	if desc, schema, ok := EnglishToolVariant(s.Key); ok {
		s.Desc = desc
		if len(schema) > 0 {
			s.Schema = schema
		}
	}
	return s
}
