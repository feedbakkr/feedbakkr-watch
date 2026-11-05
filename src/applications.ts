import type { Context } from "hono";
import { canSee, type Scoped, scopedApp } from "./auth.js";
import { iso, jsonBody, jsonError, nowSeconds, parseJson, textField } from "./http.js";
import { PROJECT_ID } from "./ingest.js";
import { API_VERSION, VERSION } from "./version.js";

// Apps, their summaries and components, and /connection. An app's id is the
// `projectId` its SDKs send. Errors can arrive before an app is registered;
// those apps are listed as `unregistered` so nothing is hidden.

const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;
const COMPONENTS_MAX = 50;
const SOURCE_MAX = 64;
const DAY_SECONDS = 24 * 60 * 60;

interface ApplicationRow {
	id: string;
	name: string;
	description: string | null;
	components_json: string | null;
	created_at: number;
	updated_at: number;
	archived_at: number | null;
}

type Component = { source: string; displayName?: string };

type Summary = {
	openIssues: number;
	newIssues24h: number;
	lastErrorAt: string | null;
	environments: string[];
};

const EMPTY_SUMMARY: Summary = {
	openIssues: 0,
	newIssues24h: 0,
	lastErrorAt: null,
	environments: [],
};

function components(row: Pick<ApplicationRow, "components_json">): Component[] {
	const value = parseJson(row.components_json);
	return Array.isArray(value) ? (value as Component[]) : [];
}

function toApi(row: ApplicationRow, summary: Summary = EMPTY_SUMMARY) {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		components: components(row),
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
		archivedAt: iso(row.archived_at),
		summary,
	};
}

/** Summaries from the groups table: one indexed scan per app. */
function summariesQuery(db: D1Database, projectId?: string) {
	return db
		.prepare(
			`SELECT project_id,
				SUM(status = 'open') AS open_issues,
				SUM(status = 'open' AND first_seen_at >= ?) AS new_issues,
				MAX(last_seen_at) AS last_error_at,
				GROUP_CONCAT(DISTINCT environment) AS environments
			FROM error_groups${projectId ? " WHERE project_id = ?" : ""}
			GROUP BY project_id`,
		)
		.bind(...[nowSeconds() - DAY_SECONDS, ...(projectId ? [projectId] : [])]);
}

type SummaryRow = {
	project_id: string;
	open_issues: number | null;
	new_issues: number | null;
	last_error_at: number | null;
	environments: string | null;
};

function toSummary(r: SummaryRow | undefined): Summary {
	if (!r) return EMPTY_SUMMARY;
	return {
		openIssues: r.open_issues ?? 0,
		newIssues24h: r.new_issues ?? 0,
		lastErrorAt: iso(r.last_error_at),
		environments: (r.environments ?? "").split(",").filter(Boolean).sort(),
	};
}

async function summaryOf(db: D1Database, id: string): Promise<Summary> {
	return toSummary((await summariesQuery(db, id).first<SummaryRow>()) ?? undefined);
}

/** GET /applications[?includeArchived=1] */
export async function listApplications(c: Context<Scoped>): Promise<Response> {
	const db = c.env.DB;
	// An access token only needs its own app's summary.
	const app = scopedApp(c) ?? undefined;
	const [apps, summaries] = await db.batch([
		db.prepare("SELECT * FROM applications ORDER BY name COLLATE NOCASE"),
		summariesQuery(db, app),
	]);
	const byProject = new Map(
		((summaries?.results ?? []) as SummaryRow[]).map((r) => [r.project_id, r]),
	);
	const rows = (apps?.results ?? []) as ApplicationRow[];
	const registered = new Set(rows.map((r) => r.id));
	const includeArchived = c.req.query("includeArchived") === "1";

	return c.json({
		data: rows
			.filter((r) => canSee(c, r.id) && (includeArchived || r.archived_at === null))
			.map((r) => toApi(r, toSummary(byProject.get(r.id)))),
		unregistered: [...byProject.values()]
			.filter((r) => !registered.has(r.project_id) && canSee(c, r.project_id))
			.map((r) => ({ projectId: r.project_id, summary: toSummary(r) })),
	});
}

