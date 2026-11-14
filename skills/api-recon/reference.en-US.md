# api-recon — Reference Manual

Grep recipes, `config.json` templates, and troubleshooting. Run all greps against the `js/` directory. For single-line bundles, you can first run `js-beautify` or `sed 's/}/}\n/g'`; usually a raw grep with a context window suffices.

## Script Notes

All files in `scripts/` are **reference templates** and must be adapted to the target site before execution. Typical adjustment points:

| Script | Common items to adjust |
|---|---|
| `harvest_static.py` | endpoint regex, webpack/Vite manifest parsing, micro-frontend publicPath, retries/concurrency |
| `runtime_harvest.js` | neutralize field names and success values, stub matching rules and body shapes, routes source, WS recording, `waitUntil`/`routeTimeout`/`proxy` |
| `preload.js` | `loginPathRe`, L1 stubs, `neutralize.fields`, `apiPattern`, whether to enable L3, `recordDetail`, `observe.*`, `neutralizeVueRouter` |
| `spider_mpa.py` | `--exclude` destructive links, cookies, depth/max, same-domain filtering |
| `extract_route_map.py` | `routeMap` / `routeLink` regexes, KEY naming patterns |
| `build_perm_tree.py` | `userRouteAuth` parsing, `ROOTS`/`PREFIX_PARENT` hierarchy heuristics, stub outer field names |
| `config.json` | unified entry point for all of the above site-specific parameters |

Put adjusted files in the task working directory (e.g. `recon/`) and note the specific changes relative to the reference scripts in your report.

---

## A. Reverse Engineering the Three Gates

### A1. Render Gate — "How does the app decide you are logged in?"

```bash
grep -rhoaE '.{0,40}(isLogin|isAuthenticated|loggedIn|hasLogin|requireAuth)\b.{0,80}' js | head
grep -rhoaE 'function (getUser|getToken|getAuth)[0-9]?\([^)]*\)\{.{0,200}' js | head
grep -rhoaE '(localStorage|sessionStorage)\.getItem\("[^"]+"\)' js | sort -u
grep -rhoaE '(Cookies?|cookie)\.(get|load)\("[^"]+"\)' js | sort -u
grep -rhoaE '\batob\(|JSON\.parse\(|jwt|decode' js | head
```

Find the chain `isLogin = f(getUser())` → `getUser = decode(storage.read(KEY))` and determine the **storage key**, **container** (Cookie vs localStorage), and **encoding**:

| Encoding | How to forge in config |
|---|---|
| Plain string / `"1"` / token | `"value": "anything-truthy"` |
| `JSON.parse(x)` | `"value": "json:{\"id\":1,\"username\":\"admin\"}"` |
| `JSON.parse(atob(x))` | `"value": "b64json:{\"id\":1,\"username\":\"admin\"}"` |
| JWT | unsigned/`alg:none` JWT, or sign with the key found in the bundle |
| Encrypted (SM2/AES/RSA) | find the hardcoded key; for the render gate, forge only if a decodable blob suffices; otherwise fall back to static |

→ write into `cookies` / `localStorage`.

### A2. Interceptor Gate — "What triggers a redirect to /login?"

```bash
grep -rhoaE '.{0,60}(interceptors\.response|axios|request\.use).{0,120}' js | head
grep -rhoaE '.{0,40}(response_code|errcode|errno|\bcode\b|\bret\b|\bstatus\b)\s*[=!]==?\s*[\-0-9]{1,4}.{0,60}' js | head -20
grep -rhoaE '.{0,40}(未登录|请重新登录|登录已过期|unauthorized|登录失效|授权|token.{0,10}invalid).{0,40}' js | head
grep -rhoaE '.{0,30}(location\.href|router\.(push|replace)|navigate)\([^)]*login[^)]*\)' js | head
```

Determine: the **field name**, the **success value** (usually `0` or `200`), and the **failure value that triggers the redirect**. Verify with a junk session:

```bash
curl -sk -X POST -H 'Cookie: <fakekey>=junk' https://target/api/<protected> -d '{}' -H 'Content-Type: application/json'
```

→ write into `neutralize.fields` + `neutralize.success`.

### A3. Content Gate — "Where do menus/permissions come from?"

```bash
grep -rhoaE '"/api[^"]*(permission|perm|role|menu|acl|resource|nav)[^"]*"' js | sort -u
grep -rhoaE '.{0,30}(menus|permissions|menuList|routeList|authList|role_permissions)\b.{0,120}' js | head
grep -rhoaE 'userRouteAuth|getResultTree|routeMap|routeLink|hasPermission|checkAuth' js | head
grep -rhoaE '([A-Z_][A-Z0-9_]*):\{name:"[^"]*",link:"/[^"]+"\}' js | head
```

