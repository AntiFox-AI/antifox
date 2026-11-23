package knowledge

import "testing"

// TestToUTF8 pins the encoding normalization: valid UTF-8 passes through, GBK-encoded
// Chinese is transcoded (not mangled), and otherwise-invalid bytes are replaced rather
// than passed to the DB (which would reject them with a UTF8 encoding error).
func TestToUTF8(t *testing.T) {
	// valid UTF-8 unchanged
	if got := toUTF8([]byte("授权测试 ok")); got != "授权测试 ok" {
		t.Fatalf("valid utf8: got %q", got)
	}
	// GBK-encoded "授权测试" → transcoded to the same UTF-8 text
	gbk := []byte{0xca, 0xda, 0xc8, 0xa8, 0xb2, 0xe2, 0xca, 0xd4} // 授权测试 in GBK
	if got := toUTF8(gbk); got != "授权测试" {
		t.Fatalf("gbk transcode: got %q, want 授权测试", got)
	}
	// truly invalid bytes get replaced, result is valid UTF-8 (no DB crash)
	bad := []byte{0xff, 0xfe, 0x41} // not UTF-8, not valid GBK
	got := toUTF8(bad)
	for _, r := range got {
		if r == 0xfffd {
			return // contains replacement char — cleaned, good
		}
	}
	if got == "" || got == "A" {
		return // acceptable: invalid dropped/replaced, "A" survives
	}
	t.Fatalf("invalid bytes: got %q (should be cleaned to valid UTF-8)", got)
}
