package tool

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestNewSearchProviderKeenableNeedsNoKey(t *testing.T) {
	prov, err := newSearchProvider(WebSearchConfig{Backend: " Keenable "})
	if err != nil {
		t.Fatalf("keenable backend without a key: %v", err)
	}
	kp, ok := prov.(*keenableProvider)
	if !ok {
		t.Fatalf("got %T, want *keenableProvider", prov)
	}
	if kp.endpoint != keenableEndpoint {
		t.Errorf("endpoint = %q, want %q", kp.endpoint, keenableEndpoint)
	}
	if prov.Name() != "keenable" {
		t.Errorf("Name() = %q, want keenable", prov.Name())
	}
}

func TestNewSearchProviderDefaultStaysDDGS(t *testing.T) {
	prov, err := newSearchProvider(WebSearchConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if prov.Name() != "ddgs" {
		t.Errorf("default backend = %q, want ddgs", prov.Name())
	}
}

func TestKeenableSearch(t *testing.T) {
	long := strings.Repeat("长文本 ", 400) // well over the snippet cap, multi-byte runes
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if got := r.Header.Get("X-Keenable-Title"); got != "AntiFox" {
			t.Errorf("X-Keenable-Title = %q, want AntiFox", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[
			{"title":" First ","url":"https://a.example/","description":"","snippet":"line one\n\n  line two"},
			{"title":"No URL","url":"","description":"","snippet":"skipped"},
			{"title":"Second","url":"https://b.example/","description":"","snippet":"` + long + `"},
			{"title":"Third","url":"https://c.example/","description":"","snippet":"over the limit"}
		]}`))
	}))
	defer srv.Close()

	p := &keenableProvider{client: srv.Client(), endpoint: srv.URL}
	results, err := p.Search(context.Background(), "nmap os detection", 2)
	if err != nil {
		t.Fatal(err)
	}
	if gotBody["query"] != "nmap os detection" {
		t.Errorf("query = %v", gotBody["query"])
	}
	if gotBody["max_results"] != float64(2) {
		t.Errorf("max_results = %v, want 2", gotBody["max_results"])
	}
	if _, ok := gotBody["api_key"]; ok {
		t.Error("keyless request must not carry an api_key")
	}
	if len(results) != 2 {
		t.Fatalf("got %d results, want 2: %+v", len(results), results)
	}
	if r := results[0]; r.Title != "First" || r.URL != "https://a.example/" || r.Description != "line one line two" || r.Position != 1 {
		t.Errorf("result 0 = %+v", r)
	}
	r := results[1]
	if r.URL != "https://b.example/" || r.Position != 2 {
		t.Errorf("result 1 = %+v", r)
	}
	if !utf8.ValidString(r.Description) {
		t.Error("capped description is not valid UTF-8")
	}
	if n := utf8.RuneCountInString(r.Description); n != keenableSnippetMaxRune+1 {
		t.Errorf("capped description has %d runes, want %d", n, keenableSnippetMaxRune+1)
	}
}

func TestKeenableSearchHTTPErrors(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   string
	}{
		{http.StatusTooManyRequests, "rate-limiting"},
		{http.StatusBadRequest, "HTTP 400"},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
		}))
		p := &keenableProvider{client: srv.Client(), endpoint: srv.URL}
		_, err := p.Search(context.Background(), "q", 5)
		srv.Close()
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("HTTP %d: err = %v, want it to mention %q", tc.status, err, tc.want)
		}
	}
}
