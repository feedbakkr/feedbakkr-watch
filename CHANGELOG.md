# Changelog

Each release is a git tag. The API version only changes for a change that breaks existing callers; see [docs/api.md](docs/api.md).

## 1.0.1

Fixes to installing and updating, found in trial installs.

- **Install by fork, then Cloudflare.** The README now walks through it in three parts, replacing the Deploy to Cloudflare button. The button's flow could lose its way, and made a plain copy that couldn't be updated with Sync fork.
- **The first deploy creates the database.** `pnpm run deploy` now creates the `feedbakkr-watch` D1 database if it's missing, then applies migrations and deploys. Before, a fresh install failed with "Couldn't find a D1 DB".
- **The admin key survives updates.** `keep_vars` keeps variables set in the Cloudflare dashboard when a build deploys, so an admin key added as Text (Cloudflare's default) is no longer wiped. Adding it as a Secret is still recommended.
- **Preview URLs are off.**

Nothing changes in the API or the database. To update, select **Sync fork** on your fork.

## 1.0.0

The first public release (API version 3).

- One Worker and one D1 database.
- Ingest with grouping, counts of affected users and sessions, reopening on regression, redaction of sensitive keys, rate limits per IP and per ingest key, and a daily cap per app.
- A management API for one app at a time with access tokens, used by FeedBakkr. Ingest keys can be renamed and their allowed sites changed without changing the key.
- A daily clean-up: occurrences after 30 days, and groups quiet for 90 days.
