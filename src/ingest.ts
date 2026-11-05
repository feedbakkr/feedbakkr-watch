import {
	computeFingerprint,
	ERROR_SEVERITIES,
	type EventPayload,
	sanitise,
} from "@feedbakkr/watch-core";
import type { Context } from "hono";
import * as z from "zod/mini";
import { KEY_HEADER, notConfigured } from "./auth.js";
import type { App } from "./env.js";
import { jsonError, nowSeconds } from "./http.js";
import { adminKeyOf, INGEST_PREFIX, keyId, newId, safeEqual, sha256Hex } from "./keys.js";

// POST /v1/events: one error from an SDK. Validated, authenticated, then
// stored in one D1 batch (a transaction): the group is created or updated
// with a single upsert, and the occurrence is inserted against it.

// Browser SDKs send with `keepalive`, which caps bodies at 64 KB anyway.
export const MAX_EVENT_BODY_BYTES = 64 * 1024;
const MAX_STORED_MESSAGE_CHARS = 8 * 1024;
const MAX_STORED_STACK_CHARS = 32 * 1024;
const TITLE_CHARS = 160;
/** Events dated outside this window are stored as happening now. */
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_FUTURE_SECONDS = 5 * 60;
const LAST_USED_INTERVAL_SECONDS = 60 * 60;
/** Events per app per UTC day, unless WATCH_DAILY_EVENTS_PER_APP says otherwise. */
export const DEFAULT_DAILY_EVENTS = 5_000;

export const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// zod/mini: the same checks at a fraction of the bundle size.
const text = (max: number) => z.string().check(z.maxLength(max));
const required = (max: number) => z.string().check(z.minLength(1), z.maxLength(max));
const optional = (max: number) => z.optional(text(max));
const record = z.optional(z.record(z.string(), z.unknown()));
const list = (max: number) => z.optional(z.array(z.unknown()).check(z.maxLength(max)));

const eventSchema = z.object({
	projectId: z.string().check(z.regex(PROJECT_ID)),
	source: required(64),
	severity: z.enum(ERROR_SEVERITIES),
	environment: required(64),
	timestamp: text(64),
	message: z.string(),
	errorName: optional(200),
	stack: z.optional(z.string()),
	fingerprint: optional(128),
	appVersion: optional(64),
	// Sent by older SDKs; not stored.
	tenantId: optional(120),
	projectName: optional(120),
	breadcrumbs: list(100),
	tags: record,
	context: record,
	request: z.optional(
		z.object({
			route: optional(1024),
			method: optional(16),
			statusCode: z.optional(z.int().check(z.gte(100), z.lte(599))),
			requestId: optional(128),
		}),
	),
	runtime: z.optional(
		z.object({
			browser: optional(128),
			browserVersion: optional(64),
			os: optional(128),
			osVersion: optional(64),
			runtime: optional(128),
			runtimeVersion: optional(64),
			userAgent: optional(512),
		}),
	),
	user: z.optional(z.object({ idHash: optional(128), sessionId: optional(128) })),
	webContext: record,
	lastAction: record,
	fetchHistory: list(20),
	causes: list(10),
	groupByUrl: z.optional(z.boolean()),
});

