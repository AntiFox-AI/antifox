//go:build embedui

package server

// Default skill library, embedded into the single binary (production `-tags embedui`
// build). The repo `skills/` dir is copied into `server/skillsdist/` at build time
// (mirrors `server/webui/dist`), then materialized into the writable skill dir on
// first run — so a fresh cloud / on-prem deployment gets the full skill library from
// the binary alone, with no external files tied to a dev machine.

import (
	"embed"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
)

//go:embed all:skillsdist
var embeddedSkills embed.FS

// materializeEmbeddedSkills writes each embedded default skill into skillDir when its
// directory is absent (seed-if-missing). Existing skills and user edits are never
// overwritten. report-generation is intentionally NOT embedded — it is regenerated
// from Go defaults by report.SeedSkillFiles so its trilingual skeleton never drifts.
//
// lang selects the CONTENT language of what gets materialized: skills ship variant
// files ("SKILL.en-US.md" next to the Chinese "SKILL.md"), and only the selected
// language is ever written to disk — an en-US install never materializes (or lists)
// Chinese skill bodies, and vice versa. Variant files map onto the base name:
// "X.en-US.md" is materialized as "X.md".
func materializeEmbeddedSkills(skillDir, lang string) {
	root, err := fs.Sub(embeddedSkills, "skillsdist")
	if err != nil {
		return
	}
	entries, err := fs.ReadDir(root, ".")
	if err != nil {
		return
	}
	seeded := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if _, err := os.Stat(filepath.Join(skillDir, name)); err == nil {
			continue // already present → keep (never clobber edits)
		}
		if err := writeEmbeddedSkill(root, name, skillDir, lang); err != nil {
			log.Printf("[skill] 物化 %s 失败: %v", name, err)
			continue
		}
		seeded++
	}
	if seeded > 0 {
		log.Printf("[skill] 物化内置 skill %d 个 (lang=%s) → %s", seeded, lang, skillDir)
	}
}

// enVariantPath maps a base file path to its en-US variant sibling
// ("SKILL.md" → "SKILL.en-US.md").
func enVariantPath(p string) string {
	return strings.TrimSuffix(p, ".md") + ".en-US.md"
}

// hasEnVariant reports whether the embedded tree carries an en-US variant for p.
func hasEnVariant(root fs.FS, p string) bool {
	_, err := fs.Stat(root, enVariantPath(p))
	return err == nil
}

// writeEmbeddedSkill copies one embedded skill into skillDir, applying the
// language mapping: *.en-US.md files are written as their base name when lang is
// en-US (and skipped otherwise); base files are skipped for en-US when a variant
// exists (it takes the base name instead), and written as-is for zh.
func writeEmbeddedSkill(root fs.FS, name, skillDir, lang string) error {
	return fs.WalkDir(root, name, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(skillDir, filepath.FromSlash(p)), 0o755)
		}
		switch {
		case strings.HasSuffix(p, ".en-US.md"):
			if lang != "en-US" {
				return nil // not the selected language → never materialize
			}
			p = strings.TrimSuffix(p, ".en-US.md") + ".md"
		case lang == "en-US" && hasEnVariant(root, p):
			return nil // the variant will take this base name
		}
		data, err := fs.ReadFile(root, p)
		if err != nil {
			return err
		}
		target := filepath.Join(skillDir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}
