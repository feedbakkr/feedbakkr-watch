import { env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";
import schema from "../migrations/0001_init.sql?raw";

const TABLES = [
	"error_group_comments",
	"error_occurrences",
	"error_groups",
	"ingest_keys",
	"access_tokens",
	"applications",
	"daily_usage",
];

beforeAll(async () => {
	const exists = await env.DB.prepare(
		"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'applications'",
	).first();
	if (exists) return;
	const statements = schema
		.replace(/--.*$/gm, "")
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const sql of statements) await env.DB.prepare(sql).run();
});

beforeEach(async () => {
	await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
