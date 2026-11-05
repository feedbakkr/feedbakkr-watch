import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import worker from "../src/index";
import { API_VERSION, VERSION } from "../src/version";
import { accessToken, call, event, ingestKey, register, send } from "./helpers";

async function withAdminKey(key: string | undefined, path: string) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(`https://watch.example${path}`, { headers: { "x-feedbakkr-tool-key": key ?? "" } }),
		{ ...env, FEEDBAKKR_WATCH_ADMIN_KEY: key },
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response.status;
}

describe("keys and scope", () => {
	it("refuses everything until a strong admin key is set", async () => {
		expect(await withAdminKey(undefined, "/v1/groups")).toBe(503);
		expect(await withAdminKey("wcha_short", "/v1/groups")).toBe(503);
		expect(await withAdminKey("not-a-wcha-key-but-long-enough-0123456789", "/v1/groups")).toBe(503);
		expect(await withAdminKey("wcha_this-one-is-long-enough-0123456789", "/v1/groups")).toBe(200);
	});

	it("needs a valid key", async () => {
		expect((await call("GET", "/v1/groups", { key: null })).status).toBe(401);
		expect((await call("GET", "/v1/groups", { key: "wcha_nope" })).status).toBe(401);
		expect((await call("GET", "/v1/groups", { key: "wchm_wat_abc_def" })).status).toBe(401);
	});

	it("limits an access token to its own app, and hides everything else", async () => {
		await register("shop");
		await register("blog");
		const token = await accessToken("shop");
		const blog = (await send(event({ projectId: "blog" }))).json.groupId;
		const shop = (await send(event({ projectId: "shop" }))).json.groupId;

		const list = await call("GET", "/v1/groups?projectId=blog", { key: token });
		expect(list.json.data.map((g: { id: string }) => g.id)).toEqual([shop]);
		for (const [method, path] of [
			["GET", `/v1/groups/${blog}`],
			["GET", `/v1/groups/${blog}/occurrences`],
			["GET", `/v1/groups/${blog}/comments`],
			["POST", `/v1/groups/${blog}/resolve`],
			["DELETE", `/v1/groups/${blog}`],
			["GET", "/v1/applications/blog"],
			["GET", "/v1/applications/blog/components"],
		] as const) {
			expect((await call(method, path, { key: token })).status, `${method} ${path}`).toBe(404);
		}
		const comment = await call("POST", `/v1/groups/${blog}/comments`, {
			key: token,
			body: { authorName: "Mallory", message: "hi" },
		});
		expect(comment.status).toBe(404);
		const bulk = await call("POST", "/v1/groups/bulk-status", {
			key: token,
			body: { ids: [blog, shop], status: "resolved" },
		});
		expect(bulk.json).toMatchObject({ updated: 1, notFound: 1 });
		expect((await call("GET", `/v1/groups/${blog}`)).json.status).toBe("open");

		const apps = await call("GET", "/v1/applications", { key: token });
		expect(apps.json.data.map((a: { id: string }) => a.id)).toEqual(["shop"]);
		expect(
			(await call("GET", "/v1/summary?applicationId=blog", { key: token })).json.applicationId,
		).toBe("shop");
	});

	it("keeps registering apps and managing access tokens to the admin key", async () => {
		await register("shop");
		const token = await accessToken("shop");
		for (const [method, path, body] of [
			["POST", "/v1/applications", { id: "x", name: "X" }],
			["GET", "/v1/access-tokens", undefined],
			["POST", "/v1/access-tokens", { applicationId: "shop", name: "x", permission: "manage" }],
		] as const) {
			expect((await call(method, path, { key: token, body })).status).toBe(403);
		}
	});

	it("lets read tokens only read", async () => {
		await register("shop");
		const token = await accessToken("shop", "read");
		const group = (await send(event())).json.groupId;
		expect((await call("GET", "/v1/groups", { key: token })).status).toBe(200);
		expect((await call("POST", `/v1/groups/${group}/resolve`, { key: token })).status).toBe(403);
		expect(
			(await call("POST", "/v1/ingest-tokens", { key: token, body: { name: "x" } })).status,
		).toBe(403);
	});

	it("stores only hashes, shows each key once, and revokes", async () => {
		await register("shop");
		const token = await accessToken("shop");
		const key = await ingestKey("shop");
		const stored = await env.DB.prepare(
			"SELECT (SELECT token_hash FROM access_tokens) AS a, (SELECT key_hash FROM ingest_keys) AS i",
		).first<{ a: string; i: string }>();
		expect(stored?.a).toMatch(/^[0-9a-f]{64}$/);
		expect(stored?.i).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(await call("GET", "/v1/ingest-tokens"))).not.toContain(key);
		expect(JSON.stringify(await call("GET", "/v1/access-tokens"))).not.toContain(token);

		const connection = await call("GET", "/v1/connection", { key: token });
		expect(connection.json).toMatchObject({
			apiVersion: API_VERSION,
			toolVersion: VERSION,
			permission: "manage",
			application: { id: "shop", name: "Shop" },
		});
		expect((await call("DELETE", "/v1/connection", { key: token })).status).toBe(200);
		expect((await call("GET", "/v1/connection", { key: token })).status).toBe(401);
	});

	it("refuses requests from web pages", async () => {
		const fromPage = await call("GET", "/v1/groups", {
			headers: { origin: "https://evil.example" },
		});
		expect(fromPage.status).toBe(403);
		expect(fromPage.json.error.code).toBe("BROWSER_NOT_ALLOWED");
	});

	it("refuses an access token for an app that isn't registered", async () => {
		const created = await call("POST", "/v1/access-tokens", {
			body: { applicationId: "ghost", name: "x", permission: "read" },
		});
		expect(created.status).toBe(404);
	});
});

