import type { Context } from "hono";
import { canSee, type Scoped, scopedApp } from "./auth.js";
import { iso, jsonBody, jsonError, nowSeconds, pagination, paging, parseJson } from "./http.js";
import { newId } from "./keys.js";

// Error groups, their occurrences and comments. An access token sees only its
// own app: every query below is limited to it, and anything else is a 404.

const STATUSES = ["open", "resolved", "ignored"] as const;
type Status = (typeof STATUSES)[number];

const BULK_MAX = 200;
const COMMENT_MAX = 500;
/** Comments per group; listing returns them all. */
const COMMENTS_PER_GROUP = 200;
/** Occurrence totals are counted up to this, so a busy group's pages stay cheap. */
export const OCCURRENCE_TOTAL_CAP = 1_000;
const AUTHOR_MAX = 120;

interface GroupRow {
	id: string;
	project_id: string;
	environment: string;
	fingerprint: string;
	source: string;
	severity: string;
	title: string;
	status: Status;
	first_seen_at: number;
	last_seen_at: number;
	occurrence_count: number;
	affected_users_count: number;
	affected_sessions_count: number;
	representative_route: string | null;
	comment_count: number;
}

interface OccurrenceRow {
	id: string;
	group_id: string;
	project_id: string;
	occurred_at: number;
	source: string;
	severity: string;
	environment: string;
	request_id: string | null;
	session_id: string | null;
	user_id_hash: string | null;
	route: string | null;
	method: string | null;
	status_code: number | null;
	browser: string | null;
	os: string | null;
	runtime: string | null;
	app_version: string | null;
	error_name: string | null;
	message: string;
	stack: string | null;
	breadcrumbs_json: string | null;
	tags_json: string | null;
	context_json: string | null;
}

interface CommentRow {
	id: string;
	group_id: string;
	author_name: string;
	message: string;
	created_at: number;
}

function groupToApi(row: GroupRow) {
	return {
		id: row.id,
		projectId: row.project_id,
		environment: row.environment,
		fingerprint: row.fingerprint,
		source: row.source,
		severity: row.severity,
		title: row.title,
		status: row.status,
		firstSeenAt: iso(row.first_seen_at),
		lastSeenAt: iso(row.last_seen_at),
		occurrenceCount: row.occurrence_count,
		affectedUsersCount: row.affected_users_count,
		affectedSessionsCount: row.affected_sessions_count,
		representativeRoute: row.representative_route,
		commentCount: row.comment_count,
	};
}

function occurrenceToApi(row: OccurrenceRow) {
	return {
		id: row.id,
		groupId: row.group_id,
		projectId: row.project_id,
		occurredAt: iso(row.occurred_at),
		source: row.source,
		severity: row.severity,
		environment: row.environment,
		requestId: row.request_id ?? undefined,
		sessionId: row.session_id ?? undefined,
		userIdHash: row.user_id_hash ?? undefined,
		route: row.route ?? undefined,
		method: row.method ?? undefined,
		statusCode: row.status_code ?? undefined,
		browser: row.browser ?? undefined,
		os: row.os ?? undefined,
		runtime: row.runtime ?? undefined,
		appVersion: row.app_version ?? undefined,
		errorName: row.error_name ?? undefined,
		message: row.message,
		stack: row.stack ?? undefined,
		breadcrumbs: parseJson(row.breadcrumbs_json),
		tags: parseJson(row.tags_json),
		context: parseJson(row.context_json),
	};
}

function commentToApi(row: CommentRow) {
	return {
		id: row.id,
		groupId: row.group_id,
		authorName: row.author_name,
		message: row.message,
		createdAt: iso(row.created_at),
	};
}

/** ` AND project_id = ?` and its value for an access token; nothing for the admin key. */
function scopeFilter(c: Context<Scoped>): [string, string[]] {
	const app = scopedApp(c);
	return app === null ? ["", []] : [" AND project_id = ?", [app]];
}

/**
 * GET /groups?projectId=&status=&environment=&source=&severity=&q=&page=&pageSize=
 * Newest first. Access tokens always get their own app.
 */
