/**
 * LLM Router Frontend
 *
 * Handles the chat UI and talks to the router's /api/chat surface.
 *
 * Two rules are load-bearing here:
 *  - Model output is untrusted and is only ever inserted via textContent,
 *    never innerHTML.
 *  - The opening greeting lives in index.html only. It is deliberately not
 *    part of chatHistory, so it is never sent to the model as though the
 *    assistant had said it.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const stopButton = document.getElementById("stop-button");
const modelSelect = document.getElementById("model-select");
const typingIndicator = document.getElementById("typing-indicator");

// Chat state
let chatHistory = [];
let isProcessing = false;
let abortController = null;

/**
 * How many messages are sent per request. The array is trimmed to this bound
 * so a long conversation cannot eventually exceed the model's context window.
 */
const MAX_HISTORY_MESSAGES = 24;

const API_KEY_STORAGE_KEY = "router.apiKey";

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

sendButton.addEventListener("click", sendMessage);
stopButton.addEventListener("click", stopGeneration);

loadModels();

/**
 * Populates the model picker from the router's registry.
 *
 * Failure is non-fatal: the router picks a sensible default when no model is
 * sent, so the UI stays usable even if /v1/models is unreachable.
 */
async function loadModels() {
	try {
		const response = await fetch("/v1/models", {
			headers: authHeaders(),
		});
		if (!response.ok) return;

		const payload = await response.json();
		const models = Array.isArray(payload.data) ? payload.data : [];
		if (models.length === 0) return;

		modelSelect.textContent = "";
		for (const model of models) {
			const option = document.createElement("option");
			option.value = model.id;
			option.textContent = model.label || model.id;
			modelSelect.appendChild(option);
		}
		modelSelect.disabled = false;
	} catch (error) {
		console.error("Could not load model list:", error);
	}
}

/**
 * Returns the stored router API key, or an empty string when unset.
 */
function getApiKey() {
	try {
		return localStorage.getItem(API_KEY_STORAGE_KEY) || "";
	} catch {
		// Storage can be unavailable (private mode); fall back to in-memory.
		return "";
	}
}

function setApiKey(value) {
	try {
		localStorage.setItem(API_KEY_STORAGE_KEY, value);
	} catch {
		// Ignore: the key simply will not persist.
	}
}

function authHeaders() {
	const key = getApiKey();
	return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * Asks for the router API key after a 401. Returns true when a key was
 * supplied, so the caller can retry once.
 */
function promptForApiKey() {
	const supplied = window.prompt(
		"This router requires an API key. Paste it below:",
		"",
	);
	if (!supplied) return false;
	setApiKey(supplied.trim());
	return true;
}

/**
 * Aborts the in-flight request. The Worker propagates the abort upstream so
 * generation stops rather than continuing to run.
 */
function stopGeneration() {
	if (abortController) {
		abortController.abort();
		abortController = null;
	}
}

/**
 * Sends a message to the router and renders the streamed response.
 */
async function sendMessage() {
	const message = userInput.value.trim();
	if (message === "" || isProcessing) return;

	setProcessing(true);

	addMessageToChat("user", message);
	userInput.value = "";
	userInput.style.height = "auto";
	chatHistory.push({ role: "user", content: message });

	// Assistant bubble built with createElement/textContent only.
	const assistantMessageEl = document.createElement("div");
	assistantMessageEl.className = "message assistant-message";
	const assistantTextEl = document.createElement("p");
	assistantMessageEl.appendChild(assistantTextEl);
	chatMessages.appendChild(assistantMessageEl);
	scrollToBottom();

	abortController = new AbortController();
	let responseText = "";

	try {
		let response = await postChat(abortController.signal);

		// One retry after supplying a key, so a first-run 401 is recoverable
		// without the user losing their message.
		if (response.status === 401 && promptForApiKey()) {
			response = await postChat(abortController.signal);
		}

		if (!response.ok) {
			throw new Error(await describeError(response));
		}
		if (!response.body) {
			throw new Error("Response body is null");
		}

		responseText = await consumeStream(response.body, (accumulated) => {
			assistantTextEl.textContent = accumulated;
			scrollToBottom();
		});

		if (responseText.length > 0) {
			chatHistory.push({ role: "assistant", content: responseText });
			trimHistory();
		}
	} catch (error) {
		if (isAbortError(error)) {
			// Stopped by the user: keep whatever arrived, mark it as partial.
			if (responseText.length > 0) {
				chatHistory.push({ role: "assistant", content: responseText });
				trimHistory();
			}
			assistantTextEl.textContent = `${responseText}\n\n[stopped]`;
		} else {
			console.error("Error:", error);
			assistantMessageEl.remove();
			addMessageToChat(
				"assistant",
				`Sorry, there was an error processing your request. ${error.message || ""}`.trim(),
			);
			// Drop the user turn so history never contains two consecutive user
			// messages. It stays visible in the UI.
			chatHistory.pop();
		}
	} finally {
		abortController = null;
		setProcessing(false);
	}
}

/**
 * Posts the current conversation to the router.
 */
function postChat(signal) {
	return fetch("/api/chat", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...authHeaders(),
		},
		body: JSON.stringify({
			messages: trimHistory(),
			model: modelSelect.value || undefined,
			stream: true,
		}),
		signal,
	});
}

