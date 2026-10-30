// Package agent wires real LLM-driven planner and work agents (on top of the
// agent-core SDK) to the dual SQLite graph. See docs/AntiFox-架构设计.md
// §4.3 (planner) and §4.4 (work agent).
//
// Provider configuration is read from the environment so the system runs with
// any Anthropic- or OpenAI-format endpoint. If no key is configured, FromEnv
// returns ok=false and the exploration engine stays idle (an LLM is required).
package agent

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"antifox/engine/agentcore"
	"antifox/engine/compaction"
	"antifox/engine/llm"
	acperm "antifox/engine/permission"
	"antifox/engine/transcript"
)

// Config describes the LLM backend resolved from the environment.
type Config struct {
	Format  llm.Format
	BaseURL string
	APIKey  string
	Model   string
	// Proxy routes all LLM requests through the given proxy URL (http/https/socks5).
	// Empty falls back to the standard *_PROXY environment variables.
	Proxy string
	// RatePerSecond / RatePerMinute cap the shared request rate across ALL agents
	// using the provider (0 = that window unlimited).
	RatePerSecond float64
	RatePerMinute float64
	// ContextWindowK is the model's context window in K tokens (user-configured),
	// used to size compaction thresholds. 0 = default; see CompactionWindow.
	ContextWindowK int
	// ReasoningEffort selects the thinking mode: "" = 默认(不发送思考参数);
	// "off" = 关闭(thinking.type=disabled); "low"/"medium"/"high"/"max" = 开启并设强度.
	// NewProvider derives the provider-specific request fields from it.
	ReasoningEffort string
	// SessionHeaderKey, 非空时让每次 LLM 请求带一个自定义 HTTP 头——头名=该值、头值=当前
	// 会话 session id(从请求 ctx 读，见 transcript.WithSessionID)。供按 session 做提示缓存/
	// 粘性路由的网关(如 opencode zen)。空=不发送。
	SessionHeaderKey string
}

// compaction window resolution bounds (in K tokens). Below the floor the
// threshold math (window − summary reserve − buffer) would go non-positive and
// compaction would fire every turn; above the cap it would never fire.
const (
	defaultWindowK = 200  // unset → assume a 200K window (Claude default)
	minWindowK     = 32   // floor so effectiveWindow stays comfortably positive
	maxWindowK     = 1000 // cap at 1M tokens (user request)
)

// CompactionWindow returns the model context window in TOKENS for compaction
// thresholds, resolved from the user-configured size (ContextWindowK). 0/unset →
// a 200K default; otherwise clamped to [32K, 1M] so compaction stays effective.
func (c Config) CompactionWindow() int {
	k := c.ContextWindowK
	if k <= 0 {
		k = defaultWindowK
	}
	if k < minWindowK {
		k = minWindowK
	}
	if k > maxWindowK {
		k = maxWindowK
	}
	return k * 1000
}

// compactionConfig builds the agent-core compaction config for a context window
// in tokens. agentcore.NewSession wires the summarizer (same provider) when this
// is set on Options.Compaction.
func compactionConfig(windowTokens int) *compaction.Config {
	if windowTokens <= 0 {
		windowTokens = defaultWindowK * 1000
	}
	return &compaction.Config{ContextWindow: windowTokens}
}

// FromEnv resolves the LLM provider config:
//
//	ANTIFOX_LLM_PROVIDER = anthropic|openai (default: inferred from keys)
//	ANTIFOX_LLM_MODEL    = model id        (default: per provider)
//	ANTIFOX_LLM_BASE_URL = endpoint        (optional)
//	ANTIFOX_LLM_PROXY    = proxy URL        (optional; http/https/socks5)
//	ANTHROPIC_API_KEY / OPENAI_API_KEY         = credentials
func FromEnv() (Config, bool) {
	prov := os.Getenv("ANTIFOX_LLM_PROVIDER")
	anthKey := os.Getenv("ANTHROPIC_API_KEY")
	oaiKey := os.Getenv("OPENAI_API_KEY")

	if prov == "" {
		switch {
		case anthKey != "":
			prov = "anthropic"
		case oaiKey != "":
			prov = "openai"
		default:
			return Config{}, false
		}
	}

	c := Config{
		BaseURL: os.Getenv("ANTIFOX_LLM_BASE_URL"),
		Model:   os.Getenv("ANTIFOX_LLM_MODEL"),
		Proxy:   strings.TrimSpace(os.Getenv("ANTIFOX_LLM_PROXY")),
	}
	switch prov {
	case "openai":
		c.Format = llm.FormatOpenAI
		c.APIKey = oaiKey
		if c.Model == "" {
			c.Model = "gpt-4o"
		}
	default:
		c.Format = llm.FormatAnthropic
		c.APIKey = anthKey
		if c.Model == "" {
			c.Model = "claude-opus-4-8"
		}
	}
	if c.APIKey == "" {
		return Config{}, false
	}
	return c, true
}