**Two layers of data** (typical enterprise backends):

| API | Typical payload | Consumer |
|---|---|---|
| `.../role_permissions` | `{ permissions: string[], role_type }` | route guards, button-level ACL |
| `.../permissions/all` | `tree[{ code, position, children }]` | sidebar menu rendering |
| `userRouteAuth` in the bundle | `{ CODE: { url, name? } }` | code → frontend path |
| `routeMap` in the bundle | `{ KEY: { name, link } }` | alias resolution (webpack `o.DASHBOARD`) |

Read the consumer code to confirm: how `getResultTree(tree, permissions)` filters, and which field `v-if` / `hasAuth(code)` checks.

**Manual forge** (small sites): build a permissive payload → `stubs`.

**Full permission tree restoration** (large sites where the sidebar/submodules remain blank): see **section I**.

---

## B. config.json Template

```json
{
  "baseUrl": "https://target/",
  "runtimeMode": "both",
  "chromium": "/usr/bin/chromium",

  "cookies": [
    { "name": "auth", "value": "b64json:{\"id\":1,\"username\":\"admin\",\"role\":\"admin\",\"func\":{},\"permissions\":[\"*\"]}" }
  ],
  "localStorage": { "token": "faketoken", "isLogin": "1" },

  "neutralize": {
    "fields": ["response_code", "code", "errno", "ret", "status"],
    "success": 0,
    "flags": { "success": true, "message": "ok" }
  },
  "forward": true,
  "loginUrlPattern": "/login",
  "apiPattern": "/api/|/rest/|/graphql",

  "mockTier": "L1+L2",
  "recordDetail": true,
  "observe": {
    "storageReads": false,
    "cookieReads": false,
    "xhrHeaders": true
  },
  "neutralizeVueRouter": true,
  "stubs": [
    {
      "match": "permissions/all|/menu|role_permissions",
      "body": {
        "response_code": 0, "code": 0,
        "data": {
          "permissions": ["*"],
          "menus": [
            { "name": "dashboard", "path": "/dashboard", "show": true, "children": [] },
            { "name": "alert", "path": "/alert", "show": true, "children": [] }
          ]
        }
      }
    }
  ],

  "explore": {
    "clickTabs": true,
    "clickTables": true,
    "pushStateFallback": true,
    "maxMenuItems": 50
  },

  "routes": ["/dashboard", "/alert", "/asset", "/device", "/report", "/config", "/system"],
  "waitMs": 1500, "perRouteMs": 900, "headless": true,
  "waitUntil": "domcontentloaded",
  "routeTimeout": 12000,
  "proxy": "",

  "captureResponses": true, "recordWs": true, "respMax": 600
}
```

Field notes:
- `runtimeMode`: `depth` (Puppeteer), `coverage` (browser MCP), `both`
- `cookies[].value` prefixes: `b64json:` → base64(JSON); `json:` → raw JSON; no prefix → literal
- `forward: true` forwards real requests and patches the code fields; `false` is fully offline stubbing
- `mockTier`: the layers the preload enables in coverage mode, e.g. `L1+L2`, `L1+L2+L3`
- `routes` comes from `routes.txt`; after forging menus the harness auto-appends `<a href>` entries
- `captureResponses` / `recordWs` only take effect in depth mode
- `waitUntil`: use `domcontentloaded` for large SPAs to avoid `networkidle2` hangs
- `routeTimeout`: per-route `page.goto` timeout (milliseconds)
- `proxy`: Puppeteer `--proxy-server`; you can also set `HTTP_PROXY` / `HTTPS_PROXY`

### B1. Dual Stub Template (role_permissions + permissions/all)

```json
"stubs": [
  {
    "match": "role_permissions",
    "body": {
      "response_code": 0,
      "data": {
        "permissions": ["MONITOR", "MONITOR_ALERT", "THREAT", "ASSETS_RISK"],
        "role_type": "SUPER_ADMIN"
      }
    }
  },
  {
    "match": "permissions/all",
    "body": {
      "response_code": 0,
      "data": [
        {
          "code": "MONITOR",
          "position": 1,
          "children": [
            { "code": "MONITOR_ALERT", "position": 1, "children": [] }
          ]
        }
      ]
    }
  }
]
```

The outer field names (`response_code` / `code` / `data`) must match the A2 interceptor gate; `permissions` must cover every leaf code in the tree.

---

## C. Coverage Mode: preload Configuration

Edit the `CONFIG` object at the top of `scripts/preload.js`, or replace it before injecting via CDP:

