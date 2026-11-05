# Changelog

Each release is a git tag. The API version only changes for a change that breaks existing callers; see [docs/api.md](docs/api.md).

## 1.0.0

The first public release (API version 3).

- One Worker and one D1 database, installed with the Deploy to Cloudflare button.
- Ingest with grouping, counts of affected users and sessions, reopening on regression, redaction of sensitive keys, rate limits per IP and per ingest key, and a daily cap per app.
- A management API for one app at a time with access tokens, used by FeedBakkr. Ingest keys can be renamed and their allowed sites changed without changing the key.
- A daily clean-up: occurrences after 30 days, and groups quiet for 90 days.
