# FeedBakkr Watch API

API version **3** (Watch 1.0). JSON in and out. Times are ISO 8601 in UTC.

Send keys in the `x-feedbakkr-tool-key` header. Errors look like:

```json
{ "error": { "code": "NOT_FOUND", "message": "Group not found." } }
```

| Status | Code                                                                                                 | Meaning                                                        |
| ------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`, `INVALID_JSON`                                                                   | The request is wrong; `message` says how                       |
| 401    | `UNAUTHORIZED`                                                                                       | No key, or not a valid one                                     |
| 403    | `FORBIDDEN`, `PROJECT_MISMATCH`, `ORIGIN_NOT_ALLOWED`, `ADMIN_KEY_IN_BROWSER`, `BROWSER_NOT_ALLOWED` | The key can't do this, or a web page called the management API |
| 404    | `NOT_FOUND`                                                                                          | It doesn't exist, or this key can't see it                     |
| 409    | `CONFLICT`, `TOO_MANY_COMMENTS`                                                                      | It already exists, or a group has its 200 comments             |
| 413    | `PAYLOAD_TOO_LARGE`                                                                                  | Events are limited to 64 KB, other bodies to 32 KB             |
| 429    | `RATE_LIMITED`, `DAILY_LIMIT`                                                                        | Slow down, or the app has sent its events for today (UTC)      |
| 503    | `NOT_CONFIGURED`                                                                                     | The admin key isn't set, or is shorter than 32 characters      |

The API version only goes up for a change that breaks existing callers. New fields can appear at any time, so ignore fields you don't know.

## Public

| Route                                  | Returns                                                          |
| -------------------------------------- | ---------------------------------------------------------------- |
| `GET /`                                | `{ name, version, manifest }`                                    |
| `GET /.well-known/feedbakkr-tool.json` | `{ toolId: "feedbakkr-watch", name, version, apiVersion }`       |
| `GET /health`                          | `{ ok, version, checks: { db } }`, 503 when the database is down |

## Sending errors

### `POST /v1/events`

An admin key (server-side only) or an ingest key for the event's `projectId`. Browsers may call it from any site; an ingest key with an origin allowlist only works from those origins.

| Field                                                | Type    |                                                                                                              |
| ---------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `projectId`                                          | string  | Required. The app: 1–100 letters, digits, `.`, `_` or `-`                                                    |
| `source`                                             | string  | Required. The component, e.g. `web`, `api`, `worker` (up to 64)                                              |
| `severity`                                           | string  | Required. `debug`, `info`, `warning`, `error` or `fatal`                                                     |
| `environment`                                        | string  | Required. e.g. `production` (up to 64)                                                                       |
| `timestamp`                                          | string  | Required. When it happened. Times more than 7 days old or 5 minutes ahead are stored as now                  |
| `message`                                            | string  | Required. Stored up to 8 KB                                                                                  |
| `errorName`                                          | string  | e.g. `TypeError`                                                                                             |
| `stack`                                              | string  | Stored up to 32 KB                                                                                           |
| `fingerprint`                                        | string  | Your own grouping key. Without one, Watch groups by the error's name, normalised message and top stack frame |
| `appVersion`                                         | string  |                                                                                                              |
| `request`                                            | object  | `route`, `method`, `statusCode`, `requestId`                                                                 |
| `runtime`                                            | object  | `browser`, `os`, `runtime` and their versions, `userAgent`                                                   |
| `user`                                               | object  | `idHash`, `sessionId`: opaque ids, to count people affected                                                  |
| `breadcrumbs`                                        | array   | Up to 100                                                                                                    |
| `tags`, `context`                                    | object  | Anything else useful. Sensitive-looking keys are redacted                                                    |
| `webContext`, `lastAction`, `fetchHistory`, `causes` |         | Sent by the browser SDK; stored with `context`                                                               |
| `groupByUrl`                                         | boolean | Make the same error on different routes separate groups                                                      |

**202** `{ ok, groupId, occurrenceId, fingerprint, isNewGroup }`

A repeat of a resolved error reopens it. Ignored errors stay ignored. Archived apps still receive events.

**Limits.** Per IP address, 60 events a minute across all keys; per ingest key, 300 a minute; per app, 5,000 a day (`WATCH_DAILY_EVENTS_PER_APP` in `wrangler.jsonc`). The admin key isn't rate limited, but the daily cap applies to it too.

## Managing

Every route below needs the admin key or an access token. An access token sees only its own app: other apps' data answers 404, and `projectId` or `applicationId` parameters are replaced with its own. Read tokens can only `GET`. Routes marked **admin** need the admin key.

### Connection

| Route                            |                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/connection`             | `{ apiVersion, toolVersion, permission: "admin" \| "read" \| "manage", application: { id, name, archivedAt } \| null }` |
| `DELETE /v1/connection`          | An access token revokes itself                                                                                          |
| `GET /v1/summary?applicationId=` | `{ applicationId, openIssues, newIssues24h, occurrences24h, lastErrorAt, environments }`                                |

