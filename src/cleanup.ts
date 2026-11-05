import type { Env } from "./env.js";

// The daily clean-up (cron in wrangler.jsonc): occurrences older than 30 days,
// and groups quiet for 90 days (with their comments), whatever their status.
// Deletes run in small batches with a fixed budget per run, so one run stays
// well inside the free plan's daily writes; anything left goes the next day.
// Apps take turns going first, so a busy one can't starve the rest.

export const OCCURRENCE_DAYS = 30;
export const QUIET_GROUP_DAYS = 90;
const USAGE_DAYS = 7;
const BATCH = 500;
/** Deletes that removed something. Checks that find nothing cost reads only. */
const MAX_DELETES = 40;
const MAX_STATEMENTS = 200;

export async function cleanUp(env: Env, now = Math.floor(Date.now() / 1000)) {
	const occurrenceCutoff = now - OCCURRENCE_DAYS * 86_400;
	const groupCutoff = now - QUIET_GROUP_DAYS * 86_400;
	const today = Math.floor(now / 86_400);
	const db = env.DB;

	await db
		.prepare("DELETE FROM daily_usage WHERE day < ?")
		.bind(today - USAGE_DAYS)
		.run();
	const listed = await db
		.prepare("SELECT DISTINCT project_id FROM error_groups")
		.all<{ project_id: string }>();
	const projects = listed.results.map((r) => r.project_id);
	const start = projects.length ? today % projects.length : 0;
	const order = [...projects.slice(start), ...projects.slice(0, start)];

	let deletes = 0;
	let statements = 0;
	const counts = { groups: 0, occurrences: 0 };
	// Groups first: deleting one takes its occurrences with it. Counts come
	// from RETURNING, because D1's `changes` includes the cascaded rows.
	const sweeps = [
		{
			counter: "groups",
			sql: `DELETE FROM error_groups WHERE id IN (
				SELECT id FROM error_groups
				-- Every status: listing them lets the index cover the date range.
				WHERE project_id = ? AND status IN ('open', 'resolved', 'ignored') AND last_seen_at < ?
				LIMIT ?)
			RETURNING id`,
			cutoff: groupCutoff,
		},
		{
			counter: "occurrences",
			sql: `DELETE FROM error_occurrences WHERE id IN (
				SELECT id FROM error_occurrences WHERE project_id = ? AND occurred_at < ? LIMIT ?)
			RETURNING id`,
			cutoff: occurrenceCutoff,
		},
	] as const;

	for (const project of order) {
		for (const sweep of sweeps) {
			while (deletes < MAX_DELETES && statements < MAX_STATEMENTS) {
				statements++;
				const removed = (await db.prepare(sweep.sql).bind(project, sweep.cutoff, BATCH).all())
					.results.length;
				if (removed > 0) deletes++;
				counts[sweep.counter] += removed;
				if (removed < BATCH) break;
			}
		}
	}
	const finished = deletes < MAX_DELETES && statements < MAX_STATEMENTS;
	console.log(JSON.stringify({ event: "watch.cleanup", ...counts, finished }));
	return counts;
}