export async function handleIngest(c: Context<App>): Promise<Response> {
	const admin = adminKeyOf(c.env);
	if (!admin) return notConfigured(c);
	const supplied = c.req.header(KEY_HEADER) ?? "";
	if (!supplied) return jsonError(c, 401, "UNAUTHORIZED", "Missing key.");

	const json: unknown = await c.req.json().catch(() => undefined);
	if (json === undefined) return jsonError(c, 400, "INVALID_JSON", "Body is not valid JSON.");
	const parsed = eventSchema.safeParse(json);
	if (!parsed.success) {
		return jsonError(c, 400, "VALIDATION_ERROR", "Invalid event.", z.flattenError(parsed.error));
	}
	const event = parsed.data;

	const auth = await authenticate(c, supplied, admin, event.projectId);
	if (auth) return auth;

	// A daily cap per app keeps a noisy (or abused) app inside the free plan's
	// daily writes. Over it, events are refused without writing anything.
	const day = Math.floor(Date.now() / 86_400_000);
	const used = await c.env.DB.prepare(
		"SELECT events FROM daily_usage WHERE project_id = ? AND day = ?",
	)
		.bind(event.projectId, day)
		.first<{ events: number }>();
	if ((used?.events ?? 0) >= dailyLimit(c.env)) {
		return jsonError(c, 429, "DAILY_LIMIT", "This app has sent its events for today.");
	}

	const fingerprint = await computeFingerprint(event as EventPayload);
	const now = nowSeconds();
	const occurredAt = occurredAtOf(event.timestamp, now);
	const groupId = newId("egp");
	const occurrenceId = newId("eoc");
	const userId = event.user?.idHash || null;
	const sessionId = event.user?.sessionId || null;
	const route = event.request?.route || null;

	const context: Record<string, unknown> = { ...event.context };
	if (event.webContext) context.webContext = event.webContext;
	if (event.lastAction) context.lastAction = event.lastAction;
	if (event.fetchHistory) context.fetchHistory = event.fetchHistory;
	if (event.causes) context.causes = event.causes;
	const stored = (value: unknown) => (value === undefined ? null : JSON.stringify(sanitise(value)));

	const db = c.env.DB;
	const [, group] = await db.batch<{ id: string; occurrence_count: number }>([
		db
			.prepare(
				`INSERT INTO daily_usage (project_id, day, events) VALUES (?, ?, 1)
				ON CONFLICT (project_id, day) DO UPDATE SET events = events + 1`,
			)
			.bind(event.projectId, day),
		// A repeat counts a user or session only the first time this group sees
		// it. A resolved group that happens again reopens.
		db
			.prepare(
				`INSERT INTO error_groups (
					id, project_id, environment, fingerprint, source, severity, title,
					first_seen_at, last_seen_at, affected_users_count, affected_sessions_count,
					representative_route, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (project_id, environment, fingerprint) DO UPDATE SET
					occurrence_count = occurrence_count + 1,
					affected_users_count = affected_users_count + (? IS NOT NULL AND NOT EXISTS (
						SELECT 1 FROM error_occurrences o WHERE o.group_id = error_groups.id AND o.user_id_hash = ?)),
					affected_sessions_count = affected_sessions_count + (? IS NOT NULL AND NOT EXISTS (
						SELECT 1 FROM error_occurrences o WHERE o.group_id = error_groups.id AND o.session_id = ?)),
					first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
					last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
					severity = excluded.severity,
					status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
					representative_route = COALESCE(excluded.representative_route, representative_route),
					updated_at = excluded.updated_at
				RETURNING id, occurrence_count`,
			)
			.bind(
				groupId,
				event.projectId,
				event.environment,
				fingerprint,
				event.source,
				event.severity,
				titleOf(event),
				occurredAt,
				occurredAt,
				userId ? 1 : 0,
				sessionId ? 1 : 0,
				route,
				now,
				now,
				userId,
				userId,
				sessionId,
				sessionId,
			),
		db
			.prepare(
				`INSERT INTO error_occurrences (
					id, group_id, project_id, occurred_at, source, severity, environment,
					request_id, session_id, user_id_hash, route, method, status_code,
					browser, os, runtime, app_version, error_name, message, stack,
					breadcrumbs_json, tags_json, context_json, created_at
				)
				SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				FROM error_groups WHERE project_id = ? AND environment = ? AND fingerprint = ?`,
			)
			.bind(
				occurrenceId,
				event.projectId,
				occurredAt,
				event.source,
				event.severity,
				event.environment,
				event.request?.requestId ?? null,
				sessionId,
				userId,
				route,
				event.request?.method ?? null,
				event.request?.statusCode ?? null,
				event.runtime?.browser ?? null,
				event.runtime?.os ?? null,
				event.runtime?.runtime ?? null,
				event.appVersion ?? null,
				event.errorName ?? null,
				event.message.slice(0, MAX_STORED_MESSAGE_CHARS),
				event.stack?.slice(0, MAX_STORED_STACK_CHARS) ?? null,
				stored(event.breadcrumbs),
				stored(event.tags),
				Object.keys(context).length > 0 ? stored(context) : null,
				now,
				event.projectId,
				event.environment,
				fingerprint,
			),
	]);
	const row = group?.results[0];
	if (!row) throw new Error("ingest: the group upsert returned no row");

	return c.json(
		{
			ok: true,
			groupId: row.id,
			occurrenceId,
			fingerprint,
			isNewGroup: row.occurrence_count === 1,
		},
		202,
	);
}

