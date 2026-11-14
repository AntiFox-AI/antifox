---
name: api-recon
description: Invoke this skill when reconnaissance of a website's API interfaces is needed.
---

# API Recon (Frontend Interface Reconnaissance)

Under an **authorized** engagement, discover as completely as possible: **backend APIs** (paths, methods, parameters, response bodies), **frontend routes**, and **UI feature trigger points** (tabs, modals, table operations, etc.).

---

## Boundaries and Prohibitions (Agent must read · violations mean going out of scope)

This skill does **API / parameter-surface reconnaissance only** — it is not the vulnerability-hunting or exploitation phase.

### Task Boundaries

| Scope | Allowed | Prohibited |
|---|---|---|
| **Target** | Enumerate paths, methods, parameters, routes, UI trigger points | SQLi/XSS/privilege escalation/brute-force/fuzz vulnerabilities, request-tampering attacks, destructive operations |
| **Authentication** | Hook + stub/mock to bypass the **client-side** login gate | Asking the user for or guessing credentials; attempting real login form submissions |
| **Runtime** | Hooking APIs without credentials, using mock responses to get the SPA into its post-login shell | Flows that depend on a real backend session to proceed |

### Credential-less Dynamic Analysis (Phase 3 Default)

1. Via `preload.js` / `runtime_harvest.js`, **intercept and stub** login, permission, menu, and other bootstrap APIs;
2. Return mock bodies for business query APIs that are **structurally correct, carry a success business code, and may contain empty data**;
3. Let the frontend still render the post-login page in a no-backend or 401 environment, thereby triggering more XHR/fetch/WebSocket traffic;
4. **Empty data, blank tables, and placeholder UI are all expected** — do not pivot to real logins or vulnerability testing because of them.

**In one sentence**: use mocks to pry open the frontend routes and component mounting, and **only record outbound requests**; what the backend returns does not matter — what matters is **which other APIs the frontend still sends**.

### Hard Process Prohibitions

| Prohibited | Do this instead |
|---|---|
| Before Phase 1 completes, grep/curl/Read the main entry `index-*.js` to extract API paths | Run `OUTDIR/harvest_static.py` |
| Hand-writing a replacement script such as `extract_apis.py` instead of using harvest | Modify `OUTDIR/harvest_static.py` and re-run |
| Repeating the same grep/command after it has failed ≥2 times | Change strategy: read tool_logs, adjust harvest, consult the reference |
| Skipping gates A/B and running the originals in `scripts/` directly | Copy to OUTDIR and adapt for the target |
| Real usernames/passwords, OTP, OAuth, or other authentication | stub/mock (see above) |
| Skipping stubs under the pretext of "getting real data", or doing privilege-escalation/injection testing | Only record outbound traffic — that is the recon boundary |
| Irreversible operations such as deletion, exporting sensitive data, or bulk writes | Applies to coverage clicks too |
| Claiming all pages and APIs are captured before runtime + dynamic enumeration are complete | See "Definition of Done" or note the limitations |
| Claiming all parameters are known before completing the parameter trigger matrix + diff | Phase 3b matrix + Phase 5 diff |
| Inferring required/optional from a single runtime sample | Multi-sample diff, or derive from validation rules/errors |

---

## Two-Layer Model + Run Modes

| Layer | Output | Limits |
|---|---|---|
| **Static** (JS bundle) | Full endpoint paths, draft routes, request-building field candidates | No HTTP methods; parameters need Phase 1b; misses runtime-concatenated URLs |
| **Runtime** (live session) | Methods + bodies + responses + dynamic URLs + WS/SSE; multi-sample diff completes parameters | Pages must actually render to send requests; a single sample is insufficient to determine required/optional |

| Run mode | Engine | Best for |
|---|---|---|
| **depth** | `runtime_harvest.js` (Puppeteer) | API inventory, METHOD/params/response bodies, WS/SSE, reproducible batch runs |
| **coverage** | browser + `preload.js` | Clicking tabs/modals/tables for deeper feature-point coverage |
| **both** | depth first, then coverage | Most complete, most time-consuming |

**Parameter methodology** (no universal script): paths via harvest/regex; parameters via **anchor window expansion + UI binding chains + multi-sample diff + error-based inference** (grep recipes in [reference.md](reference.md), section J).

---

## Definition of Done

All must be satisfied before claiming recon is complete:

