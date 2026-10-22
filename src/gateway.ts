/**
 * Routing core.
 *
 * Two execution paths behind one interface:
 *
 * 1. **AI Gateway** — when `CLOUDFLARE_ACCOUNT_ID` and `AI_GATEWAY_ID` are set,
 *    requests are proxied to the gateway's OpenAI-compatible endpoint. This is
 *    the path that gives multi-provider routing (`{provider}/{model}`,
 *    including `openrouter/...` and `dynamic/{route}`), caching, rate
 *    limiting, spend limits, guardrails and unified billing.
 *
 * 2. **Workers AI fallback** — otherwise the `AI` binding is used directly, so
 *    the template still works with zero gateway configuration. Responses are
 *    transcoded into OpenAI shape so external clients (Cline, Cursor) behave
 *    identically on either path.
 */
import type { ChatMessage, Env } from "./types";
import { MAX_TOKENS } from "./config";

export interface CompletionRequest {
	model: string;
	messages: ChatMessage[];
	stream: boolean;
	maxTokens?: number;
	/** Passed through untouched for gateway routing. */
	tools?: unknown;
	toolChoice?: unknown;
	temperature?: number;
	signal?: AbortSignal;
}

/**
 * AI Gateway's OpenAI-compatible endpoint.
 */
function gatewayUrl(accountId: string, gatewayId: string): string {
	return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`;
}

/**
 * Builds the OpenAI-shaped request body. Undefined fields are omitted rather
 * than sent as null, since some upstream providers reject explicit nulls.
 */
function buildPayload(request: CompletionRequest): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		model: request.model,
		messages: request.messages,
		stream: request.stream,
		max_tokens: request.maxTokens ?? MAX_TOKENS,
	};

	if (request.temperature !== undefined) payload.temperature = request.temperature;
	if (request.tools !== undefined) payload.tools = request.tools;
	if (request.toolChoice !== undefined) payload.tool_choice = request.toolChoice;

	return payload;
}

/**
 * Executes a completion and returns a response ready to send to the client.
 *
 * Never throws for expected upstream failures: a non-2xx from the gateway is
 * mapped to a 502 with the upstream status preserved in the body, so callers
 * can distinguish "client sent rubbish" from "provider failed".
 */
export async function runCompletion(
	request: CompletionRequest,
	env: Env,
): Promise<Response> {
	if (env.CLOUDFLARE_ACCOUNT_ID && env.AI_GATEWAY_ID) {
		return runViaGateway(request, env);
	}
	return runViaWorkersAi(request, env);
}

/**
 * Proxy to AI Gateway.
 *
 * Note the authorization handling: the caller's `Authorization` header carries
 * *this router's* API key, which must never be forwarded upstream as a
 * provider credential. Provider keys are expected to be stored in the gateway
 * via BYOK, so only `cf-aig-authorization` is sent.
 */
async function runViaGateway(
	request: CompletionRequest,
	env: Env,
): Promise<Response> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID as string;
	const gatewayId = env.AI_GATEWAY_ID as string;

	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: request.stream ? "text/event-stream" : "application/json",
	};

	if (env.CF_AIG_TOKEN) {
		headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
	}

	let upstream: Response;
	try {
		upstream = await fetch(gatewayUrl(accountId, gatewayId), {
			method: "POST",
			headers,
			body: JSON.stringify(buildPayload(request)),
			signal: request.signal,
		});
	} catch (error) {
		if (isAbort(error)) {
			return clientClosedResponse();
		}
		console.error("AI Gateway request failed:", error);
		return upstreamFailure(502, "ai_gateway_unreachable", "Could not reach AI Gateway.");
	}

	if (!upstream.ok) {
		const detail = await safeText(upstream);
		console.error(`AI Gateway returned ${upstream.status}:`, detail);
		return upstreamFailure(
			502,
			"ai_gateway_error",
			`AI Gateway returned ${upstream.status}.`,
			detail,
			upstream.status,
		);
	}

	// Preserve the gateway's own routing metadata, which is how callers learn
	// which provider/model actually served a dynamic route.
	const responseHeaders = new Headers({ "cache-control": "no-cache" });
	for (const name of ["cf-aig-model", "cf-aig-provider", "content-type"]) {
		const value = upstream.headers.get(name);
		if (value) responseHeaders.set(name, value);
	}
	if (!responseHeaders.has("content-type")) {
		responseHeaders.set(
			"content-type",
			request.stream ? "text/event-stream; charset=utf-8" : "application/json",
		);
	}

	return new Response(upstream.body, { headers: responseHeaders });
}

/**
 * Direct Workers AI execution, used when no gateway is configured.
 */
async function runViaWorkersAi(
	request: CompletionRequest,
	env: Env,
): Promise<Response> {
	const inputs = {
		messages: request.messages,
		max_tokens: request.maxTokens ?? MAX_TOKENS,
		stream: request.stream,
		...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
	};

	let result: unknown;
	try {
		result = await env.AI.run(request.model, inputs, {
			signal: request.signal,
		});
	} catch (error) {
		if (isAbort(error)) {
			return clientClosedResponse();
		}
		console.error("Workers AI request failed:", error);
		return upstreamFailure(502, "workers_ai_error", "Model execution failed.");
	}

	if (request.stream) {
		const stream = result as ReadableStream<Uint8Array>;
		return new Response(transcodeWorkersAiStream(stream, request.model), {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
			},
		});
	}

	const text = extractWorkersAiText(result);
	return Response.json(toOpenAiCompletion(text, request.model));
}

/**
 * Normalises a non-streaming Workers AI result into an OpenAI
 * `chat.completion` object.
 */
export function toOpenAiCompletion(
	content: string,
	model: string,
): Record<string, unknown> {
	return {
		id: `chatcmpl-${crypto.randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
	};
}