/**
 * Admin key (server-side senders only) or an ingest key for this app. Returns
 * the error response, or null when the caller may send.
 */
async function authenticate(
	c: Context<App>,
	supplied: string,
	admin: string,
	projectId: string,
): Promise<Response | null> {
	if (await safeEqual(supplied, admin)) {
		// A browser request carries an Origin. The admin key must never be in a page.
		if (c.req.header("origin")) {
			return jsonError(c, 403, "ADMIN_KEY_IN_BROWSER", "Use an ingest key in browser code.");
		}
		return null;
	}

	const id = keyId(supplied, INGEST_PREFIX);
	if (!id) return jsonError(c, 401, "UNAUTHORIZED", "Invalid key.");

	// Before the lookup. The per-IP limit holds even for made-up key ids.
	if (!(await withinRateLimit(c, id))) {
		return jsonError(c, 429, "RATE_LIMITED", "Too many events for this key. Slow down.");
	}

	const key = await c.env.DB.prepare(
		"SELECT key_hash, project_id, origin_allowlist_json, last_used_at FROM ingest_keys WHERE id = ? AND revoked_at IS NULL",
	)
		.bind(id)
		.first<{
			key_hash: string;
			project_id: string;
			origin_allowlist_json: string | null;
			last_used_at: number | null;
		}>();
	if (!key || !(await safeEqual(await sha256Hex(supplied), key.key_hash))) {
		return jsonError(c, 401, "UNAUTHORIZED", "Invalid ingest key.");
	}
	if (key.project_id !== projectId) {
		return jsonError(c, 403, "PROJECT_MISMATCH", "This ingest key is for a different app.");
	}
	if (key.origin_allowlist_json) {
		const allowed = JSON.parse(key.origin_allowlist_json) as string[];
		const origin = (c.req.header("origin") ?? originOf(c.req.header("referer"))).toLowerCase();
		if (!origin || !allowed.includes(origin)) {
			return jsonError(c, 403, "ORIGIN_NOT_ALLOWED", "This site isn't allowed to use this key.");
		}
	}

	const now = nowSeconds();
	if (!key.last_used_at || key.last_used_at < now - LAST_USED_INTERVAL_SECONDS) {
		c.executionCtx.waitUntil(
			c.env.DB.prepare("UPDATE ingest_keys SET last_used_at = ? WHERE id = ?").bind(now, id).run(),
		);
	}
	return null;
}

/**
 * Per IP across all keys, and per key across all IPs. Both must pass. The
 * key id isn't verified yet, so the per-IP limit is the one a made-up id
 * can't escape.
 */
async function withinRateLimit(c: Context<App>, keyId: string): Promise<boolean> {
	const perIp = c.env.INGEST_LIMITER;
	if (!perIp) return true;
	const perKey = c.env.INGEST_KEY_LIMITER ?? perIp;
	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	const [a, b] = await Promise.all([
		perIp.limit({ key: `ip:${ip}` }),
		perKey.limit({ key: `key:${keyId}` }),
	]);
	return a.success && b.success;
}

function dailyLimit(env: App["Bindings"]): number {
	const n = Number(env.WATCH_DAILY_EVENTS_PER_APP);
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_EVENTS;
}

function titleOf(event: { errorName?: string; message: string }): string {
	return `${event.errorName || "Error"}: ${event.message.trim().slice(0, TITLE_CHARS)}`;
}

function occurredAtOf(timestamp: string, now: number): number {
	const t = Math.floor(Date.parse(timestamp) / 1000);
	return Number.isFinite(t) && t >= now - MAX_AGE_SECONDS && t <= now + MAX_FUTURE_SECONDS
		? t
		: now;
}

/** `Referer` is a full URL; allowlists hold origins. */
function originOf(referer: string | undefined): string {
	if (!referer) return "";
	try {
		return new URL(referer).origin;
	} catch {
		return "";
	}
}