// ConfigFrom builds a Config from UI-provided strings (provider defaults to
// anthropic; model defaults per provider). Inputs are trimmed and the base URL
// is normalized to the API base the provider expects (the provider appends the
// endpoint path itself), so a full endpoint URL is tolerated.
func ConfigFrom(provider, model, baseURL, apiKey, proxy string) Config {
	c := Config{
		Model:   strings.TrimSpace(model),
		BaseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		APIKey:  strings.TrimSpace(apiKey),
		Proxy:   strings.TrimSpace(proxy),
	}
	switch strings.TrimSpace(provider) {
	case "openai":
		c.Format = llm.FormatOpenAI
		// provider appends "/chat/completions"; tolerate a full endpoint URL.
		c.BaseURL = strings.TrimRight(strings.TrimSuffix(c.BaseURL, "/chat/completions"), "/")
		if c.Model == "" {
			c.Model = "gpt-4o"
		}
	default:
		c.Format = llm.FormatAnthropic
		// provider appends "/v1/messages".
		c.BaseURL = strings.TrimRight(strings.TrimSuffix(c.BaseURL, "/v1/messages"), "/")
		if c.Model == "" {
			c.Model = "claude-opus-4-8"
		}
	}
	return c
}

// Provider returns the short provider name ("anthropic"/"openai").
func (c Config) Provider() string {
	if c.Format == llm.FormatOpenAI {
		return "openai"
	}
	return "anthropic"
}

// NewProvider builds an llm.Provider from the config. When a rate is set, the
// limiter lives on the single provider instance — so planner + all workers +
// main agent (which share this provider) are bounded by one shared rate limit.
func (c Config) NewProvider() (llm.Provider, error) {
	lc := llm.Config{
		Format:  c.Format,
		BaseURL: c.BaseURL,
		APIKey:  c.APIKey,
		Model:   c.Model,
		Proxy:   c.Proxy,
	}
	// Derive the provider thinking params from the single UI selector:
	//   "" → omit both (provider default); "off" → disable; else → enable + effort.
	switch c.ReasoningEffort {
	case "":
		// leave both empty → omitted from the request
	case "off":
		lc.ThinkingType = "disabled"
	default:
		lc.ThinkingType = "enabled"
		lc.ReasoningEffort = c.ReasoningEffort
	}
	if c.RatePerSecond > 0 || c.RatePerMinute > 0 {
		lc.RateLimit = &llm.RateLimit{PerSecond: c.RatePerSecond, PerMinute: c.RatePerMinute}
	}
	// 自定义会话头：提供自带 HTTP client（含 proxy + 会话头 RoundTripper），引擎此时跳过
	// 按 lc.Proxy 自建 client，故 proxy 必须由本 client 自己施加。
	if hk := strings.TrimSpace(c.SessionHeaderKey); hk != "" {
		client, err := sessionHeaderClient(c.Proxy, hk)
		if err != nil {
			return nil, err
		}
		lc.HTTPClient = client
	}
	return llm.NewProvider(lc)
}

// sessionHeaderTransport sets a custom HTTP header (name=key) on every request, value =
// the session id carried on the request context (transcript.SessionIDFrom). Skipped when
// no session id is present, so non-agent calls aren't tagged.
type sessionHeaderTransport struct {
	base http.RoundTripper
	key  string
}

func (t sessionHeaderTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if sid := transcript.SessionIDFrom(req.Context()); sid != "" {
		req = req.Clone(req.Context())
		req.Header.Set(t.key, sid)
	}
	return t.base.RoundTrip(req)
}

// sessionHeaderClient builds an http.Client that applies the proxy (same scheme support
// as the engine default: http/https/socks5, else *_PROXY env) and wraps it so every
// request carries the session-id header.
func sessionHeaderClient(proxy, headerKey string) (*http.Client, error) {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	if p := strings.TrimSpace(proxy); p != "" {
		u, err := url.Parse(p)
		if err != nil {
			return nil, fmt.Errorf("invalid LLM proxy %q: %w", proxy, err)
		}
		switch u.Scheme {
		case "http", "https", "socks5":
		default:
			return nil, fmt.Errorf("unsupported proxy scheme %q (use http, https or socks5)", u.Scheme)
		}
		tr.Proxy = http.ProxyURL(u)
	} else {
		tr.Proxy = http.ProxyFromEnvironment
	}
	return &http.Client{Transport: sessionHeaderTransport{base: tr, key: strings.TrimSpace(headerKey)}}, nil
}

// TestConnection makes a minimal real completion to verify the provider/model/
// endpoint/key actually work. Returns the round-trip latency.
func TestConnection(ctx context.Context, c Config) (time.Duration, error) {
	prov, err := c.NewProvider()
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	start := time.Now()
	_, err = agentcore.Run(ctx, agentcore.Options{
		Provider:       prov,
		SystemPrompt:   []string{"你是连接测试。只回复 OK，不要别的。"},
		PermissionMode: acperm.ModeBypass,
		MaxTurns:       1,
		MaxTokens:      32,
	}, "ping")
	return time.Since(start), err
}
