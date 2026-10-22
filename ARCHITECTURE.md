# Architecture — Self-hosted AI routing "OS" on Cloudflare

Status: proposal, pre-implementation. Researched against Cloudflare docs on
2026-10-22.

## The single most important finding

**Cloudflare AI Gateway already is the routing system you described.** Before
writing a router, look at what it provides natively today:

| Capability you want | AI Gateway feature | Status |
| --- | --- | --- |
| Multi-provider routing | Provider Native + Unified API | GA |
| Routing rules / fallback chains | **Dynamic routing** (`dynamic/{route}`) | Beta |
| Automatic provider selection | Auto Router | Beta |
| Caching | Caching | GA |
| Rate limiting | Rate limiting | GA |
| Budget caps | Spend limits | Beta |
| Content filtering | Guardrails, DLP | Beta |
| Key vault | BYOK (Store Keys) | Beta |
| One bill across providers | Unified Billing (Workers AI + AI Gateway) | GA (Aug 2026) |
| Request logs / cost analytics | Logging, Analytics, User Insights, OTel | GA |
| Self-hosted / internal models | **Custom Providers** | Beta |
| Retries, failover | Retry/fallback config | GA |

Reimplementing this in a Worker would mean rebuilding caching, billing,
guardrails and observability that Cloudflare gives you for free — and doing it
worse, without their provider integrations.

**Therefore: do not build a router. Build the control plane and the UX that AI
Gateway does not give you.**

## Proposed split

```
+--------------------------------------------------------------+
|  Data plane — Cloudflare AI Gateway (managed, do not rebuild) |
|  routing, fallback, cache, rate limit, spend caps, guardrails,|
|  BYOK key vault, unified billing, logs, retries               |
+--------------------------------------------------------------+
              ^                              ^
              | AI binding / REST            |
+--------------------------------------------------------------+
|  Control plane — YOUR Worker(s) (this repo)                   |
|  - OpenAI-compatible surface for clients (Cline, Cursor, ...) |
|  - provider + model registry (what's enabled, which routes)   |
|  - MCP registry + remote MCP proxy/host                       |
|  - skills / repos import + storage                            |
|  - sessions + conversation state (Durable Objects)            |
|  - agent orchestration                                        |
+--------------------------------------------------------------+
              |
+--------------------------------------------------------------+
|  UI — static assets in this repo (the "OS" shell)             |
+--------------------------------------------------------------+
```

Build only the middle box. Everything in the top box is configuration, not
code.

## Provider integration matrix (verified)

| Target | Works? | Mechanism | Constraint |
| --- | --- | --- | --- |
| **OpenRouter** | ✅ Yes | Native AI Gateway provider | None. Best single integration — hundreds of models through one key. |
| **Workers AI** | ✅ Yes | `AI` binding + gateway option; unified billing | None. |
| **Anthropic / OpenAI / Google / Groq / xAI / DeepSeek / Mistral / Cohere / Perplexity / Cerebras / Baseten / Bedrock / Vertex / Azure** | ✅ Yes | Native providers | None. |
| **Ollama (local)** | ⚠️ With work | Custom Provider, **or** browser-direct | See below — the hard one. |
| **Cline** | ✅ Yes | Cline "OpenAI Compatible" provider → your Worker's base URL | Cline is a *client*, not a provider. Your Worker becomes its backend. |
| **Any HTTPS OpenAI-compatible endpoint** | ✅ Yes | Custom Provider (Beta) | `base_url` **must be HTTPS**; HTTP is rejected with error 1002. |

### Ollama is the genuinely hard case

Two independent platform constraints collide:

1. AI Gateway Custom Providers **require HTTPS** — `http://localhost:11434` is
   rejected outright (`base_url must be a valid HTTPS URL starting with
   https://`).
2. A Worker runs in Cloudflare's network and **cannot reach your localhost**.

Viable options, best first:

| Option | How | Gets gateway billing/caching/logs? |
| --- | --- | --- |
| **A. Cloudflare Tunnel** | `cloudflared` named tunnel → HTTPS URL → register as Custom Provider | ✅ Yes, fully |
| **B. Browser-direct** | UI calls `http://localhost:11434` from the browser; set `OLLAMA_ORIGINS` to allow your Worker's origin | ❌ No — bypasses the gateway entirely |
| **C. Local TLS relay** | Small local process terminating TLS, exposed via tunnel | ✅ Yes, but you maintain the relay |

Recommendation: **A as the supported path, B as an offline/dev fallback.**
Design the provider abstraction so a provider can be marked `local` and routed
client-side, but be explicit in the UI that local providers are invisible to
billing and guardrails.

### Cline integration is the easy win

