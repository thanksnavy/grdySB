import { afterEach, describe, expect, it, vi } from "vitest";
import { call, gatewayEnv, makeHarness, postJson, routerAuth, stubFetch } from "./helpers";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AI Gateway routing", () => {
	it("posts to the gateway's OpenAI-compatible endpoint", async () => {
		const records = stubFetch(() =>
			Response.json({ object: "chat.completion", choices: [] }),
		);
		const { env } = makeHarness(gatewayEnv);

		await call(
			postJson(
				"/v1/chat/completions",
				{
					model: "openrouter/deepseek/deepseek-chat",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				},
				routerAuth,
			),
			env,
		);

		expect(records).toHaveLength(1);
		expect(records[0].url).toBe(
			"https://gateway.ai.cloudflare.com/v1/acct-123/my-gateway/compat/chat/completions",
		);

		const body = JSON.parse(String(records[0].init.body)) as Record<string, unknown>;
		expect(body.model).toBe("openrouter/deepseek/deepseek-chat");
		expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
	});

	it("authenticates to the gateway with cf-aig-authorization", async () => {
		const records = stubFetch(() => Response.json({ choices: [] }));
		const { env } = makeHarness(gatewayEnv);

		await call(
			postJson(
				"/v1/chat/completions",
				{ messages: [{ role: "user", content: "hi" }], stream: false },
				routerAuth,
			),
			env,
		);

		const headers = records[0].init.headers as Record<string, string>;
		expect(headers["cf-aig-authorization"]).toBe("Bearer gateway-token");
	});

	// The router's own API key must never be forwarded upstream as a provider
	// credential: it would both leak the key and be rejected by the provider.
	it("does not forward the caller's Authorization header upstream", async () => {
		const records = stubFetch(() => Response.json({ choices: [] }));
		const { env } = makeHarness(gatewayEnv);

		await call(
			postJson(
				"/v1/chat/completions",
				{ messages: [{ role: "user", content: "hi" }], stream: false },
				routerAuth,
			),
			env,
		);

		const headers = records[0].init.headers as Record<string, string>;
		expect(headers.authorization).toBeUndefined();
		expect(JSON.stringify(headers)).not.toContain("router-key");
	});

	it("preserves the gateway's routing metadata headers", async () => {
		stubFetch(
			() =>
				new Response('{"choices":[]}', {
					headers: {
						"content-type": "application/json",
						"cf-aig-model": "deepseek-chat",
						"cf-aig-provider": "openrouter",
					},
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

		expect(response.headers.get("cf-aig-model")).toBe("deepseek-chat");
		expect(response.headers.get("cf-aig-provider")).toBe("openrouter");
	});

	it("falls back to Workers AI when only one gateway var is set", async () => {
		const records = stubFetch(() => Response.json({ choices: [] }));
		const { env, calls } = makeHarness({ AI_GATEWAY_ID: "my-gateway" });

		await call(
			postJson("/api/chat", { messages: [{ role: "user", content: "hi" }] }),
			env,
		);

		expect(records).toHaveLength(0);
		expect(calls).toHaveLength(1);
	});
});
