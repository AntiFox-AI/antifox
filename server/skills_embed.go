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
)

//go:embed all:skillsdist
var embeddedSkills embed.FS

// materializeEmbeddedSkills writes each embedded default skill into skillDir when its
// directory is absent (seed-if-missing). Existing skills and user edits are never
// overwritten. report-generation is intentionally NOT embedded — it is regenerated
// from Go defaults by report.SeedSkillFiles so its trilingual skeleton never drifts.
func materializeEmbeddedSkills(skillDir string) {
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
		if err := writeEmbeddedSkill(root, name, skillDir); err != nil {
			log.Printf("[skill] 物化 %s 失败: %v", name, err)
			continue
		}
		seeded++
	}
	if seeded > 0 {
		log.Printf("[skill] 物化内置 skill %d 个 → %s", seeded, skillDir)
	}
}

func writeEmbeddedSkill(root fs.FS, name, skillDir string) error {
	return fs.WalkDir(root, name, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(skillDir, filepath.FromSlash(p))
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := fs.ReadFile(root, p)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}
