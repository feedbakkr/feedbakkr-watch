import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accessToken, call, event, ingestKey, register, send } from "./helpers";

describe("POST /v1/events", () => {
	it("groups repeats of the same error and counts distinct users and sessions", async () => {
		const first = await send(event({ user: { idHash: "u1", sessionId: "s1" } }));
		expect(first.status).toBe(202);
		expect(first.json).toMatchObject({ ok: true, isNewGroup: true });

		await send(event({ user: { idHash: "u1", sessionId: "s2" } }));
		const third = await send(event({ user: { idHash: "u2", sessionId: "s2" } }));
		expect(third.json).toMatchObject({ isNewGroup: false, groupId: first.json.groupId });

		const group = await call("GET", `/v1/groups/${first.json.groupId}`);
		expect(group.json).toMatchObject({
			occurrenceCount: 3,
			affectedUsersCount: 2,
			affectedSessionsCount: 2,
			title: "TypeError: Cannot read properties of undefined (reading 'price')",
			status: "open",
		});

		const other = await send(event({ message: "Something else broke" }));
		expect(other.json.groupId).not.toBe(first.json.groupId);
		const otherEnvironment = await send(event({ environment: "staging" }));
		expect(otherEnvironment.json.groupId).not.toBe(first.json.groupId);
	});

	it("reopens a resolved group when the error happens again, but leaves ignored ones", async () => {
		const resolved = await send(event());
		await call("POST", `/v1/groups/${resolved.json.groupId}/resolve`);
		await send(event());
		expect((await call("GET", `/v1/groups/${resolved.json.groupId}`)).json.status).toBe("open");

		const ignored = await send(event({ message: "Noise" }));
		await call("POST", `/v1/groups/${ignored.json.groupId}/ignore`);
		await send(event({ message: "Noise" }));
		expect((await call("GET", `/v1/groups/${ignored.json.groupId}`)).json.status).toBe("ignored");
	});

	it("stores dates outside a sane window as now", async () => {
		const sent = await send(event({ timestamp: "2099-01-01T00:00:00Z" }));
		const group = await call("GET", `/v1/groups/${sent.json.groupId}`);
		expect(Math.abs(Date.parse(group.json.lastSeenAt) - Date.now())).toBeLessThan(60_000);
	});

	it("redacts sensitive keys and trims what it stores", async () => {
		const sent = await send(
			event({
				message: "x".repeat(20_000),
				context: { password: "hunter2", basket: 3 },
				tags: { authorization: "Bearer abc" },
			}),
		);
		const occurrences = await call("GET", `/v1/groups/${sent.json.groupId}/occurrences`);
		const [stored] = occurrences.json.data;
		expect(stored.message).toHaveLength(8 * 1024);
		expect(stored.context).toEqual({ password: "[REDACTED]", basket: 3 });
		expect(stored.tags).toEqual({ authorization: "[REDACTED]" });
	});

	it("refuses bad events before touching the database", async () => {
		expect((await send("not json")).status).toBe(400);
		expect((await send(event({ projectId: "../etc" }))).status).toBe(400);
		expect((await send(event({ severity: "catastrophic" }))).status).toBe(400);
		expect((await send(event({ source: "x".repeat(65) }))).status).toBe(400);
		const tooBig = await send(event({ stack: "x".repeat(130 * 1024) }));
		expect(tooBig.status).toBe(413);
		const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM error_groups").first<{
			n: number;
		}>()) as { n: number };
		expect(n).toBe(0);
	});

	it("needs a key, and refuses the admin key from a browser", async () => {
		expect((await send(event(), null)).status).toBe(401);
		expect((await send(event(), "wcha_wrong-key-0123456789abcdefghij")).status).toBe(401);
		const browser = await send(event(), undefined, { origin: "https://shop.example" });
		expect(browser.status).toBe(403);
		expect(browser.json.error.code).toBe("ADMIN_KEY_IN_BROWSER");
	});

	it("limits an ingest key to its app, its origins, and until it's revoked", async () => {
		await register();
		const key = await ingestKey("shop", ["https://shop.example"]);
		const fromShop = { origin: "https://shop.example" };

		expect((await send(event(), key, fromShop)).status).toBe(202);
		expect((await send(event({ projectId: "blog" }), key, fromShop)).json.error.code).toBe(
			"PROJECT_MISMATCH",
		);
		expect((await send(event(), key, { origin: "https://evil.example" })).status).toBe(403);
		expect((await send(event(), key)).status).toBe(403);
		expect((await send(event(), `${key.slice(0, -4)}0000`, fromShop)).status).toBe(401);

		const [record] = (await call("GET", "/v1/ingest-tokens")).json.data;
		expect(record.lastUsedAt).not.toBeNull();
		await call("DELETE", `/v1/ingest-tokens/${record.id}`);
		expect((await send(event(), key, fromShop)).status).toBe(401);
	});

	it("lets the sites on an ingest key change without changing the key", async () => {
		await register("shop");
		await register("blog");
		const key = await ingestKey("shop", ["https://shop.example"]);
		const [record] = (await call("GET", "/v1/ingest-tokens")).json.data;
		const fromStaging = { origin: "https://staging.shop.example" };
		expect((await send(event(), key, fromStaging)).status).toBe(403);

		const edited = await call("PATCH", `/v1/ingest-tokens/${record.id}`, {
			body: {
				name: "Website and staging",
				originAllowlist: ["https://shop.example", "https://Staging.Shop.example/"],
			},
		});
		expect(edited.json).toMatchObject({
			name: "Website and staging",
			originAllowlist: ["https://shop.example", "https://staging.shop.example"],
		});
		expect((await send(event(), key, fromStaging)).status).toBe(202);

		// Another app's token can't see it; bad input and revoked keys are refused.
		const blogToken = await accessToken("blog");
		const other = await call("PATCH", `/v1/ingest-tokens/${record.id}`, {
			key: blogToken,
			body: { originAllowlist: null },
		});
		expect(other.status).toBe(404);
		const bad = { body: { originAllowlist: ["ftp://shop.example"] } };
		expect((await call("PATCH", `/v1/ingest-tokens/${record.id}`, bad)).status).toBe(400);
		expect((await call("PATCH", `/v1/ingest-tokens/${record.id}`, { body: {} })).status).toBe(400);
		await call("DELETE", `/v1/ingest-tokens/${record.id}`);
		const revoked = await call("PATCH", `/v1/ingest-tokens/${record.id}`, { body: { name: "x" } });
		expect(revoked.status).toBe(404);
	});

	it("allows any site to send (CORS), with no CORS on the management API", async () => {
		const preflight = await call("OPTIONS", "/v1/events", {
			key: null,
			headers: {
				origin: "https://shop.example",
				"access-control-request-method": "POST",
				"access-control-request-headers": "content-type,x-feedbakkr-tool-key",
			},
		});
		expect(preflight.headers.get("access-control-allow-origin")).toBe("https://shop.example");
		expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();

		const management = await call("GET", "/v1/groups", {
			headers: { origin: "https://shop.example" },
		});
		expect(management.headers.get("access-control-allow-origin")).toBeNull();
	});
});

describe("the daily cap", () => {
	it("refuses an app's events once it has sent its share for the day, without writing", async () => {
		const day = Math.floor(Date.now() / 86_400_000);
		await env.DB.prepare(
			"INSERT INTO daily_usage (project_id, day, events) VALUES ('shop', ?, 4999)",
		)
			.bind(day)
			.run();
		expect((await send(event())).status).toBe(202);
		const refused = await send(event());
		expect(refused.status).toBe(429);
		expect(refused.json.error.code).toBe("DAILY_LIMIT");
		expect((await send(event({ projectId: "blog" }))).status).toBe(202);
		const usage = await env.DB.prepare(
			"SELECT events FROM daily_usage WHERE project_id = 'shop'",
		).first<{
			events: number;
		}>();
		expect(usage?.events).toBe(5000);
	});
});