### Applications

An application's `id` is the `projectId` its events use. Events can arrive before an app is registered.

| Route                                                |                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /v1/applications[?includeArchived=1]`           | `{ data: Application[], unregistered: [{ projectId, summary }] }`                                  |
| `POST /v1/applications` **admin**                    | `{ id, name, description?, components? }` → 201 Application, 409 if the id is taken                |
| `GET /v1/applications/:id`                           | Application                                                                                        |
| `PATCH /v1/applications/:id`                         | `{ name?, description?, components?, archived? }` → Application                                    |
| `GET /v1/applications/:id/components[?environment=]` | `{ data: [{ source, displayName, openIssues, totalGroups, lastSeenAt, declared }], environments }` |

Application: `{ id, name, description, components: [{ source, displayName? }], createdAt, updatedAt, archivedAt, summary: { openIssues, newIssues24h, lastErrorAt, environments } }`

### Groups

| Route                                               |                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/groups`                                    | `?projectId=&status=&environment=&source=&severity=&q=&page=&pageSize=` (newest first; `q` searches titles; `pageSize` up to 100; pages stop 10,000 rows in) → `{ data: Group[], pagination: { page, pageSize, total, hasMore } }` |
| `GET /v1/groups/:id`                                | Group                                                                                                                                                                                                                              |
| `POST /v1/groups/:id/resolve`, `/ignore`, `/reopen` | Group                                                                                                                                                                                                                              |
| `POST /v1/groups/bulk-status`                       | `{ ids (up to 200), status }` → `{ ok, requested, updated, notFound }`                                                                                                                                                             |
| `DELETE /v1/groups/:id`                             | Deletes the group, its occurrences and comments                                                                                                                                                                                    |
| `GET /v1/groups/:id/occurrences?page=&pageSize=`    | `{ data: Occurrence[], pagination }`, newest first. `total` counts up to 1,000; the group's `occurrenceCount` is the full number                                                                                                   |
| `GET /v1/groups/:id/comments`                       | `{ data: Comment[] }`, newest first (a group has at most 200)                                                                                                                                                                      |
| `POST /v1/groups/:id/comments`                      | `{ authorName, message (up to 500) }` → 201 Comment                                                                                                                                                                                |

Group: `{ id, projectId, environment, fingerprint, source, severity, title, status, firstSeenAt, lastSeenAt, occurrenceCount, affectedUsersCount, affectedSessionsCount, representativeRoute, commentCount }`

Occurrence: `{ id, groupId, projectId, occurredAt, source, severity, environment, message, errorName?, stack?, route?, method?, statusCode?, requestId?, browser?, os?, runtime?, appVersion?, userIdHash?, sessionId?, breadcrumbs?, tags?, context? }`

Comment: `{ id, groupId, authorName, message, createdAt }`

### Ingest keys

| Route                                |                                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/ingest-tokens[?projectId=]` | `{ data: IngestKey[] }`, revoked ones included                                                                                                                       |
| `POST /v1/ingest-tokens`             | `{ name, projectId (admin key only), originAllowlist? }` → 201 `{ token, record: IngestKey }`. The key is only ever shown here                                       |
| `PATCH /v1/ingest-tokens/:id`        | `{ name?, originAllowlist? }` → IngestKey. The key itself doesn't change, so apps using it need no update. `null` lets any site use it. Revoked keys can't be edited |
| `DELETE /v1/ingest-tokens/:id`       | Revokes it                                                                                                                                                           |

IngestKey: `{ id, prefix, projectId, name, originAllowlist, createdAt, lastUsedAt, revokedAt }`. `originAllowlist` is exact origins like `https://shop.example`, or null for any.

### Access tokens (admin)

| Route                                    |                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /v1/access-tokens[?applicationId=]` | `{ data: AccessToken[] }`                                                                                       |
| `POST /v1/access-tokens`                 | `{ applicationId, name, permission: "read" \| "manage" }` → 201 `{ token, record }`. The app must be registered |
| `DELETE /v1/access-tokens/:id`           | Revokes it                                                                                                      |

AccessToken: `{ id, prefix, applicationId, permission, name, createdAt, lastUsedAt, revokedAt }`
