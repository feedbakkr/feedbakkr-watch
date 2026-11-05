# Contributing

Thanks for helping. Issues and pull requests are welcome.

- **Bugs and ideas:** open an issue. For anything security-related, see [SECURITY.md](SECURITY.md) instead.
- **Pull requests:** keep them small and focused, with tests. Run `pnpm verify` (lint, types and tests) before you push.

Watch is meant to stay small: one Worker, one D1 database, and the API FeedBakkr needs. Please open an issue to talk through a bigger change before building it.

## Ground rules

- **Migrations are append-only.** Never edit a released file in `migrations/`; add a new one.
- **The API is a contract.** Adding fields is fine. Removing or changing one needs a new API version (see [docs/api.md](docs/api.md)).
- **Mind the free plan.** Each index costs a write on every event, so add one only for a query that needs it, and check queries with `EXPLAIN QUERY PLAN`.
- **No secrets or error contents in logs.**
