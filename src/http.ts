import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Every error answers `{ error: { code, message } }`. */
export function jsonError(
	c: Context,
	status: ContentfulStatusCode,
	code: string,
	message: string,
	details?: unknown,
) {
	return c.json(
		{ error: details === undefined ? { code, message } : { code, message, details } },
		status,
	);
}

/** The JSON body as an object, or null when it isn't one. */
export async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
	const body: unknown = await c.req.json().catch(() => null);
	return body && typeof body === "object" && !Array.isArray(body)
		? (body as Record<string, unknown>)
		: null;
}

/** A trimmed string field: the value, null when absent or blank, or an error message. */
export function textField(
	body: Record<string, unknown> | null,
	field: string,
	max: number,
	{ required = false } = {},
): { value: string | null } | { error: string } {
	const raw = body?.[field];
	if (raw === undefined || raw === null) {
		return required ? { error: `${field} is required` } : { value: null };
	}
	if (typeof raw !== "string") return { error: `${field} must be a string` };
	const value = raw.trim();
	if (required && !value) return { error: `${field} is required` };
	if (value.length > max) return { error: `${field} must be at most ${max} characters` };
	return { value: value || null };
}

export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

export function iso(seconds: number | null | undefined): string | null {
	return seconds ? new Date(seconds * 1000).toISOString() : null;
}

/** Deeper pages would make each request read (and skip) too many rows. */
export const MAX_OFFSET = 10_000;

/** `page` and `pageSize` from the query string, clamped so the offset stays within MAX_OFFSET. */
export function paging(c: Context, defaultSize: number) {
	const pageSize = clampInt(c.req.query("pageSize"), defaultSize, 1, 100);
	const page = clampInt(c.req.query("page"), 1, 1, Math.floor(MAX_OFFSET / pageSize) + 1);
	return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pagination(page: number, pageSize: number, total: number) {
	return { page, pageSize, total, hasMore: page * pageSize < total };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	const n = raw === undefined ? fallback : Math.floor(Number(raw));
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function parseJson(value: string | null): unknown {
	if (!value) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}
