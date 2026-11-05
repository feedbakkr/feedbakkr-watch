import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import {
	createApplication,
	getApplication,
	getConnection,
	getSummary,
	listApplications,
	listComponents,
	updateApplication,
} from "./applications.js";
import { adminOnly, KEY_HEADER, requireManagementKey, type Scoped } from "./auth.js";
import { cleanUp } from "./cleanup.js";
import type { App, Env } from "./env.js";
import {
	addComment,
	bulkSetStatus,
	deleteGroup,
	getGroup,
	listComments,
	listGroups,
	listOccurrences,
	setStatus,
} from "./groups.js";
import { jsonError } from "./http.js";
import { handleIngest, MAX_EVENT_BODY_BYTES } from "./ingest.js";
import {
	createAccessToken,
	createIngestKey,
	listAccessTokens,
	listIngestKeys,
	revokeAccessToken,
	revokeIngestKey,
	revokeSelf,
	updateIngestKey,
} from "./tokens.js";
import { API_VERSION, VERSION } from "./version.js";

const MAX_MANAGEMENT_BODY_BYTES = 32 * 1024;

const app = new Hono<App>();

app.use("*", async (c, next) => {
	await next();
	c.header("x-content-type-options", "nosniff");
	c.header("cache-control", "no-store");
});

// Public: what this is, and whether it's up. No data.
app.get("/", (c) =>
	c.json({
		name: "FeedBakkr Watch",
		version: VERSION,
		manifest: "/.well-known/feedbakkr-tool.json",
	}),
);
app.get("/.well-known/feedbakkr-tool.json", (c) =>
	c.json({
		toolId: "feedbakkr-watch",
		name: "FeedBakkr Watch",
		version: VERSION,
		apiVersion: API_VERSION,
	}),
);
app.get("/health", async (c) => {
	const ok = await c.env.DB.prepare("SELECT 1 AS one")
		.first<{ one: number }>()
		.then((r) => r?.one === 1)
		.catch(() => false);
	return c.json({ ok, version: VERSION, checks: { db: ok ? "ok" : "down" } }, ok ? 200 : 503);
});

// Ingest is the only route browsers call. CORS lets any site send, because
// the key is the gate: an ingest key can be limited to exact origins, and the
// admin key is refused from browsers. No cookies, so no credentials.
app.use(
	"/v1/events",
	cors({
		origin: (origin) => origin || null,
		allowMethods: ["POST", "OPTIONS"],
		allowHeaders: ["content-type", KEY_HEADER, "x-feedbakkr-tool-source"],
		maxAge: 86_400,
	}),
);
app.post(
	"/v1/events",
	bodyLimit({
		maxSize: MAX_EVENT_BODY_BYTES,
		onError: (c) =>
			jsonError(
				c,
				413,
				"PAYLOAD_TOO_LARGE",
				`Events are limited to ${MAX_EVENT_BODY_BYTES} bytes.`,
			),
	}),
	handleIngest,
);

// The management API: the admin key or an app's access token. Server to
// server only, so no CORS.
const v1 = new Hono<Scoped>();
v1.use(
	"*",
	bodyLimit({
		maxSize: MAX_MANAGEMENT_BODY_BYTES,
		onError: (c) => jsonError(c, 413, "PAYLOAD_TOO_LARGE", "The body is too large."),
	}),
	requireManagementKey(),
);
v1.get("/connection", getConnection);
v1.delete("/connection", revokeSelf);
v1.get("/summary", getSummary);

v1.get("/applications", listApplications);
v1.post("/applications", adminOnly(), createApplication);
v1.get("/applications/:id", getApplication);
v1.patch("/applications/:id", updateApplication);
v1.get("/applications/:id/components", listComponents);

v1.get("/groups", listGroups);
// Before `/groups/:groupId`, so it isn't read as a group id.
v1.post("/groups/bulk-status", bulkSetStatus);
v1.get("/groups/:groupId", getGroup);
v1.delete("/groups/:groupId", deleteGroup);
v1.get("/groups/:groupId/occurrences", listOccurrences);
v1.post("/groups/:groupId/resolve", (c) => setStatus(c, "resolved"));
v1.post("/groups/:groupId/ignore", (c) => setStatus(c, "ignored"));
v1.post("/groups/:groupId/reopen", (c) => setStatus(c, "open"));
v1.get("/groups/:groupId/comments", listComments);
v1.post("/groups/:groupId/comments", addComment);

v1.get("/ingest-tokens", listIngestKeys);
v1.post("/ingest-tokens", createIngestKey);
v1.patch("/ingest-tokens/:id", updateIngestKey);
v1.delete("/ingest-tokens/:id", revokeIngestKey);

v1.get("/access-tokens", adminOnly(), listAccessTokens);
v1.post("/access-tokens", adminOnly(), createAccessToken);
v1.delete("/access-tokens/:id", adminOnly(), revokeAccessToken);

app.route("/v1", v1);

app.notFound((c) => jsonError(c, 404, "NOT_FOUND", "Route not found."));
app.onError((err, c) => {
	// The error only: never the request, which may hold error contents or keys.
	console.error(JSON.stringify({ event: "watch.error", message: err.message, path: c.req.path }));
	return jsonError(c, 500, "INTERNAL", "Internal server error.");
});

export default {
	fetch: app.fetch,
	scheduled: (_controller, env, ctx) => {
		ctx.waitUntil(cleanUp(env));
	},
} satisfies ExportedHandler<Env>;
