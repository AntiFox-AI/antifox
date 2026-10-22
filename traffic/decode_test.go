package traffic

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"strings"
	"testing"
)

func gzipBytes(s string) []byte {
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	_, _ = w.Write([]byte(s))
	_ = w.Close()
	return b.Bytes()
}

func deflateBytes(s string) []byte {
	var b bytes.Buffer
	w, _ := flate.NewWriter(&b, flate.DefaultCompression)
	_, _ = w.Write([]byte(s))
	_ = w.Close()
	return b.Bytes()
}

func TestDecodeForView(t *testing.T) {
	plain := `{"ok":true,"msg":"你好"}`

	cases := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "gzip response decoded, headers kept",
			raw:  "HTTP 200\nContent-Type: application/json\nContent-Encoding: gzip\n\n" + string(gzipBytes(plain)),
			want: "HTTP 200\nContent-Type: application/json\nContent-Encoding: gzip\n\n" + plain,
		},
		{
			name: "deflate response decoded",
			raw:  "HTTP 200\nContent-Encoding: deflate\n\n" + string(deflateBytes(plain)),
			want: "HTTP 200\nContent-Encoding: deflate\n\n" + plain,
		},
		{
			name: "no content-encoding unchanged",
			raw:  "HTTP 200\nContent-Type: application/json\n\n" + plain,
			want: "HTTP 200\nContent-Type: application/json\n\n" + plain,
		},
		{
			name: "identity unchanged",
			raw:  "HTTP 200\nContent-Encoding: identity\n\n" + plain,
			want: "HTTP 200\nContent-Encoding: identity\n\n" + plain,
		},
		{
			name: "no boundary unchanged",
			raw:  "HTTP 204\nContent-Encoding: gzip\n",
			want: "HTTP 204\nContent-Encoding: gzip\n",
		},
		{
			name: "blob pointer (not real bytes) unchanged",
			raw:  "HTTP 200\nContent-Encoding: gzip\n\n@blob sha256:deadbeef (len=999999)",
			want: "HTTP 200\nContent-Encoding: gzip\n\n@blob sha256:deadbeef (len=999999)",
		},
		{
			name: "truncated gzip falls back to raw",
			raw:  "HTTP 200\nContent-Encoding: gzip\n\n" + string(gzipBytes(plain))[:5],
			want: "HTTP 200\nContent-Encoding: gzip\n\n" + string(gzipBytes(plain))[:5],
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := decodeForView(c.raw)
			if got != c.want {
				t.Errorf("decodeForView mismatch\n got: %q\nwant: %q", got, c.want)
			}
			if strings.Contains(c.name, "decoded") && !strings.Contains(got, plain) {
				t.Errorf("expected decoded plaintext %q in output, got %q", plain, got)
			}
		})
	}
}
