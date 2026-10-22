/**
 * Inbound request validation.
 *
 * Everything here exists to turn untrusted input into either a well-formed
 * `ChatMessage[]` or a specific 400-level reason. Nothing in this module
 * throws: a throw would surface as a 500 and hide a client error in the
 * gateway's error analytics.
 */
import type { BodyResult, ChatMessage, ValidationResult } from "./types";
import { ALLOWED_ROLES, LIMITS } from "./config";

/**
 * Validates and normalises a parsed request body into chat messages.
 *
 * Accepts either `{ messages: [...] }` (the built-in UI) or a bare array, so
 * the same core serves both surfaces.
 */
export function validateMessages(body: unknown): ValidationResult {
	const raw = extractMessages(body);
	if (!raw.ok) return raw;

	const messages = raw.messages;

	if (messages.length === 0) {
		return { ok: false, error: "messages must contain at least one message" };
	}

	if (messages.length > LIMITS.maxMessages) {
		return {
			ok: false,
			error: `messages must contain at most ${LIMITS.maxMessages} messages (received ${messages.length})`,
		};
	}

	const normalized: ChatMessage[] = [];

	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		const at = `messages[${index}]`;

		if (typeof message !== "object" || message === null) {
			return { ok: false, error: `${at} must be an object` };
		}

		const { role, content } = message as Record<string, unknown>;

		if (typeof role !== "string") {
			return { ok: false, error: `${at}.role must be a string` };
		}

		if (!isAllowedRole(role)) {
			return {
				ok: false,
				error: `${at}.role must be one of: ${ALLOWED_ROLES.join(", ")} (received "${role}")`,
			};
		}

		if (typeof content !== "string") {
			return { ok: false, error: `${at}.content must be a string` };
		}

		if (content.length > LIMITS.maxMessageChars) {
			return {
				ok: false,
				error: `${at}.content must be at most ${LIMITS.maxMessageChars} characters (received ${content.length})`,
			};
		}

		normalized.push({ role, content });
	}

	return { ok: true, messages: normalized };
}


/**
 * Type guard narrowing an arbitrary role string to a ChatMessage role.
 */
function isAllowedRole(role: string): role is ChatMessage["role"] {
	return (ALLOWED_ROLES as readonly string[]).includes(role);
}

/**
 * Pulls the messages array out of a parsed body, or explains why it cannot.
 */
function extractMessages(
	body: unknown,
): { ok: true; messages: unknown[] } | { ok: false; error: string } {
	if (Array.isArray(body)) {
		return { ok: true, messages: body };
	}

	if (typeof body !== "object" || body === null) {
		return {
			ok: false,
			error: "request body must be a JSON object or an array of messages",
		};
	}

	const { messages } = body as Record<string, unknown>;

	if (messages === undefined) {
		return { ok: false, error: "request body must include a messages array" };
	}

	if (!Array.isArray(messages)) {
		return { ok: false, error: "messages must be an array" };
	}

	return { ok: true, messages };
}

/**
 * Reads and parses a request body, enforcing a size bound before parsing.
 *
 * Returns a discriminated result rather than throwing so callers can map each
 * failure to an accurate status code.
 */
export async function readJsonBody(request: Request): Promise<BodyResult> {
	const length = request.headers.get("content-length");
	if (length !== null && Number(length) > LIMITS.maxBodyBytes) {
		return {
			ok: false,
			error: `request body must be at most ${LIMITS.maxBodyBytes} bytes`,
			status: 413,
		};
	}

	const text = await request.clone().text();

	if (text.length > LIMITS.maxBodyBytes) {
		return {
			ok: false,
			error: `request body must be at most ${LIMITS.maxBodyBytes} bytes`,
			status: 413,
		};
	}

	if (text.trim() === "") {
		return { ok: false, error: "request body must not be empty", status: 400 };
	}

	try {
		return { ok: true, body: JSON.parse(text) };
	} catch {
		return { ok: false, error: "request body must be valid JSON", status: 400 };
	}
}