```javascript
const CONFIG = {
  loginPathRe: /\/(login|signin)(\/|$|\?)/i,
  mockTier: 'L1+L2',
  forward: true,
  recordDetail: true,
  extractUrlsFromResponse: true,
  neutralizeVueRouter: true,
  observe: { storageReads: false, cookieReads: false, xhrHeaders: true },
  neutralize: { fields: ['response_code', 'code'], success: 0 },
  stubs: [ /* same as config.json stubs */ ],
  apiPattern: /\/(api|apis|v\d+|dev|internal|graphql)\//i,
};
```

Verify: `window.__API_RECON_PRELOAD__ === true` and the pathname is stable.

Export the recording results:

```javascript
JSON.stringify({
  apis: [...window.__API_RECON_LOG__],
  detail: window.__API_RECON_DETAIL__,
  routes: [...(window.__API_RECON_ROUTES__ || [])],
  observe: window.__API_RECON_OBSERVE__,
}, null, 2)
```

---

## D. preload / runtime Hook Capabilities

The built-in browser hook capabilities of preload (coverage) and runtime_harvest (depth), and their coverage:

| Hook capability | Value for API discovery | Coverage |
|---|---|---|
| Hook fetch / XHR.open | record request URL/method | ✅ `recordDetail` + `__API_RECON_LOG__` |
| Hook XHR.setRequestHeader | discover headers like Authorization | ✅ `observe.xhrHeaders` |
| Hook localStorage/cookie reads | confirm session key names | ⚠️ optional `observe.storageReads/cookieReads` |
| Vue router capture | complete frontendRoutes | ✅ `__API_RECON_ROUTES__` (loaded routes) |
| Vue route guard neutralization / login redirect blocking | pry open modules to trigger APIs | ✅ `neutralizeVueRouter` + native redirect neutralization |
| React router capture | supplement routes | ⚠️ static + clicks; no dedicated hook |
| Page navigation blocking (login paths) | stay on page for analysis | ⚠️ blocks login paths only, to avoid breaking business navigation |
| Hook crypto libraries (CryptoJS/SM etc.) | encrypted params → plaintext API body | ❌ must manually hook the crypto function's arguments; write conclusions into config |
| Anti-debugging bypass | otherwise runtime records no APIs | ❌ must be handled manually; static still works |

---

## E. Endpoint Extraction Regexes (When Static Yields Too Little)

Loosen them in `harvest_static.py`'s `extract_endpoints`, or do it manually:

```bash
grep -rhoaE '"/[a-z][A-Za-z0-9_/\-]{3,}"' js | sort -u
grep -rhoaE '/api/[a-zA-Z0-9_./-]+' js | sort -u
```

---

## F. Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| Very few static APIs | endpoint dialect mismatch → loosen the regex (section D) |
| Chunk count ≪ manifest | CSS-only or undeployed chunks; 404s already retried |
| Runtime still shows the login page | wrong render gate → recheck A1: key name, container, encoding, domain |
| Shell entered but modules blank | content gate → forge menus (A3); the `routes` paths may be wrong |
| Only bootstrap/locale per route | incomplete permission codes → section I permission tree restoration; check the `role_permissions` + `permissions/all` dual stub |
| Sidebar has items but sub-pages blank | the tree lacks intermediate nodes, or codes mismatch `userRouteAuth` |
| Every API redirects to login | interceptor gate → confirm `neutralize`; nested fields may need extended walk logic |
| 0 WS frames | subscription happens only after user interaction; increase `perRouteMs` |
| Empty response bodies | real responses exist only with `forward: true` |
| Chromium missing | install chromium or set `config.chromium` / `CHROMIUM` |
| Many mocks yet still bounced to login | hook too late or missing `location.href` setter → document-start + preload |
| Lists all empty | empty arrays are normal with L3; keep clicking tabs/settings/details |
| Mistaking Redux actions for routes | filter internal paths containing get/set/change/clear/toggle/upload |
| Vue still redirects to login | preload not at document-start → fix the injection timing; or manually clear guards when `neutralizeVueRouter: false` |
| URLs in responses but not in the log | enable `extractUrlsFromResponse`; or manually extract from `__API_RECON_DETAIL__` |
| Unknown Authorization header name | enable `observe.xhrHeaders` or inspect request headers in DevTools |
| Runtime very slow / timeouts | use `waitUntil: domcontentloaded`; lower `routeTimeout`; do not use `networkidle2` |
| Proxy connection failures | check `proxy` / environment variables; Puppeteer and curl must use the same proxy port |

---

## G. Hardened Targets

