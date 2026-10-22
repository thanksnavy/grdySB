import { vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

export interface CapturedCall {
	model: string;
	inputs: Record<string, unknown>;
	options: Record<string, unknown>;
}

export interface MockHarness {
	env: Env;
	calls: CapturedCall[];
	assetsFetch: ReturnType<typeof vi.fn>;
}

/**
 * Builds an Env with mocked bindings.
 *
 * The AI binding records every call and returns a Workers AI shaped SSE
 * stream, which is what the router's fallback path transcodes.
 */
export function makeHarness(overrides: Partial<Env> = {}): MockHarness {
	const calls: CapturedCall[] = [];

	const assetsFetch = vi.fn(async () => new Response("asset-body", { status: 200 }));

	const env: Env = {
		AI: {
			run: vi.fn(async (model: string, inputs: unknown, options: unknown) => {
				calls.push({
					model,
					inputs: inputs as Record<string, unknown>,
					options: (options ?? {}) as Record<string, unknown>,
				});

				const wantsStream = (inputs as { stream?: boolean }).stream === true;
				if (wantsStream) {
					return workersAiStream(['{"response":"Hello"}', '{"response":" world"}']);
				}
				return { response: "Hello world" };
			}),
		} as unknown as Ai,
		ASSETS: { fetch: assetsFetch },
		...overrides,
	};

	return { env, calls, assetsFetch };
}

/**
 * A ReadableStream emitting the given JSON payloads as SSE events.
 */
export function workersAiStream(payloads: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const payload of payloads) {
				controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
			}
			controller.close();
		},
	});
}

/**
 * Reads an SSE response body into its constituent `data:` payloads.
 */
export async function readSseData(response: Response): Promise<string[]> {
	const text = await response.text();
	return text
		.replace(/\r/g, "")
		.split("\n\n")
		.filter((block) => block.trim() !== "")
		.map((block) =>
			block
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice("data:".length).trimStart())
				.join("\n"),
		);
}

export function postJson(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Request {
	return new Request(`https://router.test${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

type WorkerRequest = Parameters<typeof worker.fetch>[0];

/**
 * Invokes the Worker's fetch handler with a plain Request.
 *
 * The handler takes only (request, env) — the ExecutionContext parameter was
 * dropped because it was never used.
 */
export function call(request: Request, env: Env): Promise<Response> {
	return worker.fetch(request as unknown as WorkerRequest, env);
}

export interface FetchRecord {
	url: string;
	init: RequestInit;
}

/**
 * Replaces global fetch with a stub that records calls and returns a canned
 * response, so the gateway path can be asserted without network access.
 *
 * Callers must invoke `vi.unstubAllGlobals()` afterwards.
 */
export function stubFetch(response: () => Response): FetchRecord[] {
	const records: FetchRecord[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			records.push({ url: String(url), init: init ?? {} });
			return response();
		}),
	);
	return records;
}

/** Env values for a fully configured gateway. */
export const gatewayEnv = {
	CLOUDFLARE_ACCOUNT_ID: "acct-123",
	AI_GATEWAY_ID: "my-gateway",
	CF_AIG_TOKEN: "gateway-token",
	ROUTER_API_KEY: "router-key",
};

/** A valid Authorization header for `gatewayEnv`. */
export const routerAuth = { authorization: "Bearer router-key" };