/** GET /applications/:id */
export async function getApplication(c: Context<Scoped>): Promise<Response> {
	const id = c.req.param("id") ?? "";
	const row = canSee(c, id) ? await findApplication(c.env.DB, id) : null;
	if (!row) return jsonError(c, 404, "NOT_FOUND", "Application not found.");
	return c.json(toApi(row, await summaryOf(c.env.DB, id)));
}

/** POST /applications { id, name, description?, components? } (admin key) */
export async function createApplication(c: Context<Scoped>): Promise<Response> {
	const body = await jsonBody(c);
	const id = typeof body?.id === "string" ? body.id.trim() : "";
	if (!PROJECT_ID.test(id)) {
		return jsonError(
			c,
			400,
			"VALIDATION_ERROR",
			"id must be 1-100 letters, digits, '.', '_' or '-', starting with a letter or digit",
		);
	}
	const name = textField(body, "name", NAME_MAX, { required: true });
	const description = textField(body, "description", DESCRIPTION_MAX);
	const declared = validateComponents(body?.components);
	for (const field of [name, description, declared]) {
		if ("error" in field) return jsonError(c, 400, "VALIDATION_ERROR", field.error);
	}

	const now = nowSeconds();
	const row: ApplicationRow = {
		id,
		name: (name as { value: string }).value,
		description: (description as { value: string | null }).value,
		components_json: componentsJson(declared),
		created_at: now,
		updated_at: now,
		archived_at: null,
	};
	const inserted = await c.env.DB.prepare(
		`INSERT INTO applications (id, name, description, components_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
	)
		.bind(row.id, row.name, row.description, row.components_json, now, now)
		.run();
	if (!inserted.meta.changes) {
		return jsonError(c, 409, "CONFLICT", "An application with this id already exists.");
	}
	return c.json(toApi(row, await summaryOf(c.env.DB, id)), 201);
}

/** PATCH /applications/:id { name?, description?, components?, archived? } */
export async function updateApplication(c: Context<Scoped>): Promise<Response> {
	const id = c.req.param("id") ?? "";
	const row = canSee(c, id) ? await findApplication(c.env.DB, id) : null;
	if (!row) return jsonError(c, 404, "NOT_FOUND", "Application not found.");
	const body = await jsonBody(c);
	if (!body) return jsonError(c, 400, "VALIDATION_ERROR", "The body must be a JSON object.");

	if ("name" in body) {
		const name = textField(body, "name", NAME_MAX, { required: true });
		if ("error" in name) return jsonError(c, 400, "VALIDATION_ERROR", name.error);
		row.name = name.value as string;
	}
	if ("description" in body) {
		const description = textField(body, "description", DESCRIPTION_MAX);
		if ("error" in description) return jsonError(c, 400, "VALIDATION_ERROR", description.error);
		row.description = description.value;
	}
	if ("components" in body) {
		const declared = validateComponents(body.components);
		if ("error" in declared) return jsonError(c, 400, "VALIDATION_ERROR", declared.error);
		row.components_json = componentsJson(declared);
	}
	if ("archived" in body) {
		if (typeof body.archived !== "boolean") {
			return jsonError(c, 400, "VALIDATION_ERROR", "archived must be true or false");
		}
		row.archived_at = body.archived ? (row.archived_at ?? nowSeconds()) : null;
	}
	row.updated_at = nowSeconds();

	await c.env.DB.prepare(
		`UPDATE applications SET name = ?, description = ?, components_json = ?, updated_at = ?, archived_at = ?
		WHERE id = ?`,
	)
		.bind(row.name, row.description, row.components_json, row.updated_at, row.archived_at, id)
		.run();
	return c.json(toApi(row, await summaryOf(c.env.DB, id)));
}

/**
 * GET /applications/:id/components[?environment=]
 *
 * Each `source` seen in the app's errors, with counts, merged with the
 * declared components; and the environments seen.
 */
export async function listComponents(c: Context<Scoped>): Promise<Response> {
	const id = c.req.param("id") ?? "";
	if (!canSee(c, id)) return jsonError(c, 404, "NOT_FOUND", "Application not found.");
	const environment = c.req.query("environment");
	const db = c.env.DB;

	const [sources, environments, app] = await db.batch([
		db
			.prepare(
				`SELECT source, SUM(status = 'open') AS open_issues, COUNT(*) AS total_groups,
					MAX(last_seen_at) AS last_seen_at
				FROM error_groups WHERE project_id = ?${environment ? " AND environment = ?" : ""}
				GROUP BY source`,
			)
			.bind(...[id, ...(environment ? [environment] : [])]),
		db
			.prepare(
				"SELECT DISTINCT environment FROM error_groups WHERE project_id = ? ORDER BY environment",
			)
			.bind(id),
		db.prepare("SELECT components_json FROM applications WHERE id = ?").bind(id),
	]);

	const declared = components(
		((app?.results ?? [])[0] as { components_json: string | null } | undefined) ?? {
			components_json: null,
		},
	);
	const names = new Map(declared.map((d) => [d.source, d.displayName ?? null]));
	const data = (
		(sources?.results ?? []) as {
			source: string;
			open_issues: number;
			total_groups: number;
			last_seen_at: number;
		}[]
	).map((r) => ({
		source: r.source,
		displayName: names.get(r.source) ?? null,
		openIssues: r.open_issues ?? 0,
		totalGroups: r.total_groups,
		lastSeenAt: iso(r.last_seen_at),
		declared: names.has(r.source),
	}));
	const seen = new Set(data.map((d) => d.source));
	for (const d of declared) {
		if (seen.has(d.source)) continue;
		data.push({
			source: d.source,
			displayName: d.displayName ?? null,
			openIssues: 0,
			totalGroups: 0,
			lastSeenAt: null,
			declared: true,
		});
	}
	data.sort((a, b) => b.openIssues - a.openIssues || a.source.localeCompare(b.source));

	return c.json({
		data,
		environments: ((environments?.results ?? []) as { environment: string }[]).map(
			(r) => r.environment,
		),
	});
}

/** GET /summary[?applicationId=]: the numbers a dashboard shows for one app. */
export async function getSummary(c: Context<Scoped>): Promise<Response> {
	const id = scopedApp(c) ?? c.req.query("applicationId") ?? "";
	if (!id) return jsonError(c, 400, "VALIDATION_ERROR", "applicationId is required");
	const db = c.env.DB;
	const [summary, occurrences] = await db.batch([
		summariesQuery(db, id),
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM error_occurrences WHERE project_id = ? AND occurred_at >= ?",
			)
			.bind(id, nowSeconds() - DAY_SECONDS),
	]);
	return c.json({
		applicationId: id,
		...toSummary((summary?.results ?? [])[0] as SummaryRow | undefined),
		occurrences24h: ((occurrences?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0,
	});
}

/** GET /connection: who the key belongs to, and the API version. */
export async function getConnection(c: Context<Scoped>): Promise<Response> {
	const scope = c.get("scope");
	const base = { apiVersion: API_VERSION, toolVersion: VERSION };
	if (scope.kind === "admin") return c.json({ ...base, permission: "admin", application: null });
	const row = await findApplication(c.env.DB, scope.applicationId);
	return c.json({
		...base,
		permission: scope.permission,
		application: row
			? { id: row.id, name: row.name, archivedAt: iso(row.archived_at) }
			: { id: scope.applicationId, name: scope.applicationId, archivedAt: null },
	});
}

function findApplication(db: D1Database, id: string) {
	return db.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first<ApplicationRow>();
}

function componentsJson(
	declared: { value: Component[] | null } | { error: string },
): string | null {
	return "value" in declared && declared.value ? JSON.stringify(declared.value) : null;
}

function validateComponents(input: unknown): { value: Component[] | null } | { error: string } {
	if (input === undefined || input === null) return { value: null };
	if (!Array.isArray(input) || input.length > COMPONENTS_MAX) {
		return { error: `components must be a list of at most ${COMPONENTS_MAX}` };
	}
	const out: Component[] = [];
	const seen = new Set<string>();
	for (const item of input) {
		const source = typeof item?.source === "string" ? item.source.trim() : "";
		const displayName = typeof item?.displayName === "string" ? item.displayName.trim() : "";
		if (!source || source.length > SOURCE_MAX) {
			return { error: `each component needs a source of 1-${SOURCE_MAX} characters` };
		}
		if (displayName.length > NAME_MAX) {
			return { error: `displayName must be at most ${NAME_MAX} characters` };
		}
		if (seen.has(source)) continue;
		seen.add(source);
		out.push(displayName ? { source, displayName } : { source });
	}
	return { value: out };
}
