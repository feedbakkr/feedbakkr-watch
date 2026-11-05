import type { Context } from "hono";
import { canSee, type Scoped, scopedApp } from "./auth.js";
import { iso, jsonBody, jsonError, nowSeconds, parseJson, textField } from "./http.js";
import { ACCESS_PREFIX, INGEST_PREFIX, newId, newKey } from "./keys.js";

// Ingest keys (`wchi_`, write-only, one app, safe in browser code) and access
// tokens (`wchm_`, the management API for one app). Each key is shown once,
// when it's created; only its hash is stored. Revoking keeps the row, so you
// can see when a key was made and last used.

const NAME_MAX = 120;
const ALLOWLIST_MAX = 20;
const ORIGIN_MAX = 200;
const LIST_MAX = 200;

interface IngestKeyRow {
	id: string;
	key_prefix: string;
	project_id: string;
	name: string;
	origin_allowlist_json: string | null;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

interface AccessTokenRow {
	id: string;
	token_prefix: string;
	application_id: string;
	permission: "read" | "manage";
	name: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

function ingestKeyToApi(row: IngestKeyRow) {
	return {
		id: row.id,
		prefix: row.key_prefix,
		projectId: row.project_id,
		name: row.name,
		originAllowlist: (parseJson(row.origin_allowlist_json) as string[] | undefined) ?? null,
		createdAt: iso(row.created_at),
		lastUsedAt: iso(row.last_used_at),
		revokedAt: iso(row.revoked_at),
	};
}

function accessTokenToApi(row: AccessTokenRow) {
	return {
		id: row.id,
		prefix: row.token_prefix,
		applicationId: row.application_id,
		permission: row.permission,
		name: row.name,
		createdAt: iso(row.created_at),
		lastUsedAt: iso(row.last_used_at),
		revokedAt: iso(row.revoked_at),
	};
}

const INGEST_COLUMNS =
	"id, key_prefix, project_id, name, origin_allowlist_json, created_at, last_used_at, revoked_at";
const ACCESS_COLUMNS =
	"id, token_prefix, application_id, permission, name, created_at, last_used_at, revoked_at";

/** GET /ingest-tokens[?projectId=] (newest first, revoked ones included) */
export async function listIngestKeys(c: Context<Scoped>): Promise<Response> {
	const projectId = scopedApp(c) ?? c.req.query("projectId");
	const rows = await c.env.DB.prepare(
		`SELECT ${INGEST_COLUMNS} FROM ingest_keys${projectId ? " WHERE project_id = ?" : ""}
		ORDER BY created_at DESC LIMIT ${LIST_MAX}`,
	)
		.bind(...(projectId ? [projectId] : []))
		.all<IngestKeyRow>();
	return c.json({ data: rows.results.map(ingestKeyToApi) });
}

/** POST /ingest-tokens { projectId (admin key only), name, originAllowlist? } */
export async function createIngestKey(c: Context<Scoped>): Promise<Response> {
	const body = await jsonBody(c);
	const app = scopedApp(c);
	const projectId = app ?? (typeof body?.projectId === "string" ? body.projectId.trim() : "");
	if (!projectId) return jsonError(c, 400, "VALIDATION_ERROR", "projectId is required");
	if (!canSee(c, projectId)) return jsonError(c, 404, "NOT_FOUND", "Application not found.");
	const name = textField(body, "name", NAME_MAX, { required: true });
	if ("error" in name) return jsonError(c, 400, "VALIDATION_ERROR", name.error);
	const allowlist = originAllowlist(body?.originAllowlist);
	if ("error" in allowlist) return jsonError(c, 400, "VALIDATION_ERROR", allowlist.error);

	const id = newId("wit");
	const { key, hash, displayPrefix } = await newKey(INGEST_PREFIX, id);
	const row: IngestKeyRow = {
		id,
		key_prefix: displayPrefix,
		project_id: projectId,
		name: name.value as string,
		origin_allowlist_json: allowlist.value ? JSON.stringify(allowlist.value) : null,
		created_at: nowSeconds(),
		last_used_at: null,
		revoked_at: null,
	};
	await c.env.DB.prepare(
		`INSERT INTO ingest_keys (id, key_hash, key_prefix, project_id, name, origin_allowlist_json, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, hash, row.key_prefix, projectId, row.name, row.origin_allowlist_json, row.created_at)
		.run();
	return c.json({ token: key, record: ingestKeyToApi(row) }, 201);
}

/** DELETE /ingest-tokens/:id */
export async function revokeIngestKey(c: Context<Scoped>): Promise<Response> {
	const app = scopedApp(c);
	const row = await c.env.DB.prepare(
		`UPDATE ingest_keys SET revoked_at = COALESCE(revoked_at, ?)
		WHERE id = ?${app === null ? "" : " AND project_id = ?"} RETURNING id`,
	)
		.bind(nowSeconds(), c.req.param("id") ?? "", ...(app === null ? [] : [app]))
		.first();
	if (!row) return jsonError(c, 404, "NOT_FOUND", "Ingest key not found.");
	return c.json({ ok: true });
}

/**
 * PATCH /ingest-tokens/:id { name?, originAllowlist? }. The key itself stays
 * the same, so apps using it need no change. `originAllowlist: null` lets any
 * site use it. Revoked keys can't be edited.
 */
export async function updateIngestKey(c: Context<Scoped>): Promise<Response> {
	const body = await jsonBody(c);
	if (!body) return jsonError(c, 400, "VALIDATION_ERROR", "The body must be a JSON object.");
	const sets: string[] = [];
	const values: unknown[] = [];
	if ("name" in body) {
		const name = textField(body, "name", NAME_MAX, { required: true });
		if ("error" in name) return jsonError(c, 400, "VALIDATION_ERROR", name.error);
		sets.push("name = ?");
		values.push(name.value);
	}
	if ("originAllowlist" in body) {
		const allowlist = originAllowlist(body.originAllowlist);
		if ("error" in allowlist) return jsonError(c, 400, "VALIDATION_ERROR", allowlist.error);
		sets.push("origin_allowlist_json = ?");
		values.push(allowlist.value ? JSON.stringify(allowlist.value) : null);
	}
	if (sets.length === 0) {
		return jsonError(c, 400, "VALIDATION_ERROR", "Send name or originAllowlist to change.");
	}

	const app = scopedApp(c);
	const row = await c.env.DB.prepare(
		`UPDATE ingest_keys SET ${sets.join(", ")}
		WHERE id = ? AND revoked_at IS NULL${app === null ? "" : " AND project_id = ?"}
		RETURNING ${INGEST_COLUMNS}`,
	)
		.bind(...values, c.req.param("id") ?? "", ...(app === null ? [] : [app]))
		.first<IngestKeyRow>();
	if (!row) return jsonError(c, 404, "NOT_FOUND", "Ingest key not found, or revoked.");
	return c.json(ingestKeyToApi(row));
}

/** GET /access-tokens[?applicationId=] (admin key) */
export async function listAccessTokens(c: Context<Scoped>): Promise<Response> {
	const applicationId = c.req.query("applicationId");
	const rows = await c.env.DB.prepare(
		`SELECT ${ACCESS_COLUMNS} FROM access_tokens${applicationId ? " WHERE application_id = ?" : ""}
		ORDER BY created_at DESC LIMIT ${LIST_MAX}`,
	)
		.bind(...(applicationId ? [applicationId] : []))
		.all<AccessTokenRow>();
	return c.json({ data: rows.results.map(accessTokenToApi) });
}

/** POST /access-tokens { applicationId, name, permission: "read" | "manage" } (admin key) */
export async function createAccessToken(c: Context<Scoped>): Promise<Response> {
	const body = await jsonBody(c);
	const applicationId = typeof body?.applicationId === "string" ? body.applicationId.trim() : "";
	if (!applicationId) return jsonError(c, 400, "VALIDATION_ERROR", "applicationId is required");
	const name = textField(body, "name", NAME_MAX, { required: true });
	if ("error" in name) return jsonError(c, 400, "VALIDATION_ERROR", name.error);
	const permission = body?.permission;
	if (permission !== "read" && permission !== "manage") {
		return jsonError(c, 400, "VALIDATION_ERROR", "permission must be read or manage");
	}

	const id = newId("wat");
	const { key, hash, displayPrefix } = await newKey(ACCESS_PREFIX, id);
	const row: AccessTokenRow = {
		id,
		token_prefix: displayPrefix,
		application_id: applicationId,
		permission,
		name: name.value as string,
		created_at: nowSeconds(),
		last_used_at: null,
		revoked_at: null,
	};
	// Only for a registered app.
	const inserted = await c.env.DB.prepare(
		`INSERT INTO access_tokens (id, token_hash, token_prefix, application_id, permission, name, created_at)
		SELECT ?, ?, ?, id, ?, ?, ? FROM applications WHERE id = ?`,
	)
		.bind(id, hash, displayPrefix, permission, row.name, row.created_at, applicationId)
		.run();
	if (!inserted.meta.changes) {
		return jsonError(c, 404, "NOT_FOUND", "Application not found. Register it first.");
	}
	return c.json({ token: key, record: accessTokenToApi(row) }, 201);
}

/** DELETE /access-tokens/:id (admin key) */
export async function revokeAccessToken(c: Context<Scoped>): Promise<Response> {
	const row = await c.env.DB.prepare(
		"UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? RETURNING id",
	)
		.bind(nowSeconds(), c.req.param("id") ?? "")
		.first();
	if (!row) return jsonError(c, 404, "NOT_FOUND", "Access token not found.");
	return c.json({ ok: true });
}

/** DELETE /connection: an access token revokes itself, so FeedBakkr can disconnect. */
export async function revokeSelf(c: Context<Scoped>): Promise<Response> {
	const scope = c.get("scope");
	if (scope.kind !== "application") {
		return jsonError(c, 400, "VALIDATION_ERROR", "Only an access token can revoke itself.");
	}
	await c.env.DB.prepare(
		"UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
	)
		.bind(nowSeconds(), scope.tokenId)
		.run();
	return c.json({ ok: true });
}

/** Exact origins (scheme, host and port), lower-cased. No wildcards. */
function originAllowlist(input: unknown): { value: string[] | null } | { error: string } {
	if (input === undefined || input === null) return { value: null };
	if (!Array.isArray(input) || input.length > ALLOWLIST_MAX) {
		return { error: `originAllowlist must be a list of at most ${ALLOWLIST_MAX} origins` };
	}
	const out = new Set<string>();
	for (const raw of input) {
		if (typeof raw !== "string") return { error: "originAllowlist entries must be strings" };
		const value = raw.trim();
		if (!value) continue;
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return { error: `Not an origin: ${value.slice(0, ORIGIN_MAX)}` };
		}
		if ((url.protocol !== "https:" && url.protocol !== "http:") || value.length > ORIGIN_MAX) {
			return { error: `Not an http or https origin: ${value.slice(0, ORIGIN_MAX)}` };
		}
		out.add(url.origin.toLowerCase());
	}
	return { value: out.size ? [...out] : null };
}
