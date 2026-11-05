-- FeedBakkr Watch schema. Times are Unix seconds. Ids are `<prefix>_<24 hex>`.
-- Migrations are append-only once released: never edit one that has shipped.

-- Apps that send errors. The id is the `projectId` the SDKs send.
CREATE TABLE applications (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT,
	-- JSON array of { source, displayName? }: names for components, and
	-- components that haven't reported yet.
	components_json TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	archived_at INTEGER
);

-- One row per distinct error (fingerprint) in an app and environment.
CREATE TABLE error_groups (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	environment TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	source TEXT NOT NULL,
	severity TEXT NOT NULL,
	title TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
	first_seen_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	occurrence_count INTEGER NOT NULL DEFAULT 1,
	affected_users_count INTEGER NOT NULL DEFAULT 0,
	affected_sessions_count INTEGER NOT NULL DEFAULT 0,
	-- The latest occurrence's route, so lists need no join.
	representative_route TEXT,
	comment_count INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

-- Grouping on ingest.
CREATE UNIQUE INDEX error_groups_fingerprint
	ON error_groups (project_id, environment, fingerprint);
-- Lists (newest first, usually by status), summaries and the clean-up. Every
-- index costs a write on each event (D1 counts them), so there are few.
CREATE INDEX error_groups_project_status_seen
	ON error_groups (project_id, status, last_seen_at DESC);

-- Each time an error happened.
CREATE TABLE error_occurrences (
	id TEXT PRIMARY KEY,
	group_id TEXT NOT NULL REFERENCES error_groups (id) ON DELETE CASCADE,
	project_id TEXT NOT NULL,
	occurred_at INTEGER NOT NULL,
	source TEXT NOT NULL,
	severity TEXT NOT NULL,
	environment TEXT NOT NULL,
	request_id TEXT,
	session_id TEXT,
	user_id_hash TEXT,
	route TEXT,
	method TEXT,
	status_code INTEGER,
	browser TEXT,
	os TEXT,
	runtime TEXT,
	app_version TEXT,
	error_name TEXT,
	message TEXT NOT NULL,
	stack TEXT,
	breadcrumbs_json TEXT,
	tags_json TEXT,
	context_json TEXT,
	created_at INTEGER NOT NULL
);

CREATE INDEX error_occurrences_group_time ON error_occurrences (group_id, occurred_at DESC);
-- The summary's 24-hour count, and the clean-up.
CREATE INDEX error_occurrences_project_time ON error_occurrences (project_id, occurred_at);
-- Counting distinct users and sessions per group on ingest.
CREATE INDEX error_occurrences_group_user
	ON error_occurrences (group_id, user_id_hash) WHERE user_id_hash IS NOT NULL;
CREATE INDEX error_occurrences_group_session
	ON error_occurrences (group_id, session_id) WHERE session_id IS NOT NULL;

CREATE TABLE error_group_comments (
	id TEXT PRIMARY KEY,
	group_id TEXT NOT NULL REFERENCES error_groups (id) ON DELETE CASCADE,
	author_name TEXT NOT NULL,
	message TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX error_group_comments_group_time ON error_group_comments (group_id, created_at DESC);

-- Events per app per UTC day (days since 1970), for the daily cap.
CREATE TABLE daily_usage (
	project_id TEXT NOT NULL,
	day INTEGER NOT NULL,
	events INTEGER NOT NULL,
	PRIMARY KEY (project_id, day)
) WITHOUT ROWID;

-- Write-only keys for one app: `wchi_<id>_<secret>`. Only a SHA-256 hash is kept.
CREATE TABLE ingest_keys (
	id TEXT PRIMARY KEY,
	key_hash TEXT NOT NULL,
	-- The first characters, so people can tell keys apart.
	key_prefix TEXT NOT NULL,
	project_id TEXT NOT NULL,
	name TEXT NOT NULL,
	-- NULL: any origin. Otherwise a JSON array of exact origins.
	origin_allowlist_json TEXT,
	created_at INTEGER NOT NULL,
	-- Updated at most hourly, so ingest stays a single read.
	last_used_at INTEGER,
	revoked_at INTEGER
);

CREATE INDEX ingest_keys_project ON ingest_keys (project_id, created_at DESC);

-- Management keys for one app, e.g. for FeedBakkr: `wchm_<id>_<secret>`.
CREATE TABLE access_tokens (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL,
	token_prefix TEXT NOT NULL,
	application_id TEXT NOT NULL REFERENCES applications (id),
	permission TEXT NOT NULL CHECK (permission IN ('read', 'manage')),
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	-- Updated at most hourly, so authentication stays a single read.
	last_used_at INTEGER,
	revoked_at INTEGER
);

CREATE INDEX access_tokens_application ON access_tokens (application_id, created_at DESC);
