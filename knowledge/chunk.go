package knowledge

import "strings"

// ChunkText splits document text into chunks of roughly maxChars runes, packing
// whole paragraphs together and hard-splitting any single oversized paragraph
// (with `overlap` runes carried across the hard-split boundary). Paragraph packing
// keeps semantic units intact; overlap only kicks in on the rare huge paragraph.
func ChunkText(text string, maxChars, overlap int) []string {
	if maxChars <= 0 {
		maxChars = 700
	}
	if overlap < 0 || overlap >= maxChars {
		overlap = 80
	}
	var chunks []string
	var cur strings.Builder
	curLen := 0
	push := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			chunks = append(chunks, s)
		}
		cur.Reset()
		curLen = 0
	}
	add := func(p string) {
		pr := []rune(p)
		for len(pr) > maxChars { // hard-split an oversized paragraph
			if curLen > 0 {
				push()
			}
			chunks = append(chunks, strings.TrimSpace(string(pr[:maxChars])))
			step := maxChars - overlap
			if step < 1 {
				step = maxChars
			}
			pr = pr[step:]
		}
		if len(pr) == 0 {
			return
		}
		if curLen > 0 && curLen+len(pr)+1 > maxChars {
			push()
		}
		if curLen > 0 {
			cur.WriteByte('\n')
			curLen++
		}
		cur.WriteString(string(pr))
		curLen += len(pr)
	}
	for _, p := range splitParagraphs(text) {
		add(p)
	}
	push()
	return chunks
}

func splitParagraphs(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	var out []string
	for _, p := range strings.Split(text, "\n\n") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		if t := strings.TrimSpace(text); t != "" {
			out = []string{t}
		}
	}
	return out
}

// embedInput prepends category/title context to a chunk before embedding, so the
// vector reflects "what document this is from" — improves retrieval relevance.
func embedInput(category, title, chunk string) string {
	var b strings.Builder
	if category != "" {
		b.WriteString("[分类：" + category + "] ")
	}
	if title != "" {
		b.WriteString("[标题：" + title + "]\n")
	}
	b.WriteString(chunk)
	return b.String()
}
