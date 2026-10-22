import { describe, expect, it } from "vitest";
import { toOpenAiCompletion, transcodeWorkersAiStream } from "../src/gateway";
import { readSseData, workersAiStream } from "./helpers";

/** Collects the `content` deltas from already-parsed SSE data payloads. */
function contentFrom(data: string[]): string {
	return data
		.filter((d) => d !== "[DONE]")
		.map((d) => JSON.parse(d) as { choices: { delta: { content?: string } }[] })
		.map((parsed) => parsed.choices[0].delta.content ?? "")
		.join("");
}

describe("transcodeWorkersAiStream", () => {
	it("converts Workers AI chunks into OpenAI delta chunks", async () => {
		const source = workersAiStream([
			'{"response":"Hello"}',
			'{"response":" world"}',
		]);
		const response = new Response(transcodeWorkersAiStream(source, "test-model"));
		const data = await readSseData(response);

		expect(data[data.length - 1]).toBe("[DONE]");
		expect(contentFrom(data)).toBe("Hello world");
	});

	it("announces the assistant role in the first chunk", async () => {
		const source = workersAiStream(['{"response":"hi"}']);
		const response = new Response(transcodeWorkersAiStream(source, "m"));
		const data = await readSseData(response);

		const first = JSON.parse(data[0]) as {
			object: string;
			choices: { delta: { role?: string } }[];
		};
		expect(first.object).toBe("chat.completion.chunk");
		expect(first.choices[0].delta.role).toBe("assistant");
	});

	it("emits a stop chunk before [DONE]", async () => {
		const source = workersAiStream(['{"response":"hi"}']);
		const response = new Response(transcodeWorkersAiStream(source, "m"));
		const data = await readSseData(response);

		const penultimate = JSON.parse(data[data.length - 2]) as {
			choices: { finish_reason: string | null }[];
		};
		expect(penultimate.choices[0].finish_reason).toBe("stop");
	});

	// SSE events routinely arrive split across network chunks; a naive
	// per-chunk parse silently drops them.
	it("reassembles an event split across chunk boundaries", async () => {
		const encoder = new TextEncoder();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('data: {"resp'));
				controller.enqueue(encoder.encode('onse":"split"'));
				controller.enqueue(encoder.encode("}\n\n"));
				controller.close();
			},
		});

		const response = new Response(transcodeWorkersAiStream(source, "m"));
		expect(contentFrom(await readSseData(response))).toBe("split");
	});

	it("normalises CRLF line endings", async () => {
		const encoder = new TextEncoder();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode('data: {"response":"crlf"}\r\n\r\n'),
				);
				controller.close();
			},
		});

		const response = new Response(transcodeWorkersAiStream(source, "m"));
		expect(contentFrom(await readSseData(response))).toBe("crlf");
	});

	it("joins multi-line data fields", async () => {
		const encoder = new TextEncoder();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode('data: {"response":\ndata: "multi"}\n\n'),
				);
				controller.close();
			},
		});

		const response = new Response(transcodeWorkersAiStream(source, "m"));
		expect(contentFrom(await readSseData(response))).toBe("multi");
	});

	it("ignores non-JSON and [DONE] payloads without throwing", async () => {
		const source = workersAiStream([
			"not json at all",
			"[DONE]",
			'{"response":"ok"}',
		]);
		const response = new Response(transcodeWorkersAiStream(source, "m"));
		expect(contentFrom(await readSseData(response))).toBe("ok");
	});

	it("handles an empty source stream", async () => {
		const source = workersAiStream([]);
		const response = new Response(transcodeWorkersAiStream(source, "m"));
		const data = await readSseData(response);

		expect(data[data.length - 1]).toBe("[DONE]");
		expect(contentFrom(data)).toBe("");
	});
});

describe("toOpenAiCompletion", () => {
	it("produces a well-formed chat.completion object", () => {
		const completion = toOpenAiCompletion("hi there", "test-model") as {
			object: string;
			model: string;
			choices: {
				message: { role: string; content: string };
				finish_reason: string;
			}[];
		};

		expect(completion.object).toBe("chat.completion");
		expect(completion.model).toBe("test-model");
		expect(completion.choices[0].message).toEqual({
			role: "assistant",
			content: "hi there",
		});
		expect(completion.choices[0].finish_reason).toBe("stop");
	});

	it("includes a unique id per call", () => {
		const a = toOpenAiCompletion("x", "m") as { id: string };
		const b = toOpenAiCompletion("x", "m") as { id: string };
		expect(a.id).not.toBe(b.id);
	});
});
