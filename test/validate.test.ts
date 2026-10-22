import { describe, expect, it } from "vitest";
import { readJsonBody, validateMessages } from "../src/validate";
import { LIMITS } from "../src/config";

describe("validateMessages", () => {
	it("accepts a well-formed messages array", () => {
		const result = validateMessages({
			messages: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi there" },
			],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.messages).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		]);
	});

	it("accepts a bare array", () => {
		const result = validateMessages([{ role: "user", content: "hello" }]);
		expect(result.ok).toBe(true);
	});

	// Regression for review finding H2: a non-array `messages` used to throw
	// inside the handler and surface as a 500.
	it("rejects a non-array messages field", () => {
		const result = validateMessages({ messages: "not-an-array" });
		expect(result).toEqual({ ok: false, error: "messages must be an array" });
	});

	it("rejects a missing messages field", () => {
		const result = validateMessages({});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/must include a messages array/);
	});

	it("rejects a non-object body", () => {
		expect(validateMessages(42).ok).toBe(false);
		expect(validateMessages(null).ok).toBe(false);
	});

	it("rejects an empty messages array", () => {
		const result = validateMessages({ messages: [] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/at least one message/);
	});

	// Regression for H2: an unbounded array used to be forwarded to a paid
	// model intact.
	it("rejects more messages than the configured maximum", () => {
		const messages = Array.from({ length: LIMITS.maxMessages + 1 }, () => ({
			role: "user",
			content: "x",
		}));

		const result = validateMessages({ messages });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/at most 64 messages/);
	});

	it("accepts exactly the maximum number of messages", () => {
		const messages = Array.from({ length: LIMITS.maxMessages }, () => ({
			role: "user",
			content: "x",
		}));
		expect(validateMessages({ messages }).ok).toBe(true);
	});

	// Regression for H2: an unknown role and a numeric content used to be
	// forwarded to the model verbatim.
	it("rejects an unknown role", () => {
		const result = validateMessages({
			messages: [{ role: "wizard", content: "hi" }],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/must be one of: system, user, assistant/);
	});

	it("rejects non-string content", () => {
		const result = validateMessages({
			messages: [{ role: "user", content: 12345 }],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/content must be a string/);
	});

	it("rejects a non-string role", () => {
		const result = validateMessages({
			messages: [{ role: 1, content: "hi" }],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/role must be a string/);
	});

	it("rejects a non-object message entry", () => {
		const result = validateMessages({ messages: ["just a string"] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/must be an object/);
	});

	it("rejects an over-long message and names the index", () => {
		const result = validateMessages({
			messages: [
				{ role: "user", content: "ok" },
				{ role: "user", content: "x".repeat(LIMITS.maxMessageChars + 1) },
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/messages\[1\]\.content/);
	});

	it("drops extra fields rather than forwarding them", () => {
		const result = validateMessages({
			messages: [{ role: "user", content: "hi", name: "attacker" }],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.messages[0]).toEqual({ role: "user", content: "hi" });
	});
});

describe("readJsonBody", () => {
	function request(body: string, headers?: Record<string, string>): Request {
		return new Request("https://router.test/api/chat", {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body,
		});
	}

	it("parses a valid JSON body", async () => {
		const result = await readJsonBody(request('{"messages":[]}'));
		expect(result.ok).toBe(true);
	});

	// Regression for H3: malformed JSON used to surface as a 500.
	it("returns 400 for malformed JSON", async () => {
		const result = await readJsonBody(request("{not json"));
		expect(result).toEqual({
			ok: false,
			error: "request body must be valid JSON",
			status: 400,
		});
	});

	it("returns 400 for an empty body", async () => {
		const result = await readJsonBody(request("   "));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(400);
	});

	it("returns 413 when content-length exceeds the bound", async () => {
		const result = await readJsonBody(
			request("{}", { "content-length": String(LIMITS.maxBodyBytes + 1) }),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(413);
	});

	it("returns 413 when the actual body exceeds the bound", async () => {
		const result = await readJsonBody(
			request(`{"messages":"${"x".repeat(LIMITS.maxBodyBytes + 10)}"}`),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(413);
	});
});