/**
 * Converts Workers AI's `data: {"response":"..."}` SSE chunks into OpenAI
 * `choices[0].delta.content` chunks, terminating with `data: [DONE]`.
 *
 * Without this, external OpenAI-compatible clients would receive a stream
 * shape they cannot parse whenever the gateway is not configured.
 */
export function transcodeWorkersAiStream(
	source: ReadableStream<Uint8Array>,
	model: string,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";

	const chunk = (delta: Record<string, unknown>, finishReason: string | null): string =>
		`data: ${JSON.stringify({
			id: `chatcmpl-${model}`,
			object: "chat.completion.chunk",
			model,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		})}\n\n`;

	const deltaEvent = (content: string): string => chunk({ content }, null);

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(encoder.encode(chunk({ role: "assistant" }, null)));

			const reader = source.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					buffer = buffer.replace(/\r/g, "");

					let boundary = buffer.indexOf("\n\n");
					while (boundary !== -1) {
						const rawEvent = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);

						const content = extractResponseField(rawEvent);
						if (content) controller.enqueue(encoder.encode(deltaEvent(content)));

						boundary = buffer.indexOf("\n\n");
					}
				}

				// Flush any multi-byte character left in the decoder.
				buffer += decoder.decode();
				const tail = extractResponseField(buffer);
				if (tail) controller.enqueue(encoder.encode(deltaEvent(tail)));

				controller.enqueue(encoder.encode(chunk({}, "stop")));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			} finally {
				reader.releaseLock();
				controller.close();
			}
		},
	});
}

/**
 * Pulls the `response` field out of a raw SSE event block, tolerating
 * multi-line `data:` fields and non-JSON payloads.
 */
function extractResponseField(rawEvent: string): string {
	const dataLines: string[] = [];
	for (const line of rawEvent.split("\n")) {
		if (line.startsWith("data:")) {
			dataLines.push(line.slice("data:".length).trimStart());
		}
	}
	if (dataLines.length === 0) return "";

	const data = dataLines.join("\n");
	if (data === "[DONE]") return "";

	try {
		const parsed = JSON.parse(data) as { response?: unknown };
		return typeof parsed.response === "string" ? parsed.response : "";
	} catch {
		return "";
	}
}

/**
 * Pulls the text out of a non-streaming Workers AI result.
 */
function extractWorkersAiText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result && typeof result === "object") {
		const candidate = (result as { response?: unknown }).response;
		if (typeof candidate === "string") return candidate;
	}
	return "";
}

function upstreamFailure(
	status: number,
	type: string,
	message: string,
	upstreamDetail?: string,
	upstreamStatus?: number,
): Response {
	const error: Record<string, unknown> = { message, type };
	if (upstreamStatus !== undefined) error.upstream_status = upstreamStatus;
	if (upstreamDetail) error.upstream_detail = upstreamDetail.slice(0, 2000);

	return Response.json({ error }, { status });
}

function clientClosedResponse(): Response {
	// 499 is the conventional "client closed request" status.
	return new Response(null, { status: 499 });
}

function isAbort(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.name === "TimeoutError")
	);
}

async function safeText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