- [ ] **Static**: Phase 1 harvest produces `api_static.txt`, `routes.txt`, `js/`
- [ ] **Runtime**: at least one of depth or coverage; coverage/both requires **Hook active + dynamic enumeration loop**
- [ ] **Shell entry**: visiting business paths does not land on `/login` (watch out for hash routing)
- [ ] **Parameters**: coverage/both completes the parameter trigger matrix + `param_samples.json`; Phase 5 merges `params_merged.json`
- [ ] **Depth** (if module pages are blank): Phase 4 permission-tree restoration and re-run, until **module-level APIs** appear (not just locale/bootstrap)
- [ ] **Delivery**: Phase 5 outputs complete (see the Phase 5 output table); `insert_assets` writes service and endpoint assets

---

## Scripts and Gates

`scripts/` are reference templates only; **running the originals directly and treating the output as final is prohibited**.

**Rules**: read first → adapt for the target → write into `OUTDIR` (e.g. `recon/`) → record in `CHANGES.md`; if it does not fit, rewrite per the methodology and borrow only the structure.

| Gate | When | Reference script → OUTDIR copy | Common must-change items |
|---|---|---|---|
| **A (static)** | After Phase 0, **before the first** harvest/spider run | `harvest_static.py` / `spider_mpa.py` | **For most sites the default regex just works**; only adjust the endpoint regex, webpack/Vite `publicPath`, and MPA exclude/cookie when the manifest/dialect does not match |
| **B (runtime)** | After Phase 2, before running depth/coverage | `runtime_harvest.js` / `preload.js` + `config.json` | Cookie/localStorage keys, neutralize success values, stubs, login regex, api prefixes, hash/history |

**Mandatory SPA order** (not swappable; Phase numbering takes precedence over "explore first, script later"):

| Step | Required | Prohibited |
|---|---|---|
| After Phase 0 completes | Next Bash command = `python3 OUTDIR/harvest_static.py <URL> OUTDIR` | curl/grep/Read the main entry `index-*.js` (usually >500KB) |
| Gate A | Copy script → make small adjustments → **run immediately** | Manually extracting APIs first, then deciding whether to harvest |
| Before Phase 1 completes | Verify outputs with `wc -l`; on 404s fix harvest and retry | Hand-writing extract scripts; repeatedly grepping URLs that were never downloaded |
| From Phase 1b on | grep only `OUTDIR/js/*.js` | Substituting the main bundle for harvest |

- ✅ Copy `harvest_static.py` → (optionally) adjust regex → **run immediately**
- ❌ curl the main bundle → grep repeatedly → write a throwaway extract → harvest only at the end
- **MPA**: after Phase 0, the next Bash command = `python3 OUTDIR/spider_mpa.py ...`

---

## Tool and Output Constraints

| Constraint | Explanation |
|---|---|
| Large files | Reading/grepping `index-*.js` over 100KB into context is **prohibited**; use OUTDIR scripts for batch processing |
| grep output | Must use `\| head -20` or `-m 5`; keep only path summaries in the conversation, do not paste bundle fragments |
| Verification | Use `wc -l`, `ls \| wc -l`; do not Read entire directories |
| Regex probing | Optional, ≤1 time, only for ≤50KB small chunks or HTML; the official static pass is harvest |
| reference | For recipes/templates/troubleshooting see [reference.md](reference.md); do not inline the whole thing repeatedly |

---

## Execution Roadmap

```
Phase 0 classify + OUTDIR
  → Gate A → Phase 1 harvest (★ run immediately ★)
  → Phase 1b parameter reverse engineering
  → Phase 2 three auth gates → config.json
  → Gate B → Phase 3 runtime + parameter matrix
  → Phase 4 permission tree (if needed) → re-run Phase 3
  → Phase 5 merge report + insert_assets to batch-insert all discovered service and endpoint API assets; when inserting, no discovered asset may ever be omitted
```

Check off in order; **do not enter the next Phase until the previous item is complete**.

