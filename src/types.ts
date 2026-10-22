/**
 * Type definitions for the LLM routing application.
 */

export interface Env {
	/**
	 * Binding for the Workers AI API.
	 *
	 * Used as the fallback execution path when no AI Gateway is configured,
	 * which keeps the template working out of the box.
	 */
	AI: Ai;

	/**
	 * Binding for static assets.
	 */
	ASSETS: { fetch: (request: Request) => Promise<Response> };

	/**
	 * Cloudflare account ID that owns the AI Gateway.
	 * Set together with AI_GATEWAY_ID to enable gateway routing.
	 */
	CLOUDFLARE_ACCOUNT_ID?: string;

	/**
	 * AI Gateway slug/ID to route through.
	 * When set (with CLOUDFLARE_ACCOUNT_ID), requests are proxied to the
	 * gateway's OpenAI-compatible endpoint instead of calling Workers AI
	 * directly, which enables multi-provider routing, caching, rate limiting,
	 * spend limits and unified billing.
	 */
	AI_GATEWAY_ID?: string;

	/**
	 * Token for an authenticated AI Gateway.
	 * Sent as the `cf-aig-authorization` header. Secret — set with
	 * `wrangler secret put CF_AIG_TOKEN`.
	 */
	CF_AIG_TOKEN?: string;

	/**
	 * API key clients must present to use this router.
	 *
	 * This is the value you paste into Cline / Cursor / Claude Code as their
	 * "API Key". Secret — set with `wrangler secret put ROUTER_API_KEY`.
	 * When unset the router is open, which is only acceptable behind
	 * Cloudflare Access or during local development.
	 */
	ROUTER_API_KEY?: string;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/**
 * A model exposed by the router's `/v1/models` registry.
 */
export interface ModelEntry {
	/**
	 * Identifier clients request, e.g. `openrouter/anthropic/claude-sonnet-4`.
	 * For gateway routing this is the `{provider}/{model}` string forwarded to
	 * AI Gateway; for the Workers AI fallback it is a Workers AI model ID.
	 */
	id: string;

	/**
	 * Which execution path serves this model.
	 */
	provider: "gateway" | "workers-ai";

	/** Human-readable label for the UI. */
	label?: string;

	/** Whether the model supports streaming. */
	streaming?: boolean;

	/** Whether the model supports tool/function calling. */
	tools?: boolean;
}

/**
 * Result of validating an inbound chat request.
 * Uses an explicit `ok` discriminant so callers narrow reliably.
 */
export type ValidationResult =
	| { ok: true; messages: ChatMessage[] }
	| { ok: false; error: string };

/**
 * Result of reading and parsing a request body.
 */
export type BodyResult =
	| { ok: true; body: unknown }
	| { ok: false; error: string; status: number };