When the server validates the session step by step (non-forgeable signed cookies, server-rendered menus that cannot be stubbed), runtime will get stuck at the shell. Expected behavior:

- **Static is sufficient for endpoint enumeration** — module paths are in the code
- If authorization allows, run the same harness with a **real session**: `forward: true`, no neutralize, capturing real methods/params/responses

---

## H. Single-Task Checklist

1. Confirm the authorized scope
2. **Read** `scripts/harvest_static.py` → adapt for the target → run → review `api_static.txt`, `routes.txt`
3. **Phase 1b**: path anchor window expansion + binding layer → `param_candidates.json` (section J)
4. Reverse engineer A1/A2/A3 → write a site-specific `config.json`
5. **Read and adjust** `runtime_harvest.js` / `preload.js` before executing
6. `runtimeMode=depth`: `npm install` → run the adjusted harvest script
7. `runtimeMode=coverage/both`: document-start injection of the adjusted preload → browser MCP dynamic enumeration + **parameter trigger matrix**
8. Modules do not render → **section I permission tree restoration** → patch stubs → re-run
9. Multi-sample parameter diff + error-based inference → `params_merged.json`
10. Merge → `site_map.json` + `api_merged.txt`, honestly noting coverage, gaps, and script changes

---

## I. Permission Tree Restoration (Phase 4 Deep Dive)

Use this when forging a simple `menus: [{ path, show: true }]` does not work and submodules still do not mount.

### I1. Locate the Auth Module

```bash
grep -l 'userRouteAuth' js/*.js
grep -l 'routeMap\|routeLink' js/*.js
grep -rhoaE 'getResultTree|role_permissions|permissions/all' js | head
```

Record: the **permission API paths**, **response field names**, and **consuming chunk filenames**.

### I2. Extract the routeMap

```bash
python3 scripts/extract_route_map.py recon/js recon/
# produces recon/route_map.json
```

If `[!] no routeMap pattern found`: loosen the regexes in `extract_route_map.py`, or grep manually:

```bash
grep -rhoaE '([A-Z_][A-Z0-9_]*):\{name:"[^"]*",link:"/[^"]+"\}' js | head -20
```

### I3. Build the Permission Tree + Stubs

```bash
python3 scripts/build_perm_tree.py recon/js recon/ --config recon/config.json
```

Script logic:
1. Parse `userRouteAuth={MONITOR:{url:...},...}` (including webpack aliases like `He=o.DASHBOARD`)
2. Resolve aliases → real paths using `route_map.json`
3. Infer parents from code prefixes (`MONITOR_ALERT` → `MONITOR`)
4. Output `permissions_tree.json`, `permissions_all_stub.json`, `role_permissions_stub.json`
5. With `--config`, automatically write `config.json`'s `stubs` and extend `routes`

**Adapt per target** (at the top of the script):
- `DEFAULT_ROOTS`: list of top-level module codes
- `DEFAULT_PREFIX_PARENT`: `PREFIX_` → parent mapping
- `DEFAULT_EXTRA_PARENT`: orphan nodes without prefix relationships

### I4. Verify Stub Consistency

```bash
# the number of permissions should be ≈ the number of userRouteAuth entries
wc -l recon/perm_codes_all.txt
# routes should cover every link in route_map
python3 -c "import json; m=json.load(open('recon/route_map.json')); r=set(json.load(open('recon/config.json'))['routes']); print('missing', [v['link'] for v in m.values() if v['link'] not in r])"
```

### I5. Re-run Runtime and Compare

```bash
node recon/runtime_harvest.js recon/config.json
# compare runtime_api.json entry counts before/after forging; check whether module APIs like /attack, /asset appear
```

| Before forging | After forging (success) |
|---|---|
| The same 3–5 bootstrap calls per route | different routes trigger different module APIs |
| Only `/api/locale/language` | `/api/web/...` module endpoints appear |
| Single-digit routes in `routes.txt` | 80–110+ `routes` from route_map |

### I6. If It Still Fails

- **Coverage mode**: click the sidebar + tabs; permission gating may only request after interaction
- **Stub fields**: compare the real API (curl + real session) with the stub's nesting
- **Extra guards**: grep for button-level checks like `hasPermission|checkRole|func.` and extend `role_permissions.permissions`
- **Static fallback**: module API paths remain in `api_static.txt`; runtime only adds METHOD/body; keep parameters in `param_candidates.json` + recorded samples

---

## J. Parameter Reverse Engineering (Phase 1b / 5b / 5c)

**A methodology, not a universal script.** Find paths with regexes; find parameters with anchor window expansion + UI binding chains + multi-sample diff + error-based inference.

### J1. Anchor Window Expansion — From Path to Request-Building Object