/**
 * Reads an SSE stream to completion, invoking onDelta with the accumulated
 * text after each content chunk.
 *
 * Events are buffered across chunk boundaries and parsed in exactly one
 * place, so the mid-stream and end-of-stream paths cannot diverge.
 */
async function consumeStream(body, onDelta) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";

	const applyEvent = (data) => {
		if (data === "[DONE]") return "done";
		const content = extractDeltaContent(data);
		if (content) {
			text += content;
			onDelta(text);
		}
		return "continue";
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const parsed = consumeSseEvents(buffer);
			buffer = parsed.buffer;

			for (const data of parsed.events) {
				if (applyEvent(data) === "done") return text;
			}
		}

		// Flush any multi-byte character left in the decoder, then drain a
		// final event that arrived without its terminating blank line.
		buffer += decoder.decode();
		for (const data of consumeSseEvents(`${buffer}\n\n`).events) {
			if (applyEvent(data) === "done") break;
		}

		return text;
	} finally {
		reader.releaseLock();
	}
}


/**
 * Extracts assistant text from one SSE data payload, accepting both the
 * OpenAI delta shape and the Workers AI `response` shape.
 */
function extractDeltaContent(data) {
	let parsed;
	try {
		parsed = JSON.parse(data);
	} catch (error) {
		console.error("Error parsing SSE data as JSON:", error, data);
		return "";
	}

	const delta = parsed?.choices?.[0]?.delta?.content;
	if (typeof delta === "string" && delta.length > 0) return delta;

	if (typeof parsed?.response === "string" && parsed.response.length > 0) {
		return parsed.response;
	}

	return "";
}

/**
 * Splits a buffer into complete SSE events, returning the unconsumed tail.
 */
function consumeSseEvents(buffer) {
	const normalized = buffer.replace(/\r/g, "");
	const events = [];
	let remainder = normalized;

	let eventEndIndex = remainder.indexOf("\n\n");
	while (eventEndIndex !== -1) {
		const rawEvent = remainder.slice(0, eventEndIndex);
		remainder = remainder.slice(eventEndIndex + 2);

		const dataLines = [];
		for (const line of rawEvent.split("\n")) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice("data:".length).trimStart());
			}
		}
		if (dataLines.length > 0) events.push(dataLines.join("\n"));

		eventEndIndex = remainder.indexOf("\n\n");
	}

	return { events, buffer: remainder };
}

/**
 * Trims history to the most recent messages, in place, and returns it.
 */
function trimHistory() {
	if (chatHistory.length > MAX_HISTORY_MESSAGES) {
		chatHistory = chatHistory.slice(-MAX_HISTORY_MESSAGES);
	}
	return chatHistory;
}

/**
 * Turns a non-2xx response into a readable message, preferring the router's
 * JSON error body.
 */
async function describeError(response) {
	try {
		const payload = await response.json();
		const message = payload?.error?.message;
		if (typeof message === "string" && message) {
			return `${response.status}: ${message}`;
		}
	} catch {
		// Fall through to the generic form.
	}
	return `Request failed with status ${response.status}`;
}

/**
 * Adds a message bubble using textContent, never innerHTML: content here is
 * either user input or model output, both untrusted.
 */
function addMessageToChat(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;

	const textEl = document.createElement("p");
	textEl.textContent = content;
	messageEl.appendChild(textEl);

	chatMessages.appendChild(messageEl);
	scrollToBottom();
}

function scrollToBottom() {
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setProcessing(processing) {
	isProcessing = processing;
	userInput.disabled = processing;
	sendButton.disabled = processing;
	modelSelect.disabled = processing;
	stopButton.hidden = !processing;
	typingIndicator.classList.toggle("visible", processing);

	if (!processing) {
		userInput.focus();
	}
}

function isAbortError(error) {
	return error?.name === "AbortError";
}

