import { afterEach, describe, expect, it, vi } from "vitest";
import {
	call,
	gatewayEnv,
	makeHarness,
	postJson,
	readSseData,
	routerAuth,
	stubFetch,
} from "./helpers";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AI Gateway failure handling", () => {
	// An upstream failure must not look like a client error, and the upstream
	// status must survive so operators can tell 429 from 500.
	it("maps an upstream failure to 502 and preserves the upstream status", async () => {
		stubFetch(
			() =>
				new Response('{"error":"rate limited"}', {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);
		const { env } = makeHarness(gatewayEnv);

		const response = await call(
			postJson(
				"/v1/chat/completions",
				{ messages: [{ role: "user", content: "hi" }], stream: false },
				routerAuth,
			),
			env,
		);

		expect(response.status).toBe(502);
		const payload = (await response.json()) as {
			error: { type: string; upstream_status: number };
		};
		expect(payload.error.type).toBe("ai_gateway_error");
		expect(payload.error.upstream_status).toBe(429);
	});

	it("maps an unreachable gateway to 502", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		const { env } = makeHarness(gatewayEnv);

		const response = await call(
			postJson(
				"/v1/chat/completions",
				{ messages: [{ role: "user", content: "hi" }], stream: false },
				routerAuth,
			),
			env,
		);

		expect(response.status).toBe(502);
		const payload = (await response.json()) as { error: { type: string } };
		expect(payload.error.type).toBe("ai_gateway_unreachable");
	});

	it("maps a Workers AI execution failure to 502", async () => {
		const { env } = makeHarness();
		env.AI = {
			run: vi.fn(async () => {
				throw new Error("model unavailable");
			}),
		} as unknown as Ai;

		const response = await call(
			postJson("/api/chat", { messages: [{ role: "user", content: "hi" }] }),
			env,
		);

		expect(response.status).toBe(502);
		const payload = (await response.json()) as { error: { type: string } };
		expect(payload.error.type).toBe("workers_ai_error");
	});

	it("passes a gateway SSE stream through unchanged", async () => {
		const encoder = new TextEncoder();
		stubFetch(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode(
									'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
								),
							);
							controller.enqueue(encoder.encode("data: [DONE]\n\n"));
							controller.close();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const { env } = makeHarness(gatewayEnv);

		const response = await call(
			postJson(
				"/v1/chat/completions",
				{ messages: [{ role: "user", content: "hi" }] },
				routerAuth,
			),
			env,
		);

		expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
		const data = await readSseData(response);
		expect(data).toHaveLength(2);
		expect(data[1]).toBe("[DONE]");
	});
});