export async function listGroups(c: Context<Scoped>): Promise<Response> {
	const wheres: string[] = [];
	const binds: unknown[] = [];
	const add = (sql: string, value: unknown) => {
		wheres.push(sql);
		binds.push(value);
	};
	const projectId = scopedApp(c) ?? c.req.query("projectId");
	if (projectId) add("project_id = ?", projectId);
	const status = c.req.query("status");
	if (status) {
		if (!isStatus(status)) {
			return jsonError(c, 400, "VALIDATION_ERROR", "status must be open, resolved or ignored");
		}
		add("status = ?", status);
	}
	for (const key of ["environment", "source", "severity"] as const) {
		const value = c.req.query(key);
		if (value) add(`${key} = ?`, value);
	}
	const q = c.req.query("q")?.trim().slice(0, 200);
	if (q) add("title LIKE ? ESCAPE '\\'", `%${q.replace(/[\\%_]/g, "\\$&")}%`);

	const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
	const { page, pageSize, offset } = paging(c, 25);
	const db = c.env.DB;
	const [rows, count] = await db.batch([
		db
			.prepare(`SELECT * FROM error_groups ${where} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`)
			.bind(...binds, pageSize, offset),
		db.prepare(`SELECT COUNT(*) AS n FROM error_groups ${where}`).bind(...binds),
	]);
	const total = ((count?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
	return c.json({
		data: ((rows?.results ?? []) as GroupRow[]).map(groupToApi),
		pagination: pagination(page, pageSize, total),
	});
}

/** GET /groups/:groupId */
export async function getGroup(c: Context<Scoped>): Promise<Response> {
	const row = await c.env.DB.prepare("SELECT * FROM error_groups WHERE id = ?")
		.bind(c.req.param("groupId") ?? "")
		.first<GroupRow>();
	if (!row || !canSee(c, row.project_id)) return notFound(c);
	return c.json(groupToApi(row));
}

/**
 * GET /groups/:groupId/occurrences?page=&pageSize= (newest first). `total`
 * counts up to OCCURRENCE_TOTAL_CAP; the group's occurrenceCount is the full
 * number.
 */
export async function listOccurrences(c: Context<Scoped>): Promise<Response> {
	const groupId = c.req.param("groupId") ?? "";
	const { page, pageSize, offset } = paging(c, 25);
	const db = c.env.DB;
	const [group, rows, count] = await db.batch([
		db.prepare("SELECT project_id FROM error_groups WHERE id = ?").bind(groupId),
		db
			.prepare(
				"SELECT * FROM error_occurrences WHERE group_id = ? ORDER BY occurred_at DESC LIMIT ? OFFSET ?",
			)
			.bind(groupId, pageSize, offset),
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM (SELECT 1 FROM error_occurrences WHERE group_id = ? LIMIT ?)",
			)
			.bind(groupId, OCCURRENCE_TOTAL_CAP),
	]);
	const owner = ((group?.results ?? [])[0] as { project_id: string } | undefined)?.project_id;
	if (owner === undefined || !canSee(c, owner)) return notFound(c);
	const total = ((count?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
	return c.json({
		data: ((rows?.results ?? []) as OccurrenceRow[]).map(occurrenceToApi),
		pagination: pagination(page, pageSize, total),
	});
}

/** POST /groups/:groupId/resolve | ignore | reopen */
export async function setStatus(c: Context<Scoped>, status: Status): Promise<Response> {
	const [scope, scopeBinds] = scopeFilter(c);
	const row = await c.env.DB.prepare(
		`UPDATE error_groups
		SET updated_at = CASE WHEN status = ? THEN updated_at ELSE ? END, status = ?
		WHERE id = ?${scope} RETURNING *`,
	)
		.bind(status, nowSeconds(), status, c.req.param("groupId") ?? "", ...scopeBinds)
		.first<GroupRow>();
	if (!row) return notFound(c);
	return c.json(groupToApi(row));
}

/** POST /groups/bulk-status { ids, status } */
export async function bulkSetStatus(c: Context<Scoped>): Promise<Response> {
	const body = await jsonBody(c);
	const ids = Array.isArray(body?.ids)
		? [...new Set(body.ids.filter((x): x is string => typeof x === "string"))]
		: [];
	const status = body?.status;
	if (ids.length === 0 || ids.length > BULK_MAX) {
		return jsonError(c, 400, "VALIDATION_ERROR", `ids must be a list of 1-${BULK_MAX} group ids`);
	}
	if (typeof status !== "string" || !isStatus(status)) {
		return jsonError(c, 400, "VALIDATION_ERROR", "status must be open, resolved or ignored");
	}
	// json_each keeps it to one bound parameter, whatever the number of ids.
	// `+project_id` stops SQLite using the project index, so it looks up each
	// id by primary key instead of scanning the whole app.
	const app = scopedApp(c);
	const scopeBinds = app === null ? [] : [app];
	const match = `id IN (SELECT value FROM json_each(?))${app === null ? "" : " AND +project_id = ?"}`;
	const db = c.env.DB;
	const [found, changed] = await db.batch([
		db
			.prepare(`SELECT COUNT(*) AS n FROM error_groups WHERE ${match}`)
			.bind(JSON.stringify(ids), ...scopeBinds),
		db
			.prepare(`UPDATE error_groups SET status = ?, updated_at = ? WHERE ${match} AND status != ?`)
			.bind(status, nowSeconds(), JSON.stringify(ids), ...scopeBinds, status),
	]);
	const n = ((found?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
	return c.json({
		ok: true,
		requested: ids.length,
		updated: changed?.meta.changes ?? 0,
		notFound: ids.length - n,
	});
}

/** DELETE /groups/:groupId, with its occurrences and comments. */
export async function deleteGroup(c: Context<Scoped>): Promise<Response> {
	const [scope, scopeBinds] = scopeFilter(c);
	const result = await c.env.DB.prepare(`DELETE FROM error_groups WHERE id = ?${scope}`)
		.bind(c.req.param("groupId") ?? "", ...scopeBinds)
		.run();
	if (!result.meta.changes) return notFound(c);
	return c.json({ ok: true });
}

/** GET /groups/:groupId/comments (newest first) */
export async function listComments(c: Context<Scoped>): Promise<Response> {
	const groupId = c.req.param("groupId") ?? "";
	const db = c.env.DB;
	const [group, rows] = await db.batch([
		db.prepare("SELECT project_id FROM error_groups WHERE id = ?").bind(groupId),
		db
			.prepare(
				"SELECT * FROM error_group_comments WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
			)
			.bind(groupId, COMMENTS_PER_GROUP),
	]);
	const owner = ((group?.results ?? [])[0] as { project_id: string } | undefined)?.project_id;
	if (owner === undefined || !canSee(c, owner)) return notFound(c);
	return c.json({ data: ((rows?.results ?? []) as CommentRow[]).map(commentToApi) });
}

/** POST /groups/:groupId/comments { authorName, message } */
export async function addComment(c: Context<Scoped>): Promise<Response> {
	const body = await jsonBody(c);
	const authorName = typeof body?.authorName === "string" ? body.authorName.trim() : "";
	const message = typeof body?.message === "string" ? body.message.trim() : "";
	if (!authorName || authorName.length > AUTHOR_MAX) {
		return jsonError(c, 400, "VALIDATION_ERROR", `authorName must be 1-${AUTHOR_MAX} characters`);
	}
	if (!message || message.length > COMMENT_MAX) {
		return jsonError(c, 400, "VALIDATION_ERROR", `message must be 1-${COMMENT_MAX} characters`);
	}

	const groupId = c.req.param("groupId") ?? "";
	const [scope, scopeBinds] = scopeFilter(c);
	const id = newId("ecm");
	const now = nowSeconds();
	const db = c.env.DB;
	// Both statements match nothing when the group isn't visible or is full.
	const [inserted] = await db.batch([
		db
			.prepare(
				`INSERT INTO error_group_comments (id, group_id, author_name, message, created_at)
				SELECT ?, id, ?, ?, ? FROM error_groups WHERE id = ? AND comment_count < ?${scope}`,
			)
			.bind(id, authorName, message, now, groupId, COMMENTS_PER_GROUP, ...scopeBinds),
		db
			.prepare(
				`UPDATE error_groups SET comment_count = comment_count + 1, updated_at = ?
				WHERE id = ? AND comment_count < ?${scope}`,
			)
			.bind(now, groupId, COMMENTS_PER_GROUP, ...scopeBinds),
	]);
	if (!inserted?.meta.changes) {
		const group = await db
			.prepare(`SELECT 1 FROM error_groups WHERE id = ?${scope}`)
			.bind(groupId, ...scopeBinds)
			.first();
		if (!group) return notFound(c);
		return jsonError(
			c,
			409,
			"TOO_MANY_COMMENTS",
			`A group can have ${COMMENTS_PER_GROUP} comments.`,
		);
	}
	return c.json(
		commentToApi({ id, group_id: groupId, author_name: authorName, message, created_at: now }),
		201,
	);
}

function isStatus(value: string): value is Status {
	return (STATUSES as readonly string[]).includes(value);
}

function notFound(c: Context) {
	return jsonError(c, 404, "NOT_FOUND", "Group not found.");
}
