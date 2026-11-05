import type { Context, MiddlewareHandler } from "hono";
import type { App } from "./env.js";
import { jsonError, nowSeconds } from "./http.js";
import { ACCESS_PREFIX, adminKeyOf, keyId, safeEqual, sha256Hex } from "./keys.js";

// Who is calling the management API, and what they may see:
//   - admin: the admin key. Every app.
//   - application: an access token (`wchm_`). One app; routes for anything
//     else answer 404, so a token can't tell whether other data exists.
//     Read tokens may only GET.

export type Scope =
	| { kind: "admin" }
	| { kind: "application"; applicationId: string; permission: "read" | "manage"; tokenId: string };

export type Scoped = App & { Variables: { scope: Scope } };

export const KEY_HEADER = "x-feedbakkr-tool-key";

const LAST_USED_INTERVAL_SECONDS = 60 * 60;

export function requireManagementKey(): MiddlewareHandler<Scoped> {
	return async (c, next) => {
		const admin = adminKeyOf(c.env);
		if (!admin) return notConfigured(c);
		// Server to server only: a request from a web page carries an Origin.
		if (c.req.header("origin")) {
			return jsonError(c, 403, "BROWSER_NOT_ALLOWED", "The management API is for servers only.");
		}
		const supplied = c.req.header(KEY_HEADER) ?? "";
		if (supplied.startsWith(ACCESS_PREFIX)) {
			const scope = await authenticateAccessToken(c, supplied);
			if (!scope) return jsonError(c, 401, "UNAUTHORIZED", "Invalid access token.");
			if (scope.permission === "read" && c.req.method !== "GET" && c.req.method !== "HEAD") {
				return jsonError(c, 403, "FORBIDDEN", "This access token is read-only.");
			}
			c.set("scope", scope);
			return next();
		}
		if (!(await safeEqual(supplied, admin))) {
			return jsonError(c, 401, "UNAUTHORIZED", "Invalid key.");
		}
		c.set("scope", { kind: "admin" });
		return next();
	};
}

/** Routes only the admin key may call: registering apps and managing access tokens. */
export function adminOnly(): MiddlewareHandler<Scoped> {
	return async (c, next) => {
		if (c.get("scope").kind !== "admin") {
			return jsonError(c, 403, "FORBIDDEN", "This needs the admin key.");
		}
		return next();
	};
}

/** The app an access token is limited to, or null for the admin key. */
export function scopedApp(c: Context<Scoped>): string | null {
	const scope = c.get("scope");
	return scope.kind === "application" ? scope.applicationId : null;
}

/** Whether the caller may see this app's data. */
export function canSee(c: Context<Scoped>, projectId: string): boolean {
	const app = scopedApp(c);
	return app === null || app === projectId;
}

export function notConfigured(c: Context) {
	return jsonError(
		c,
		503,
		"NOT_CONFIGURED",
		"Set FEEDBAKKR_WATCH_ADMIN_KEY on this worker: a wcha_ key of at least 32 characters.",
	);
}

async function authenticateAccessToken(
	c: Context<Scoped>,
	supplied: string,
): Promise<Extract<Scope, { kind: "application" }> | null> {
	const id = keyId(supplied, ACCESS_PREFIX);
	if (!id) return null;
	const row = await c.env.DB.prepare(
		"SELECT token_hash, application_id, permission, last_used_at FROM access_tokens WHERE id = ? AND revoked_at IS NULL",
	)
		.bind(id)
		.first<{
			token_hash: string;
			application_id: string;
			permission: "read" | "manage";
			last_used_at: number | null;
		}>();
	if (!row || !(await safeEqual(await sha256Hex(supplied), row.token_hash))) return null;

	const now = nowSeconds();
	if (!row.last_used_at || row.last_used_at < now - LAST_USED_INTERVAL_SECONDS) {
		c.executionCtx.waitUntil(
			c.env.DB.prepare("UPDATE access_tokens SET last_used_at = ? WHERE id = ?")
				.bind(now, id)
				.run(),
		);
	}
	return {
		kind: "application",
		applicationId: row.application_id,
		permission: row.permission,
		tokenId: id,
	};
}
