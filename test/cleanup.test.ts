import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { cleanUp } from "../src/cleanup";
import { call, event, send } from "./helpers";

const DAY = 86_400;

it("removes old occurrences and quiet closed groups, and keeps the rest", async () => {
	const open = (await send(event({ message: "Still open" }))).json.groupId;
	const resolved = (await send(event({ message: "Fixed long ago" }))).json.groupId;
	await call("POST", `/v1/groups/${resolved}/resolve`);
	await call("POST", `/v1/groups/${resolved}/comments`, {
		body: { authorName: "Sam", message: "Done" },
	});
	const recent = (await send(event({ message: "Fixed recently" }))).json.groupId;
	await call("POST", `/v1/groups/${recent}/resolve`);

	const now = Math.floor(Date.now() / 1000);
	await env.DB.batch([
		env.DB.prepare("UPDATE error_occurrences SET occurred_at = ? WHERE group_id = ?").bind(
			now - 40 * DAY,
			open,
		),
		env.DB.prepare("UPDATE error_groups SET last_seen_at = ? WHERE id = ?").bind(
			now - 100 * DAY,
			resolved,
		),
	]);

	expect(await cleanUp(env, now)).toEqual({ groups: 1, occurrences: 1 });

	const ids = await env.DB.prepare("SELECT id FROM error_groups ORDER BY id").all<{ id: string }>();
	expect(ids.results.map((r) => r.id).sort()).toEqual([open, recent].sort());
	const left = await env.DB.prepare(
		"SELECT (SELECT COUNT(*) FROM error_occurrences) AS o, (SELECT COUNT(*) FROM error_group_comments) AS c",
	).first<{ o: number; c: number }>();
	expect(left).toEqual({ o: 1, c: 0 });
});
