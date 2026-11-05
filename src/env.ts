type RateLimit = { limit(input: { key: string }): Promise<{ success: boolean }> };

export interface Env {
	DB: D1Database;
	/**
	 * The admin key (`wcha_…`, a secret): full access to every app. Set it when
	 * you deploy; FeedBakkr uses it once, to register an app and create that
	 * app's own access token. Never put it in browser code.
	 */
	FEEDBAKKR_WATCH_ADMIN_KEY?: string;
	/**
	 * Ingest rate limits, declared under `ratelimits` in wrangler.jsonc: per IP
	 * across all keys, and per ingest key across all IPs. Without them, ingest
	 * isn't rate limited.
	 */
	INGEST_LIMITER?: RateLimit;
	INGEST_KEY_LIMITER?: RateLimit;
	/** Events each app may send per UTC day (default 5,000). A var in wrangler.jsonc. */
	WATCH_DAILY_EVENTS_PER_APP?: string;
}

export type App = { Bindings: Env };
