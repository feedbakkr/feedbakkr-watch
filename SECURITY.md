# Security

## Reporting a vulnerability

Please report it privately through [GitHub's private vulnerability reporting](https://github.com/feedbakkr/feedbakkr-watch/security/advisories/new), not in a public issue. We'll reply within a few working days and keep you posted until it's fixed. Please give us a chance to release a fix before you talk about it publicly.

## How Watch protects your data

- **Keys.** Only SHA-256 hashes of ingest keys and access tokens are stored; each is shown once. Keys are compared in constant time.
- **The admin key** must start with `wcha_` and be at least 32 characters; otherwise every route refuses with `NOT_CONFIGURED`. Use a random one: FeedBakkr makes one for you.
- **Web pages** can't call the management API, and can't send events with the admin key: requests with an `Origin` header are refused there.
- **Scope.** An access token sees one app. Anything else answers 404, so it can't tell whether other data exists. Read tokens can only read.
- **Ingest keys** can only send events for their own app, and can be limited to exact origins. An origin limit stops other websites using the key in browsers; it can't stop a script, which can send any `Origin`. Ingest is rate limited per IP and per key, and each app has a daily cap.
- **Input** is validated and size-limited (64 KB per event, 32 KB per management request). Keys that look sensitive are redacted before storage.
- **Responses** are JSON with `nosniff` and `no-store`. Only `POST /v1/events` allows cross-origin requests, without credentials.
- **Logs** never include request bodies or keys.

## Supported versions

Security fixes go into the latest release. Update your Watch to get them.
