# Self-hosted AI Router on Cloudflare

An OpenAI-compatible routing layer you host yourself on Cloudflare Workers.
Point your tools — **Cline, Cursor, Claude Code, Codex, or the bundled web UI**
— at one URL and reach every provider behind it: OpenRouter, Anthropic,
OpenAI, Google, Workers AI, and any HTTPS OpenAI-compatible endpoint.

Requests are forwarded to **Cloudflare AI Gateway**, which supplies the parts
you do not want to build: multi-provider routing with fallback chains,
caching, rate limiting, spend caps, guardrails, a key vault, unified billing
and request analytics. When no gateway is configured the Worker falls back to
the Workers AI binding, so it runs out of the box.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design rationale and the
platform constraints that shaped it.

## Why this delegates to AI Gateway

AI Gateway already provides routing, dynamic routes, caching, rate limiting,
spend limits, guardrails, DLP, BYOK key storage, unified billing and
observability. Reimplementing that in a Worker would duplicate all of it and
do it worse. This project is therefore the **control plane and UX** — the
OpenAI-compatible surface, the model registry, auth, validation and the chat
UI — not a second router.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/models` | OpenAI-shaped model registry |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat (streaming + JSON). For Cline, Cursor, Claude Code, etc. |
| `POST` | `/api/chat` | Same core, used by the bundled web UI |
| `*` | anything else | Static frontend |

The two chat surfaces differ in one deliberate way:

- `/api/chat` **drops client system messages** and always applies the server's
  `SYSTEM_PROMPT`, so a caller cannot redefine the assistant.
- `/v1/chat/completions` **honours client system messages**, because external
  agents such as Cline supply their own and depend on them surviving for tool
  calling to work.

## Getting started

### Prerequisites

- Node.js 22 or newer
- A Cloudflare account with Workers AI access
- An [AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway) (optional, but this is what makes it a router)

### Install

```bash
npm ci          # not `npm install` — see the note below
npm run cf-typegen
```

> **Use `npm ci`.** A bare `npm install` re-resolves the dependency tree and
> can fail on the `@cloudflare/workers-types` peer range; `npm ci` installs
> exactly what the lockfile specifies.

### Run locally

```bash
cp .dev.vars.example .dev.vars   # then edit
npm run dev                      # http://localhost:8787
```

Local development still calls your Cloudflare account for Workers AI, which
incurs usage charges.

### Deploy

```bash
npm run deploy
```

## Configuring routing

### 1. Without a gateway (works immediately)

Leave the gateway variables unset. The Worker uses the `AI` binding and serves
Workers AI models. Responses are transcoded into OpenAI shape, so external
clients behave identically.

### 2. With AI Gateway (multi-provider)

Set both variables — in `wrangler.jsonc` under `vars`, or in `.dev.vars`
locally:

```jsonc
"vars": {
	"CLOUDFLARE_ACCOUNT_ID": "<your-account-id>",
	"AI_GATEWAY_ID": "<your-gateway-id>"
}
```

Then set the secrets:

```bash
npx wrangler secret put CF_AIG_TOKEN     # if your gateway has auth enabled
npx wrangler secret put ROUTER_API_KEY   # the key your clients present
```

Store your **provider** API keys in the gateway using
[BYOK](https://developers.cloudflare.com/ai-gateway/configuration/byok/) —
not in this Worker. The router deliberately never forwards a caller's
`Authorization` header upstream, so your `ROUTER_API_KEY` cannot leak to a
provider and provider keys never transit this code.

Models are addressed as `{provider}/{model}`:

```
openrouter/deepseek/deepseek-chat
anthropic/claude-sonnet-4-5
openai/gpt-5-mini
google-ai-studio/gemini-2.5-flash
workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
dynamic/<your-dynamic-route-name>
```

Edit `MODELS` in `src/config.ts` to change what `/v1/models` advertises. The
registry is advisory: an unlisted model string is still forwarded, so newly
added gateway models work without a redeploy.

## Connecting your tools

### Cline

Settings → API Provider: **OpenAI Compatible**

| Field | Value |
| --- | --- |
| Base URL | `https://<your-worker>.workers.dev/v1` |
| API Key | your `ROUTER_API_KEY` |
| Model ID | e.g. `openrouter/anthropic/claude-sonnet-4` |

Cursor, Claude Code, Codex and the OpenAI SDKs work the same way — any client
that accepts a custom OpenAI-compatible base URL.

```js
import OpenAI from "openai";

const client = new OpenAI({
	baseURL: "https://<your-worker>.workers.dev/v1",
	apiKey: process.env.ROUTER_API_KEY,
});

const stream = await client.chat.completions.create({
	model: "openrouter/deepseek/deepseek-chat",
	messages: [{ role: "user", content: "Hello" }],
	stream: true,
});
```

## Security

Read this before exposing the Worker publicly.

- **Set `ROUTER_API_KEY`.** If it is unset the router is **open** — anyone who
  can reach it can spend your AI credits. Comparison is constant-time.
- Put the Worker behind **Cloudflare Access** for a personal deployment.
- Provider keys belong in the gateway's **BYOK** store, never in `vars` or in
  this repository.
- Inbound requests are **validated and bounded** before any model call:
  message count, per-message length and body size are capped, roles are
  checked, and `max_tokens` is clamped. Malformed input returns `400`/`413`,
  never `500`.
- Add **spend limits** and **rate limiting** on the gateway itself.
- Model output is rendered with `textContent`, never `innerHTML`.

## Development

```bash
npm run check        # tsc --noEmit && wrangler deploy --dry-run
npm test             # vitest run  (60 tests)
npm run test:watch   # vitest in watch mode
npm run e2e:dev      # dev server using wrangler.e2e.jsonc
```

Tests run in the Node environment with the Workers bindings mocked; see the
comment in `vitest.config.mts` for how to switch to the `workerd` pool.

## Project structure

```
├── public/
│   ├── index.html         # Chat UI
│   └── chat.js            # Frontend: streaming, model picker, abort
├── src/
│   ├── index.ts           # HTTP router + auth + error shaping
│   ├── gateway.ts         # Routing core: gateway proxy + Workers AI fallback
│   ├── config.ts          # Model registry, limits, defaults
│   ├── validate.ts        # Inbound validation (never throws)
│   └── types.ts           # Env and shared types
├── test/                  # 60 tests across 5 files
├── patches/               # Changes needing elevated permissions
├── ARCHITECTURE.md        # Design and platform constraints
├── CODE_REVIEW.md         # Original review of the template
├── wrangler.jsonc         # Worker configuration
└── .dev.vars.example      # Documented environment variables
```

## Known limitations

- **Ollama and other local models** need HTTPS. AI Gateway Custom Providers
  reject a non-HTTPS `base_url` (error 1002), and a Worker cannot reach your
  `localhost`. Expose Ollama through a Cloudflare Tunnel and register it as a
  Custom Provider, or call it directly from the browser — which bypasses
  gateway billing and guardrails. Details in `ARCHITECTURE.md`.
- **stdio MCP servers cannot be hosted here.** Workers have no child processes
  or filesystem. Remote Streamable HTTP MCP servers can be hosted or proxied;
  stdio servers need a client-side bridge such as `mcp-remote`.
- The CI workflow change in `patches/ci-node-matrix.patch` must be applied
  manually, because the automation token lacks GitHub `workflows` permission.
  See `patches/README.md`.

## Resources

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [AI Gateway providers](https://developers.cloudflare.com/ai-gateway/usage/providers/)
- [Custom Providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
- [Dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)
- [Workers AI models](https://developers.cloudflare.com/workers-ai/models/)