Cline supports an "OpenAI Compatible" provider configured with just **Base URL
+ API Key + Model ID**. So the moment your Worker exposes an OpenAI-compatible
`/v1/chat/completions`, Cline (and Cursor, Claude Code, Copilot CLI, Codex,
VS Code, Gemini CLI — all documented AI Gateway integrations) can use your
whole provider fleet through one endpoint. This should be milestone one: it is
the highest-leverage, lowest-effort piece and it makes the system immediately
useful outside its own UI.

## MCP reality check — read this before planning "import any MCP"

The MCP spec defines two transports:

| Transport | Runs on Workers? | Notes |
| --- | --- | --- |
| **Streamable HTTP** | ✅ Yes | Standard for remote MCP since March 2025. Host with `createMcpHandler()` (stateless) or `McpAgent` (stateful). |
| **stdio** | ❌ **No** | By definition local — spawns a child process, talks over stdin/stdout. Workers have no child processes and no filesystem. |
| SSE | ⚠️ Deprecated | Superseded by Streamable HTTP. |
| RPC | ✅ Internal only | Cloudflare-internal agent-to-agent; Durable Object bindings only, no auth. |

**Consequence:** the large majority of community MCP servers ship as stdio
packages (`npx some-mcp-server`). They **cannot** be hosted on Workers.
"Import any MCP" is therefore not achievable as stated. What *is* achievable:

1. **Host** remote/Streamable-HTTP MCP servers natively in your Worker.
2. **Registry + proxy** remote MCP servers that already expose HTTP — your
   Worker becomes a directory plus an auth/aggregation layer over them.
3. **Bridge** stdio servers via a *client-side* adapter (`mcp-remote`) on the
   user's machine — but then the tool executes locally, not in your "OS", and
   your Worker only sees it through the client.
4. **Code Mode / OpenAPI-backed tools** — Cloudflare's pattern for turning an
   OpenAPI spec into tools, which sidesteps MCP entirely for many cases.

Plan the MCP layer around (1) + (2), with (3) as a documented local escape
hatch. Do not promise a generic stdio importer.

## Prerequisites from the code review

This repo currently has an open build failure and several security defects
(see `CODE_REVIEW.md`). They were tolerable for a demo template. They are
**not** tolerable for a system that stores provider API keys and routes paid
traffic. Blocking, in order:

1. **PR #1** — `npm install`/`npm ci` currently fails (ERESOLVE). Nothing else
   can be built until this merges.
2. **H1** — clients can replace the system prompt. Once real keys sit behind
   this, that is an abuse vector against your billing.
3. **H2** — no input validation, unbounded payload forwarded to the model.
   Translates directly to unbounded spend.
4. **H3** — client errors return 500, which will make the gateway's own error
   analytics useless.
5. **H4** — `innerHTML` XSS sink. A router UI renders model output from many
   providers; this becomes materially more dangerous.
6. **B2/B3** — CI is red and the Node matrix is invalid. You want a green
   signal before iterating on something this large.

## Suggested roadmap

**Phase 0 — foundation (small, do first).** Merge PR #1, fix H1-H4 and B2/B3,
add a real `vitest.config.mts` with the workers pool. Outcome: green CI, safe
request handling, a test harness to build on.

**Phase 1 — OpenAI-compatible router surface.** Expose
`POST /v1/chat/completions` (plus `/v1/models`) from the Worker, forwarding to
AI Gateway. Add gateway auth and BYOK. Add a provider/model registry in KV or
D1. Outcome: **Cline, Cursor and Claude Code can all point at your Worker** and
reach every provider. This is the moment it becomes a routing system.

**Phase 2 — dynamic routes + policy.** Configure AI Gateway dynamic routes with
fallback chains; surface them in the UI; add spend limits, rate limiting,
guardrails. Outcome: real routing policy, not just passthrough.

**Phase 3 — the OS shell.** Replace the single chat page with a workspace:
model picker, provider config, session list, log/cost view. Sessions in
Durable Objects. Outcome: the "all-in-one" UX.

**Phase 4 — MCP + skills + repos.** Remote MCP registry and proxy; skills
import; repo import. Outcome: extensibility layer. Largest and least certain
phase — scope it after 1-3 prove the core.

## Open questions

- Which Cloudflare account/gateway ID will this use, and is AI Gateway enabled?
- Single-user (just you) or multi-tenant? This changes the auth model
  fundamentally — single-user can use Cloudflare Access; multi-tenant needs
  real identity, per-user key isolation and per-user spend caps.
- Is Ollama support a day-one requirement or nice-to-have? It is the most
  expensive integration to do properly.
- Pages or Workers? This repo is already a Worker with static assets, which is
  the modern path (Pages is being folded into Workers). Recommend staying on
  Workers unless there is a specific reason not to.
