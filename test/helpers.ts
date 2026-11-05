import { SELF } from "cloudflare:test";

export const ADMIN = "wcha_test-admin-key-0123456789abcdef";

type Options = { key?: string | null; body?: unknown; headers?: Record<string, string> };

/** A request to the worker, with the admin key unless told otherwise. */
export async function call(method: string, path: string, options: Options = {}) {
	const headers: Record<string, string> = { ...options.headers };
	const key = options.key === undefined ? ADMIN : options.key;
	if (key) headers["x-feedbakkr-tool-key"] = key;
	if (options.body !== undefined) headers["content-type"] = "application/json";
	const response = await SELF.fetch(`https://watch.example${path}`, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const text = await response.text();
	// biome-ignore lint/suspicious/noExplicitAny: test responses are checked field by field
	const json: any = text ? JSON.parse(text) : null;
	return { status: response.status, headers: response.headers, json };
}

export function event(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "shop",
		source: "web",
		severity: "error",
		environment: "production",
		timestamp: new Date().toISOString(),
		errorName: "TypeError",
		message: "Cannot read properties of undefined (reading 'price')",
		stack: "TypeError: Cannot read properties of undefined\n    at basket (app.js:10:5)",
		...overrides,
	};
}

export function send(body: unknown, key: string | null = ADMIN, headers?: Record<string, string>) {
	return call("POST", "/v1/events", { key, body, headers });
}

export async function register(id = "shop", name = "Shop") {
	const created = await call("POST", "/v1/applications", { body: { id, name } });
	if (created.status !== 201) throw new Error(`register failed: ${created.status}`);
	return created.json;
}

export async function accessToken(applicationId = "shop", permission = "manage") {
	const created = await call("POST", "/v1/access-tokens", {
		body: { applicationId, name: "FeedBakkr", permission },
	});
	if (created.status !== 201) throw new Error(`access token failed: ${created.status}`);
	return created.json.token as string;
}

export async function ingestKey(projectId = "shop", originAllowlist?: string[]) {
	const created = await call("POST", "/v1/ingest-tokens", {
		body: { projectId, name: "Website", originAllowlist },
	});
	if (created.status !== 201) throw new Error(`ingest key failed: ${created.status}`);
	return created.json.token as string;
}