1. [ ] **Phase 0**: initial SPA/MPA triage; create `OUTDIR` → [Phase 0](#phase-0--classification)
2. [ ] **Gate A + Phase 1**: copy script → harvest **immediately** → verify with `wc -l` → [Phase 1](#phase-1--static)
3. [ ] **Phase 1b**: anchor window expansion + binding layer → `param_candidates.json` → [Phase 1b](#phase-1b--parameter-reverse-engineering)
4. [ ] **Phase 2**: three auth gates → `config.json` → [Phase 2](#phase-2--three-auth-gates)
5. [ ] **Gate B**: adjust runtime scripts → [Phase 3](#phase-3--runtime)
6. [ ] **Phase 3**: depth / coverage / both; confirm shell entry; parameter trigger matrix → `param_samples.json`
7. [ ] **Phase 4** (if needed): permission tree → patch stubs → re-run Phase 3 → [Phase 4](#phase-4--permission-tree-restoration)
8. [ ] **Phase 5**: merge outputs + report + `insert_assets` → [Phase 5](#phase-5--merge-and-report)

---

## Phase 0 — Classification

Fetch the entry HTML, **create `OUTDIR`** (do not modify `scripts/` inside the skill):

- **SPA**: empty shell + `<div id=app>` + chunks → Phases 1–5
- **MPA**: SSR + `<form>`, no endpoint bundle → after Gate A:

```bash
python3 recon/spider_mpa.py <BASE_URL> <OUTDIR> [--cookie "session=..."] [--max 300] [--depth 5] [--exclude "logout|delete|destroy"]
```

Produces `forms.txt`, `links.txt`, `api_inline.txt`. For an SPA, if forms ≈ 0 → move to Phase 1.

---

## Phase 1 — Static

Follow [Scripts and Gates](#scripts-and-gates) · [Tool and Output Constraints](#tool-and-output-constraints).

```bash
python3 recon/harvest_static.py <BASE_URL> <OUTDIR>
```

harvest: parse the HTML scripts → webpack/Vite manifest → download all lazy chunks → produce `js/`, `api_static.txt`, `routes.txt`, `chunkmap.txt`.

```bash
wc -l OUTDIR/api_static.txt OUTDIR/routes.txt
ls OUTDIR/js | wc -l
```

- Chunk count vs manifest: 404s require fixing harvest and retrying; do not hand-curl each chunk
- Too few entries in `api_static.txt` → loosen the endpoint regex inside OUTDIR and re-run (see reference)

### Phase 1b — Parameter Reverse Engineering

Paths come from Phase 1; parameter fields need separate recon. See [Tool and Output Constraints](#tool-and-output-constraints) for grep rules.

**Completion criteria**: for important APIs you can answer — field names, transport location, type inference, whether required, sample values, confidence.

#### 1b.0 — Transport Shapes

| Shape | Where parameters live | Static priority |
|---|---|---|
| REST JSON | body + query | `(params\|data\|body)\s*:\s*\{` next to the path anchor |
| GraphQL | `variables` | gql templates, `$page: Int` |
| Traditional form | urlencoded | `<form>`, `FormData` |
| File upload | multipart | `FormData.append` |
| Path parameters | `/user/:id` | route table + `useParams` / `$route.params` |
| Encrypted/signed | wrapped in `sign`/`data` | Hook the crypto function's arguments (reference section D) |

Output: annotate each API with `transport: query|json|form|graphql|encrypted`.

#### 1b.1 — Anchor Window Expansion

Use known paths as anchors and widen the window to find request-building objects:

```bash
grep -n '"/api/user/list"' OUTDIR/js/*.js | head -20
grep -rhoaE '.{0,120}("/api[^"]+").{0,200}' OUTDIR/js/*.js | head -20
grep -rhoaE '(params|data|body|payload)\s*:\s*\{' OUTDIR/js/*.js | head -20
```

| Wrapping layer | Parameter clues |
|---|---|
| axios instance | `data` / `params` |
| Unified request | interceptor-injected global fields |
| OpenAPI client | generated method signatures |
| React Query / SWR | the hook's second argument |
| Vue composable | composable inputs |

Type residue: `yup`/`zod`/rules, `Form.Item name=`, embedded Swagger.

→ `param_candidates.json`: `{ path, fields[], source: "static-callsite", confidence }`

#### 1b.2 — Binding Layer

```
Form field → onFinish/handleSubmit → transform → API payload
```

| Binding source | Technique |
|---|---|
| Form submit | Follow submit → transform → API |
| Table search | `getFieldsValue()` → `params` |
| Route | `:id` / `?tab=` |
| Interceptor | global `tenantId`, pagination, sign |
| Enum select | `options` → API enum values |

From the DevTools call stack, trace upward from `fetch`/`XHR.send` to the request-building function.

#### 1b.3 — Three Request-Building Questions (≠ Phase 2's three auth gates)

| Question | What to answer |
|---|---|
| **Assembly** | where the payload is built, traces of transforms |
| **Validation** | required, pattern, enum |
| **Transport** | path / query / body / multipart / headers |

While handling the interceptor gate (Phase 2), also read globally injected fields (Authorization, `X-Tenant-Id`, sign).

#### 1b.4 — Handoff to Phase 3

Candidate fields come from static/binding layers; **required/optional/conditional dependencies** need the Phase 3 parameter matrix + diff + Phase 5 error-based inference.

---

## Phase 2 — Three Auth Gates

Grep in `OUTDIR/js/` (with `head`), write results into `config.json` (recipes in the reference):

| Gate | Question | Keywords |
|---|---|---|
| **Render gate** | How does the app decide you are logged in? | `isLogin`, `getToken`, Cookie/localStorage |
| **Interceptor gate** | What triggers a redirect to `/login`? | `response_code`, `errno`, axios interceptor |
| **Content gate** | Where do menus/permissions come from? | `menu`, `permission`, `role`, `acl`, `routes` |

Do not treat localStorage key names as credentials — confirm them from chunks/request chains.

**Exit = Gate B**: conclusions land in `config.json`, and `OUTDIR/runtime_harvest.js` / `preload.js` are adjusted accordingly.

### Phase 2b — API Observation (Optional)

Use the OUTDIR copy of `preload.js` to confirm session key names, Authorization, and nested API URLs:

| Configuration | Output |
|---|---|
| `recordDetail: true` | `__API_RECON_DETAIL__` |
| `observe.xhrHeaders: true` | header observation |
| `extractUrlsFromResponse: true` | sub-APIs inside responses |
| `observe.storageReads/cookieReads: true` | backfill config |
| `neutralizeVueRouter: true` | `__API_RECON_ROUTES__` |

Each coverage round exports: `__API_RECON_LOG__`, `__API_RECON_DETAIL__`, `__API_RECON_ROUTES__`, `__API_RECON_OBSERVE__`.

---

## Phase 3 — Runtime

Gate B must have passed; follow [Boundaries and Prohibitions](#boundaries-and-prohibitions-agent-must-read--violations-mean-going-out-of-scope) · the credential-less mock strategy.

Set `"runtimeMode": "depth" | "coverage" | "both"` in `config.json` (template in the reference).

### Hooks and Stubs (shared by depth + coverage)

| Layer | Scope | Purpose |
|---|---|---|
| L1 exact | auth/permission/bootstrap stubs | pass the first-screen auth |
| L2 negative patching | all JSON responses | not-logged-in code → success |
| L3 fallback | any `/api` etc. not matched by L1 | empty success body to pry open the UI |

- **depth**: fake auth + `forward` to patch business codes + `stubs`; iterate `routes` (hash/history); produces `runtime_api.json`
- **coverage**: inject `preload.js` at **document-start** (CDP `addScriptToEvaluateOnNewDocument` or a Userscript)

Verify: `window.__API_RECON_PRELOAD__` exists; business paths do not bounce to `/login`.

```bash
cd recon && npm install
node runtime_harvest.js config.json
```

### 3b — Coverage Dynamic Enumeration (Mandatory)

1. Main nav/sidebar — click every item, wait 1–3s for network
2. Tabs — `role=tab`, `.ant-tabs-tab`
3. Tables — first-row view/edit/detail
4. Toolbar — export, filter, create (**avoid irreversible deletes**)
5. On entering each module — merge APIs/routes
6. SPA — controlled `pushState` for `routes.txt` paths not yet covered (forbidden for MPA)

**Parameter trigger matrix** (mandatory): for each module, record once per operation type, **diff multiple samples**:

| Operation | Parameters usually gained |
|---|---|
| List first screen | pagination + default filters |
| Click search | keyword, filter |
| Advanced filter | more optionals |
| Create/edit | full entity |
| Bulk/export/sort | `ids[]`, `exportType`, `sortField` |

**Under stubs the outbound body/headers are still real** — trust the request. Recording → `scan_raw.json`, `param_samples.json`, `api_detail.json`.

- **Vue**: `neutralizeVueRouter: true` + document-start preload
- **React**: `routes.txt` + sidebar clicks + `pushState`
- **both**: 3a depth first, then 3b coverage

---

## Phase 4 — Permission Tree Restoration

**Trigger**: module pages blank / only bootstrap (e.g. locale) per route → content gate not passed.

| Symptom | Meaning |
|---|---|
| Shell entry works | render gate + interceptor gate passed |
| Sidebar items missing / blank on click | stub shape or permission codes incomplete |
| Same very few APIs per route | `v-if permission` not satisfied |
| `routes.txt` far fewer than the bundle | must complete from the auth module |

```bash
grep -rhoaE '"/api[^"]*(permission|perm|role|menu|acl)[^"]*"' OUTDIR/js/*.js | sort -u | head -30
grep -rhoaE 'userRouteAuth|getResultTree|routeMap|routeLink|menuList|authList' OUTDIR/js/*.js | head -20
```

Typical chain: `role_permissions` (flat codes) + `permissions/all` (tree) → `getResultTree` → `userRouteAuth[CODE].url`.

```bash
python3 recon/extract_route_map.py recon/js recon/
python3 recon/build_perm_tree.py recon/js recon/ --config recon/config.json
```

Intermediate outputs: `route_map.json`, `userRouteAuth.json`, `permissions_tree.json`, `*_stub.json`, `perm_codes_all.txt`.

Stub checks: the outer `response_code` matches the interceptor gate; flat codes align with the tree; `routes` covers every link in `route_map`.

After updating `config.json`, **re-run Phase 3**. For large SPAs, tune `waitUntil`, `routeTimeout`, `perRouteMs` (see reference sections A3/I).

---

## Phase 5 — Merge and Report

### Output Table

| File | Phase | Content |
|---|---|---|
| `js/`, `api_static.txt`, `routes.txt`, `chunkmap.txt` | 1 | static bundle and paths |
| `param_candidates.json` | 1b | static parameter field candidates |
| `config.json` | 2 | three gates + runtime config |
| `runtime_api.json` | 3a | depth detailed recording (incl. WS/SSE) |
| `param_samples.json`, `scan_raw.json`, `api_detail.json` | 3b | multi-samples, click log, detail |
| `route_map.json` etc. | 4 | permission tree intermediates (if executed) |
| `params_merged.json` | 5 | merged parameter fields + confidence |
| `api_merged.txt` | 5 | `METHOD /path [params] [static\|runtime\|both]` |
| `site_map.json` | 5 | routes, APIs, params, feature points, limitations |
| **insert_assets** | 5 | write all service and endpoint assets into the asset repository |

### 5b — Parameter Merging

Diff from `param_samples.json`; **there is no universal merge script**. Confidence rules in reference J7 (high/medium/low/pending-trigger).

### 5c — Error-Based Inference

Within the authorized scope you may send incomplete requests and read the 400s (**this is parameter recon, not vulnerability testing**): `field 'x' is required`, enum errors, etc. Watch for `data` wrapping, `variables`, and pre-encryption `bizData`.

The report must state: runtimeMode, static/runtime API counts, parameter confidence, uncovered modules, and a `CHANGES.md` summary relative to the reference scripts.

Suggested `site_map.json` structure:

```json
{
  "site": "https://example.com",
  "runtimeMode": "both",
  "appType": "vue-spa",
  "routeGuardStrategy": ["nav-neutralize", "L1-auth", "L2-patch", "forward"],
  "apisFromStatic": [],
  "apisFromRuntime": [],
  "apis": [],
  "params": [{ "method": "POST", "path": "/api/user/list", "transport": "json", "fields": [] }],
  "frontendRoutes": [],
  "routesVerifiedByClick": [],
  "featuresTriggered": [],
  "limitations": ""
}
```

More fields and grep recipes in [reference.md](reference.md).

---

## General Notes

- **Framework-agnostic**: webpack/Vite/Angular lazy loading works the same way
- **Transports**: REST/JSON, GraphQL, WebSocket, SSE; gRPC-web is out of scope
- **SSR**: client-side fetches are recordable; RSC/Server Actions are not fully enumerable
- **Blind spots**: JSVMP, WASM, HMAC/mTLS strong verification → static + note the limitation
- **Parameter blind spots**: conditional linkage, hidden params, WASM-assembled payloads → "pending trigger" / "unreachable"
- **Static is the safety net**: when runtime is blocked, static can still enumerate endpoints

---

## Additional Resources

- Grep recipes, `config.json` templates, troubleshooting, hooks, parameter reverse engineering section J, site_map template: **[reference.md](reference.md)**
- Reference script paths in the [Scripts and Gates](#scripts-and-gates) table