```bash
# use known paths from Phase 1 as anchors
grep -n '"/api/user/list"' js/*.js
grep -rhoaE '.{0,120}("/api[^"]+").{0,200}' js | head
grep -rhoaE '(params|data|body|payload)\s*:\s*\{' js | head
grep -rhoaE '(get|post|put|delete|patch)\([^,]+,\s*\{' js | head
```

### J2. Wrapping Layers and Transport Shapes

```bash
# axios / unified request
grep -rhoaE '(axios|request)\.(get|post|put|delete|patch)\(' js | head
grep -rhoaE 'interceptors\.(request|response)' js | head

# GraphQL
grep -rhoaE '(query|mutation)\s+\w+|gql`|graphql\(' js | head
grep -rhoaE '\$[a-zA-Z_]+\s*:\s*(Int|String|Boolean|\[)' js | head

# FormData / multipart
grep -rhoaE 'FormData|\.append\(' js | head

# path parameters
grep -rhoaE 'path:\s*"/[^"]*:[^"]+"' js | head
grep -rhoaE 'useParams|route\.params|\$route\.params' js | head
```

### J3. Validation Gate — Required / Format / Enum

```bash
grep -rhoaE '(required|message|pattern|enum|validator)\s*:' js | head
grep -rhoaE 'yup\.|zod\.|async-validator|Form\.Item|a-form-item|el-form-item' js | head
grep -rhoaE 'rules\s*:\s*\[|name:\s*["\'][a-zA-Z_]+["\']' js | head
grep -rhoaE 'label.*value|options\s*:\s*\[' js | head
```

### J4. Binding Layer — Form → API

```bash
grep -rhoaE 'onFinish|handleSubmit|getFieldsValue|validateFields' js | head
grep -rhoaE '(pick|omit|transform|dayjs|moment)\(' js | head
```

Runtime backfill: DevTools → Network → request → **Initiator** (call stack); trace upward from `fetch`/`send` to the request-building function.

### J5. Encrypted Parameters

```bash
grep -rhoaE 'encrypt|decrypt|sign|CryptoJS|sm2|sm3|sm4|RSA|AES' js | head
```

**Do not guess fields from ciphertext** — hook the crypto function's **inputs** and record the plaintext payload before encryption; write conclusions into `config.json` / `param_candidates.json`.

### J6. Parameter Trigger Matrix (Mandatory in Phase 3)

For each module, record once per operation and diff the request body/query:

| Operation | Watch for |
|---|---|
| List first screen | pagination defaults |
| Search | keyword, filters |
| Advanced filter | optional fields |
| Create/edit | full entity |
| Bulk/export | `ids[]`, `exportType` |
| Sort/paginate | `sortField`, `order` |

Produces `param_samples.json`: `[{ "path", "method", "action": "search", "body", "query", "headers" }]`

### J7. Confidence Rules

| Confidence | Condition |
|---|---|
| **High** | static callsite + ≥2 consistent runtime samples |
| **Medium** | static only, or only 1 runtime occurrence |
| **Low** | inferred from responses/errors, not double-verified |
| **Pending trigger** | field known statically but UI/permissions never reached it |

### J8. Quick Recipes by Scenario

| Scenario | Order |
|---|---|
| REST list page | J1 request object → J6 four-way diff → J3 rules |
| Create/edit form | J3 Form name → J4 submit chain → runtime submit + intentionally leave blank to see the 400 |
| GraphQL | J2 variable declarations → runtime record variables for each operation |
| Encrypted body | J5 hook the inputs → pre-encryption fields are the real params |

### J9. Mapping to api-recon Phases

| api-recon | Parameter recon |
|---|---|
| Phase 1 static | J1 anchor window expansion |
| Phase 2 A2 interceptor | globally injected fields (tenantId, sign) |
| Phase 3 runtime | J6 trigger matrix + `param_samples.json` |
| Phase 4 permission tree | different modules have different forms → full fields only trigger with enough permissions |
| Phase 5 merge | `params_merged.json` + confidence; never determine required fields from a single sample |

### J10. Troubleshooting

| Symptom | Fix |
|---|---|
| Static field names never appear at runtime | mark "pending trigger"; complete the permission tree / click advanced filters / try each option of linked selects |
| Same path with different body shapes | normal — record separate entries per `action`, do not force-merge schemas |
| Stub responses are fake but you want the params | **look at the outbound request** body/headers; do not infer from stub responses |
| 400 reports a nested field | watch the outer wrapper `data`/`bizData`/`variables` |
| GraphQL shows only the operation name | expand the `variables` JSON; find `$var: Type` statically |

---
