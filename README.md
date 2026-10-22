# Relay workspace

A first version of a self-hosted AI workspace: a static dashboard and a Cloudflare Worker exposing an OpenAI-compatible provider router. Supports OpenRouter directly or through Cloudflare AI Gateway, and a publicly reachable HTTPS Ollama OpenAI API. Provider keys are server-side; a separate router key protects API access.

## Local development

Requires Node 22+ (validated on Node 24).

```sh
npm ci
# Create .dev.vars locally (ignored); never commit real keys:
# ROUTER_API_KEY="your-long-random-router-key"
# OPENROUTER_API_KEY="your-provider-key"
npm run dev
npm test -- --run
npm run check
```

In this managed environment use `npm_config_cache=/workspace/.npm-cache`, `XDG_CONFIG_HOME=/workspace/.config`, and `WRANGLER_SEND_METRICS=false` if default cache/config locations are unwritable. No Workers AI binding is required. The playground asks for the router key for the current page session and does not persist it.

## Worker configuration

Set secrets with `npx wrangler secret put NAME` (enter values securely):

- `ROUTER_API_KEY`: required, long random shared access key. Without it the API fails closed.
- `OPENROUTER_API_KEY`: enables OpenRouter.
- `OLLAMA_API_KEY`: optional authorization for your Ollama HTTPS proxy.
- `CF_AIG_TOKEN`: optional Cloudflare AI Gateway authentication token.

Set non-secret Worker variables in Wrangler configuration or Cloudflare settings:

- `OLLAMA_BASE_URL`: e.g. `https://your-ollama-host.example/v1`. Requires a reachable HTTPS service, typically behind an authenticated reverse proxy or tunnel. A Cloudflare Worker cannot reach Ollama on your laptop's localhost. The URL is controlled by the operator, never by API callers.
- `CF_ACCOUNT_ID` and `CF_GATEWAY_ID`: set both to route OpenRouter through `gateway.ai.cloudflare.com/v1/<account>/<gateway>/openrouter/chat/completions`. Without both, OpenRouter is called directly. Ollama uses its configured endpoint directly.

`npm run deploy` publishes the Worker and static assets together. Deployment is a separate user action. Configure secrets before opening access. Anyone holding the router key can use the configured providers and incur charges; this first version has no per-user quotas or account management. Provider access and Gateway behavior require live validation against your own accounts.

## Pages frontend (optional)

The default deployment serves everything from one Worker origin. To host the dashboard on Pages, deploy `public/` as static output (no build command), then route `/api/*` and `/v1/*` on the same custom hostname to the router Worker using Cloudflare Worker routes. The UI uses same-origin API requests. Do not enable a Pages-only deployment without these API routes. Separate origins and CORS are not configured.

## Cline and other OpenAI-compatible clients

Choose OpenAI-compatible, base URL `https://your-workspace.example/v1`, API key equal to `ROUTER_API_KEY`, and a model route:

- `openrouter/openai/gpt-4o-mini` (or another OpenRouter model ID)
- `ollama/llama3.2` (use a model installed on your Ollama server)

`POST /v1/chat/completions` forwards JSON options including streaming, tools, and tool results. It strips only the first provider prefix. `GET /v1/models` returns configured example routes, not a live inventory. `/api/chat` aliases the completions endpoint. `GET /api/connections` reports configuration presence, not verified connectivity. All require Bearer authentication. `/api/health` is public.

## Importable library

Import a JSON array (replaces current library), up to 200 entries / 256 KB:

```json
[
  {"type":"repo","name":"My workspace","url":"https://github.com/thanksnavy/grdySB"},
  {"type":"mcp","name":"My remote MCP","url":"https://tools.example.com/mcp"},
  {"type":"skill","name":"My skill","url":"https://github.com/example/skills/blob/main/SKILL.md"}
]
```

Definitions are validated and stored in browser localStorage. Export creates a portable JSON file. Do not import credentials in URLs. Imports do not execute commands, clone repositories, or grant tools access to your machine.

## Next layers

This is a routing foundation, not a complete browser OS. MCP execution, Cline agent hosting, repo cloning, skill execution, shared persistent storage, user accounts, and automation are not implemented. These need an authenticated execution service (for shell/stdio tools), persistence, permissions, and explicit tool approval controls. Cline currently connects as an external client through the router.

## Deploy from a phone using GitHub Actions

Merge the workspace branch into `main` first. In this repository's GitHub Settings → Secrets and variables → Actions, add `CLOUDFLARE_API_TOKEN` with a Cloudflare API token authorized to edit Workers on account `7d223fa797bb6f756723782041caf250` (the Cloudflare Edit Cloudflare Workers token template can be scoped to this account). Never enter the token in chat or commit it. The deploy token is separate from the app's router and provider keys.

Then open GitHub Actions → Deploy workspace to Cloudflare → Run workflow on `main`. This manually triggered workflow installs locked dependencies, tests, checks, and deploys to the existing `llm-chat-app-template` Worker. Its existing Worker secrets are retained; `ROUTER_API_KEY` and `OPENROUTER_API_KEY` must already be saved there. No deployment runs just from pushing this branch. If the mobile GitHub UI hides Actions controls, enable your browser's desktop-site view.