describe("apps and groups", () => {
	it("registers apps, lists unregistered ones, and summarises", async () => {
		await register("shop");
		expect(
			(await call("POST", "/v1/applications", { body: { id: "shop", name: "Again" } })).status,
		).toBe(409);
		await send(event());
		await send(event({ message: "Other", environment: "staging" }));
		await send(event({ projectId: "blog" }));

		const apps = await call("GET", "/v1/applications");
		expect(apps.json.data[0]).toMatchObject({
			id: "shop",
			summary: { openIssues: 2, newIssues24h: 2, environments: ["production", "staging"] },
		});
		expect(apps.json.unregistered).toEqual([
			expect.objectContaining({
				projectId: "blog",
				summary: expect.objectContaining({ openIssues: 1 }),
			}),
		]);

		const summary = await call("GET", "/v1/summary?applicationId=shop");
		expect(summary.json).toMatchObject({ applicationId: "shop", openIssues: 2, occurrences24h: 2 });

		const patched = await call("PATCH", "/v1/applications/shop", {
			body: {
				name: "Shop front",
				components: [{ source: "web", displayName: "Website" }, { source: "api" }],
			},
		});
		expect(patched.json).toMatchObject({ name: "Shop front" });
		const components = await call("GET", "/v1/applications/shop/components");
		expect(components.json.data).toEqual([
			expect.objectContaining({
				source: "web",
				displayName: "Website",
				openIssues: 2,
				declared: true,
			}),
			expect.objectContaining({ source: "api", openIssues: 0, declared: true }),
		]);
		expect(components.json.environments).toEqual(["production", "staging"]);

		await call("PATCH", "/v1/applications/shop", { body: { archived: true } });
		expect((await call("GET", "/v1/applications")).json.data).toEqual([]);
		expect((await call("GET", "/v1/applications?includeArchived=1")).json.data).toHaveLength(1);
	});

	it("filters, searches and pages groups", async () => {
		await send(event({ message: "100% broken" }));
		await send(event({ message: "Broken basket", source: "api" }));
		const resolved = (await send(event({ message: "Fixed thing" }))).json.groupId;
		await call("POST", `/v1/groups/${resolved}/resolve`);

		const open = await call("GET", "/v1/groups?status=open&pageSize=1");
		expect(open.json.pagination).toEqual({ page: 1, pageSize: 1, total: 2, hasMore: true });
		expect((await call("GET", "/v1/groups?source=api")).json.data).toHaveLength(1);
		// LIKE wildcards are literal.
		expect((await call("GET", "/v1/groups?q=100%25")).json.data).toHaveLength(1);
		expect((await call("GET", "/v1/groups?q=_")).json.data).toHaveLength(0);
		expect((await call("GET", "/v1/groups?status=nope")).status).toBe(400);
	});

	it("changes status one at a time or in bulk", async () => {
		const a = (await send(event({ message: "A" }))).json.groupId;
		const b = (await send(event({ message: "B" }))).json.groupId;
		expect((await call("POST", `/v1/groups/${a}/ignore`)).json.status).toBe("ignored");
		const bulk = await call("POST", "/v1/groups/bulk-status", {
			body: { ids: [a, b, "egp_missing"], status: "resolved" },
		});
		expect(bulk.json).toEqual({ ok: true, requested: 3, updated: 2, notFound: 1 });
		const again = await call("POST", "/v1/groups/bulk-status", {
			body: { ids: [a], status: "resolved" },
		});
		expect(again.json.updated).toBe(0);
		const tooMany = Array.from({ length: 201 }, (_, i) => `egp_${i}`);
		expect(
			(await call("POST", "/v1/groups/bulk-status", { body: { ids: tooMany, status: "open" } }))
				.status,
		).toBe(400);
	});

	it("caps comments per group and keeps deep pages cheap", async () => {
		const group = (await send(event())).json.groupId;
		await env.DB.prepare("UPDATE error_groups SET comment_count = 200 WHERE id = ?")
			.bind(group)
			.run();
		const full = await call("POST", `/v1/groups/${group}/comments`, {
			body: { authorName: "Sam", message: "One more" },
		});
		expect(full.status).toBe(409);
		const deep = await call("GET", "/v1/groups?page=999999&pageSize=100");
		expect(deep.json.pagination.page).toBe(101);
	});

	it("keeps comments, and deletes a group with its occurrences and comments", async () => {
		const group = (await send(event())).json.groupId;
		await send(event());
		const added = await call("POST", `/v1/groups/${group}/comments`, {
			body: { authorName: "Sam", message: "Looking at it" },
		});
		expect(added.status).toBe(201);
		expect((await call("GET", `/v1/groups/${group}`)).json.commentCount).toBe(1);
		expect((await call("GET", `/v1/groups/${group}/comments`)).json.data).toEqual([
			expect.objectContaining({ authorName: "Sam", message: "Looking at it" }),
		]);
		const occurrences = await call("GET", `/v1/groups/${group}/occurrences?pageSize=1`);
		expect(occurrences.json.pagination.total).toBe(2);

		expect((await call("DELETE", `/v1/groups/${group}`)).status).toBe(200);
		expect((await call("DELETE", `/v1/groups/${group}`)).status).toBe(404);
		const left = await env.DB.prepare(
			"SELECT (SELECT COUNT(*) FROM error_occurrences) + (SELECT COUNT(*) FROM error_group_comments) AS n",
		).first<{ n: number }>();
		expect(left?.n).toBe(0);
	});
});

describe("public routes", () => {
	it("say what they are and nothing more", async () => {
		const manifest = await call("GET", "/.well-known/feedbakkr-tool.json", { key: null });
		expect(manifest.json).toEqual({
			toolId: "feedbakkr-watch",
			name: "FeedBakkr Watch",
			version: VERSION,
			apiVersion: API_VERSION,
		});
		const health = await call("GET", "/health", { key: null });
		expect(health.json).toMatchObject({ ok: true, checks: { db: "ok" } });
		expect(health.headers.get("x-content-type-options")).toBe("nosniff");
		expect((await call("GET", "/portal", { key: null })).status).toBe(404);
	});

	it("reports the package's version", () => {
		expect(VERSION).toBe(pkg.version);
	});
});
