import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stream as streamCompletions, streamSimple as streamSimpleCompletions } from "../src/api/openai-completions.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { FetchFunction, Model, ProviderHeaders } from "../src/types.ts";
import {
	type ClientIdentity,
	formatUserAgent,
	getIdentityHeaders,
	mergeClientIdentity,
	withClientIdentity,
} from "../src/utils/identity.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { PI_AI_VERSION } from "../src/utils/version.ts";

const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;

function completionsModel(provider: string, baseUrl: string, headers?: Record<string, string>) {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...(headers ? { headers } : {}),
	} satisfies Model<"openai-completions">;
}

function capturingFetch(): { fetch: FetchFunction; headers: () => Headers } {
	let captured: Headers | undefined;
	const fetch: FetchFunction = async (input, init) => {
		captured = new Request(input, init).headers;
		const chunks = [
			{ id: "chatcmpl-identity", choices: [{ delta: { content: "ok" }, finish_reason: null, index: 0 }] },
			{
				id: "chatcmpl-identity",
				choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			},
		];
		const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return {
		fetch,
		headers: () => {
			if (!captured) throw new Error("no request was sent");
			return captured;
		},
	};
}

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });

describe("client identity", () => {
	it("keeps the version constant in sync with package.json", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
		expect(PI_AI_VERSION).toBe(pkg.version);
	});

	it("formats user agents", () => {
		expect(formatUserAgent()).toBe(`pi/${PI_AI_VERSION} (${process.platform}; ${runtime}; ${process.arch})`);
		expect(formatUserAgent({ version: "9.9.9" })).toBe(`pi/9.9.9 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(formatUserAgent({ userAgent: "short", version: "9.9.9" })).toBe("pi");
		expect(formatUserAgent({ userAgent: { custom: "acme/1.0" } })).toBe("acme/1.0");
	});

	it("merges identities field by field", () => {
		expect(mergeClientIdentity(undefined, undefined)).toBeUndefined();
		expect(mergeClientIdentity({ userAgent: "short" }, { version: "1.0.0" })).toEqual({
			userAgent: "short",
			version: "1.0.0",
		});
		expect(mergeClientIdentity({ userAgent: "short" }, { userAgent: "detailed" })).toEqual({ userAgent: "detailed" });
	});

	it("adds only the identity User-Agent to request headers", () => {
		expect(getIdentityHeaders()).toEqual({ "User-Agent": formatUserAgent() });
		expect(getIdentityHeaders({ userAgent: { custom: "acme/1.0" } })).toEqual({ "User-Agent": "acme/1.0" });
	});
});

describe("client identity in requests", () => {
	it("applies the identity below model and request headers", async () => {
		const capture = capturingFetch();
		const model = completionsModel("openrouter", "https://openrouter.ai/api/v1");
		await streamCompletions(model, context, {
			apiKey: "key",
			fetch: capture.fetch,
			identity: { userAgent: "short" },
			headers: { "User-Agent": null } as ProviderHeaders,
		}).result();

		expect(capture.headers().has("user-agent")).toBe(false);
	});

	it("keeps impersonating model headers over the identity User-Agent", async () => {
		const capture = capturingFetch();
		const model = completionsModel("github-copilot", "https://api.githubcopilot.com", {
			"User-Agent": "GitHubCopilotChat/0.35.0",
		});
		await streamCompletions(model, context, {
			apiKey: "key",
			fetch: capture.fetch,
			identity: { userAgent: { custom: "acme" } },
		}).result();

		expect(capture.headers().get("user-agent")).toBe("GitHubCopilotChat/0.35.0");
	});

	it("merges request identity over the Models and wrapper identities", async () => {
		const model = completionsModel("openrouter", "https://openrouter.ai/api/v1");
		const models = createModels({ identity: { userAgent: "short" } });
		models.setProvider(
			createProvider({
				id: "openrouter",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "key" } }) } },
				models: [model],
				api: { stream: streamCompletions, streamSimple: streamSimpleCompletions },
			}),
		);
		const send = async (modelsForRequest: typeof models, identity?: ClientIdentity) => {
			const capture = capturingFetch();
			await modelsForRequest.streamSimple(model, context, { fetch: capture.fetch, identity }).result();
			return capture.headers();
		};

		const fromModels = await send(models);
		expect(fromModels.get("user-agent")).toBe("pi");

		const wrapped = withClientIdentity(models, { userAgent: "detailed", version: "9.9.9" });
		const fromWrapper = await send(wrapped);
		expect(fromWrapper.get("user-agent")).toBe(`pi/9.9.9 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(wrapped.getModel("openrouter", "test-model")).toBe(model);
		// A MutableModels stays mutable.
		wrapped.deleteProvider("openrouter");
		expect(models.getProvider("openrouter")).toBeUndefined();
		models.setProvider(
			createProvider({
				id: "openrouter",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "key" } }) } },
				models: [model],
				api: { stream: streamCompletions, streamSimple: streamSimpleCompletions },
			}),
		);

		const fromRequest = await send(wrapped, { userAgent: { custom: "acme/1.0" } });
		expect(fromRequest.get("user-agent")).toBe("acme/1.0");
	});

	it("sends the OpenCode session header to custom providers pointing at OpenCode", async () => {
		const model = completionsModel("custom-opencode", "https://opencode.ai/zen/v1");
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "custom-opencode",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "key" } }) } },
				models: [model],
				api: { stream: streamCompletions, streamSimple: streamSimpleCompletions },
			}),
		);
		const send = async (headers?: ProviderHeaders) => {
			const capture = capturingFetch();
			await models.streamSimple(model, context, { fetch: capture.fetch, sessionId: "session-1", headers }).result();
			return capture.headers();
		};

		expect((await send()).get("x-opencode-session")).toBe("session-1");
		expect((await send({ "X-OpenCode-Session": "configured" })).get("x-opencode-session")).toBe("configured");
	});
});
