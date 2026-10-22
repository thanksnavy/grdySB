/**
 * LLM Routing Application
 *
 * A self-hosted routing surface on Cloudflare Workers. Requests are forwarded
 * to Cloudflare AI Gateway when one is configured (giving multi-provider
 * routing, caching, rate limiting, spend limits and unified billing), and fall
 * back to the Workers AI binding otherwise.
 *
 * Surfaces:
 *   GET  /v1/models            OpenAI-compatible model registry
 *   POST /v1/chat/completions  OpenAI-compatible chat, for Cline/Cursor/etc.
 *   POST /api/chat             same core, used by the bundled web UI
 *
 * @license MIT
 */
import type { ChatMessage, Env } from "./types";
import {
	DEFAULT_MODEL,
	SYSTEM_PROMPT,
	isGatewayEnabled,
	resolveModels,
} from "./config";
import { readJsonBody, validateMessages } from "./validate";
import { runCompletion } from "./gateway";

export default {
	/**
	 * Main request handler for the Worker
	 */
	async fetch(request: Request, env: Env): Promise<Response> {
		const path = new URL(request.url).pathname;

		if (path.startsWith("/v1/") || path.startsWith("/api/")) {
			return handleApi(request, env, path);
		}

		// Everything else is the static frontend.
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

/**
 * Routes API requests and keeps error responses consistently JSON.
 */
async function handleApi(
	request: Request,
	env: Env,
	path: string,
): Promise<Response> {
	if (path === "/v1/models") {
		if (request.method !== "GET") {
			return methodNotAllowed("GET");
		}
		return handleModels(env);
	}

	if (path === "/v1/chat/completions") {
		if (request.method !== "POST") {
			return methodNotAllowed("POST");
		}
		const denied = authorize(request, env);
		if (denied) return denied;
		// OpenAI-compatible surface: client system prompts pass through, since
		// external agents such as Cline supply their own and overriding them
		// would break tool calling.
		return handleCompletion(request, env, { enforceSystemPrompt: false });
	}

	if (path === "/api/chat") {
		if (request.method !== "POST") {
			return methodNotAllowed("POST");
		}
		const denied = authorize(request, env);
		if (denied) return denied;
		// Bundled UI: the server owns the system prompt, so a caller cannot
		// redefine the assistant's behaviour.
		return handleCompletion(request, env, { enforceSystemPrompt: true });
	}

	return jsonError(404, "not_found", `No route for ${path}`);
}


/**
 * Verifies the caller's API key when one is configured.
 *
 * Returns null when authorized, otherwise the 401 response to return. When
 * ROUTER_API_KEY is unset the router is open, which is only acceptable behind
 * Cloudflare Access or during local development.
 */
function authorize(request: Request, env: Env): Response | null {
	const expected = env.ROUTER_API_KEY;
	if (!expected) return null;

	const header = request.headers.get("authorization") ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	const presented = match ? match[1].trim() : "";

	if (!presented) {
		return jsonError(
			401,
			"missing_api_key",
			"Missing API key. Send an 'Authorization: Bearer <key>' header.",
			{ "www-authenticate": "Bearer" },
		);
	}

	// Length is compared first so the byte loop only runs on equal-length
	// inputs, keeping it constant-time.
	if (
		presented.length !== expected.length ||
		!constantTimeEquals(presented, expected)
	) {
		return jsonError(401, "invalid_api_key", "Invalid API key.", {
			"www-authenticate": 'Bearer error="invalid_token"',
		});
	}

	return null;
}

function constantTimeEquals(a: string, b: string): boolean {
	let difference = 0;
	for (let i = 0; i < a.length; i += 1) {
		difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return difference === 0;
}

/**
 * Advertises the models this router serves.
 */
function handleModels(env: Env): Response {
	const gatewayEnabled = isGatewayEnabled(
		env.CLOUDFLARE_ACCOUNT_ID,
		env.AI_GATEWAY_ID,
	);
	const models = resolveModels(gatewayEnabled);

	return Response.json({
		object: "list",
		// Shaped like OpenAI's /v1/models so clients can consume it directly,
		// with router-specific detail carried alongside.
		data: models.map((model) => ({
			id: model.id,
			object: "model",
			created: 0,
			owned_by: model.provider,
			label: model.label ?? model.id,
			streaming: model.streaming ?? true,
			tools: model.tools ?? false,
		})),
		gateway: {
			enabled: gatewayEnabled,
			id: gatewayEnabled ? env.AI_GATEWAY_ID : null,
		},
	});
}

interface CompletionOptions {
	/**
	 * When true the server's SYSTEM_PROMPT is prepended and any client-supplied
	 * system message is dropped. When false client system messages are honoured.
	 */
	enforceSystemPrompt: boolean;
}

/**
 * Shared completion handler for both API surfaces.
 *
 * Validation happens before any model call, so malformed input produces a 4xx
 * rather than being converted into a 500 or forwarded to a paid model.
 */
async function handleCompletion(
	request: Request,
	env: Env,
	options: CompletionOptions,
): Promise<Response> {
	const parsed = await readJsonBody(request);
	if (!parsed.ok) {
		return jsonError(parsed.status, "invalid_request", parsed.error);
	}

	const validated = validateMessages(parsed.body);
	if (!validated.ok) {
		return jsonError(400, "invalid_request", validated.error);
	}

	const messages = applySystemPromptPolicy(
		validated.messages,
		options.enforceSystemPrompt,
	);

	try {
		return await runCompletion(
			{
				model: extractModel(parsed.body, env),
				messages,
				// Streaming is the default because both surfaces are built
				// around SSE; clients opt out explicitly with stream:false.
				stream: extractBoolean(parsed.body, "stream", true),
				maxTokens: extractMaxTokens(parsed.body),
				temperature: extractNumber(parsed.body, "temperature"),
				tools: extractField(parsed.body, "tools"),
				toolChoice: extractField(parsed.body, "tool_choice"),
				// Propagated so upstream generation stops when the client
				// disconnects instead of continuing to bill.
				signal: request.signal,
			},
			env,
		);
	} catch (error) {
		console.error("Error processing chat request:", error);
		return jsonError(500, "internal_error", "Failed to process request");
	}
}

/**
 * Applies the system prompt policy for the surface being served.
 */
function applySystemPromptPolicy(
	messages: ChatMessage[],
	enforceSystemPrompt: boolean,
): ChatMessage[] {
	if (!enforceSystemPrompt) return messages;

	const withoutClientSystem = messages.filter((m) => m.role !== "system");
	return [{ role: "system", content: SYSTEM_PROMPT }, ...withoutClientSystem];
}

function asRecord(body: unknown): Record<string, unknown> | null {
	if (typeof body === "object" && body !== null && !Array.isArray(body)) {
		return body as Record<string, unknown>;
	}
	return null;
}

function extractField(body: unknown, field: string): unknown {
	return asRecord(body)?.[field];
}

/**
 * Resolves the requested model, defaulting per execution path.
 *
 * An unknown string is still accepted and forwarded: the registry is advisory,
 * and rejecting here would block newly added gateway models until this file is
 * redeployed. The upstream provider returns an accurate error instead.
 */
function extractModel(body: unknown, env: Env): string {
	const requested = extractField(body, "model");
	if (typeof requested === "string" && requested.trim() !== "") {
		return requested.trim();
	}

	if (isGatewayEnabled(env.CLOUDFLARE_ACCOUNT_ID, env.AI_GATEWAY_ID)) {
		const firstGatewayModel = resolveModels(true).find(
			(model) => model.provider === "gateway",
		);
		if (firstGatewayModel) return firstGatewayModel.id;
	}
	return DEFAULT_MODEL;
}

function extractBoolean(body: unknown, field: string, fallback: boolean): boolean {
	const value = extractField(body, field);
	return typeof value === "boolean" ? value : fallback;
}

function extractNumber(body: unknown, field: string): number | undefined {
	const value = extractField(body, field);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractMaxTokens(body: unknown): number | undefined {
	const value = extractNumber(body, "max_tokens");
	if (value === undefined) return undefined;
	// Clamped rather than rejected: an absurd value is a spend risk, not a
	// malformed request.
	return Math.min(Math.max(Math.trunc(value), 1), 8192);
}

function methodNotAllowed(allow: string): Response {
	return jsonError(405, "method_not_allowed", `Use ${allow} for this route.`, {
		allow,
	});
}

/**
 * Uniform JSON error shape, so API clients never receive a bare text body.
 */
function jsonError(
	status: number,
	type: string,
	message: string,
	headers?: Record<string, string>,
): Response {
	return Response.json({ error: { message, type } }, { status, headers });
}

