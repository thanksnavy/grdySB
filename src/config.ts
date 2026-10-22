/**
 * Router configuration: model registry, limits and shared defaults.
 *
 * The registry is intentionally a typed constant for now. The extension point
 * for making it dynamic (per-user models, imports) is `resolveModels`, which
 * can later read from KV/D1 without changing any caller.
 */
import type { ModelEntry } from "./types";

/**
 * Default system prompt for the built-in web UI.
 *
 * Only applied to `/api/chat`. The OpenAI-compatible surface at
 * `/v1/chat/completions` passes client system prompts through unchanged,
 * because external agents such as Cline supply their own and overriding them
 * would break tool calling.
 */
export const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

/** Default model used by the web UI when the client does not choose one. */
export const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

/** Maximum output tokens requested from the model. */
export const MAX_TOKENS = 1024;

/**
 * Inbound request limits.
 *
 * These exist because the endpoint is reachable by anyone who can reach the
 * Worker, and every accepted message is forwarded to a paid model. Without a
 * bound, a single scripted request can drive arbitrary spend.
 */
export const LIMITS = {
	/** Maximum number of messages accepted in one request. */
	maxMessages: 64,
	/** Maximum characters per message. */
	maxMessageChars: 32_000,
	/** Maximum accepted request body size in bytes. */
	maxBodyBytes: 512_000,
} as const;

/** Roles permitted in an inbound message. */
export const ALLOWED_ROLES = ["system", "user", "assistant"] as const;

/**
 * Models advertised by `/v1/models`.
 *
 * Gateway entries use AI Gateway's `{provider}/{model}` addressing, including
 * `openrouter/...` for the OpenRouter catalogue and `dynamic/{route}` for
 * configured dynamic routes. The `workers-ai` entry keeps the template
 * functional with no gateway configured.
 */
export const MODELS: ModelEntry[] = [
	{
		id: DEFAULT_MODEL,
		provider: "workers-ai",
		label: "Llama 3.1 8B Instruct (Workers AI)",
		streaming: true,
		tools: false,
	},
	{
		id: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		provider: "gateway",
		label: "Llama 3.3 70B Instruct (Workers AI via Gateway)",
		streaming: true,
		tools: true,
	},
	{
		id: "openai/gpt-5-mini",
		provider: "gateway",
		label: "GPT-5 mini (OpenAI)",
		streaming: true,
		tools: true,
	},
	{
		id: "anthropic/claude-sonnet-4-5",
		provider: "gateway",
		label: "Claude Sonnet 4.5 (Anthropic)",
		streaming: true,
		tools: true,
	},
	{
		id: "google-ai-studio/gemini-2.5-flash",
		provider: "gateway",
		label: "Gemini 2.5 Flash (Google AI Studio)",
		streaming: true,
		tools: true,
	},
	{
		id: "openrouter/deepseek/deepseek-chat",
		provider: "gateway",
		label: "DeepSeek Chat (via OpenRouter)",
		streaming: true,
		tools: true,
	},
];

/**
 * Resolves the models this router advertises.
 *
 * Gateway-routed models are only advertised when a gateway is actually
 * configured, so `/v1/models` never lists models that would fail.
 */
export function resolveModels(gatewayEnabled: boolean): ModelEntry[] {
	return MODELS.filter(
		(model) => gatewayEnabled || model.provider !== "gateway",
	);
}

/**
 * True when both pieces of gateway configuration are present.
 * Split out so the condition is defined in exactly one place.
 */
export function isGatewayEnabled(
	accountId: string | undefined,
	gatewayId: string | undefined,
): boolean {
	return Boolean(accountId && gatewayId);
}
