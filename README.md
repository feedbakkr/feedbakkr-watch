# FeedBakkr Watch

Simple, free error tracking for your apps, running on your own Cloudflare account.

Your apps send their errors to Watch. Watch groups repeats of the same error, counts how often it happens and to how many people, and keeps the details you need to fix it. You see everything in [FeedBakkr](https://feedbakkr.com), alongside your feedback.

- **Free.** It runs on Cloudflare's free plan: a Worker and a D1 database.
- **Yours.** Errors stay in your Cloudflare account. Watch sends nothing anywhere else.
- **Small.** One Worker, one database, no queues or extra services.

## Install

There are three parts: your own copy of the code, Cloudflare running it, and a key so FeedBakkr can connect. It takes about 10 minutes, and you need a GitHub account and a Cloudflare account (both free).

### 1. Copy the code to your GitHub

[Fork this repository](https://github.com/feedbakkr/feedbakkr-watch/fork) into your GitHub account or organisation.

Your fork is the code Cloudflare runs, so you decide what runs and when it changes. When there's a new version, you choose when to take it (see [Updating](#updating)).

### 2. Run it on Cloudflare

1. In the [Cloudflare dashboard](https://dash.cloudflare.com), go to **Workers & Pages → Create → Import a repository**.
2. Connect GitHub when asked. Cloudflare's GitHub app only needs your fork: choose **Only select repositories** and pick it.
3. Choose your fork, then change three settings:
   - **Project name:** `feedbakkr-watch`
   - **Deploy command:** `pnpm run deploy` (not the default `npx wrangler deploy`, which skips setting up the database)
   - **Enable Preview builds:** off
4. Leave everything else as it is and click **Deploy**. Cloudflare creates the database and its tables and starts Watch. The first build takes a minute or two.

Your Watch's address is on the Worker's page, like `https://feedbakkr-watch.you.workers.dev`. Until step 3 it answers `NOT_CONFIGURED`, which is expected.

### 3. Add the admin key and connect FeedBakkr

1. In FeedBakkr, open **Watch → Set up Watch** and copy the admin key it makes for you.
2. In Cloudflare, open the Worker's **Settings → Variables and Secrets** and click **Add**:
   - **Type:** Secret (not Text, which is the default)
   - **Variable name:** `FEEDBAKKR_WATCH_ADMIN_KEY`
   - **Value:** the admin key

   Click **Deploy**. The key is kept when you update Watch.
3. Back in FeedBakkr, paste your Watch's address.

FeedBakkr registers your app with Watch and gives you an ingest key and the code to add to your app.

## Send errors

Use the SDKs, which capture errors for you:

- Browser: [`@feedbakkr/watch-web`](https://www.npmjs.com/package/@feedbakkr/watch-web)
- Node and Workers: [`@feedbakkr/watch-node`](https://www.npmjs.com/package/@feedbakkr/watch-node)

Or post an event yourself:

```sh
curl https://feedbakkr-watch.you.workers.dev/v1/events \
  -H "content-type: application/json" \
  -H "x-feedbakkr-tool-key: wchi_…" \
  -d '{"projectId":"my-app","source":"api","severity":"error","environment":"production",
       "timestamp":"2026-11-05T12:00:00Z","errorName":"TypeError","message":"Cannot read properties of undefined"}'
```

The full API is in [docs/api.md](docs/api.md).

## Keys

| Key          | Starts with | What it can do                   | Where it goes                                                                                                                                               |
| ------------ | ----------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin key    | `wcha_`     | Everything, in every app         | Only in Cloudflare (as a secret) and, once, in FeedBakkr. Never in an app.                                                                                  |
| Ingest key   | `wchi_`     | Send errors for one app          | In your app, including browser code. You can limit it to your site's address, which stops other websites using it (not scripts, which can fake an address). |
| Access token | `wchm_`     | Read and manage one app's errors | FeedBakkr keeps it, server-side.                                                                                                                            |

Watch stores only a hash of each key, so a key is shown once, when it's made. Web pages can't use the admin key or the management API: Watch refuses any request from a page.

## What Watch keeps

For each error: the message, stack trace, where it happened (route, method, status), the browser or runtime, your app's version, and any breadcrumbs, tags and context your app sends.

- Keys that look sensitive (`password`, `token`, `authorization`, `cookie`, `email` and similar) are replaced with `[REDACTED]` before anything is stored.
- Users and sessions are counted only by the ids your app sends (`user.idHash`, `user.sessionId`). Send a hash or an opaque id, never an email address.
- Occurrences are deleted after 30 days. Errors that haven't happened for 90 days are deleted, whatever their status.

Watch has no analytics and sends no data back to FeedBakkr or anyone else. FeedBakkr reads your errors only with the access token it creates when you connect.

## Cloudflare's free plan

The free plan allows 100,000 Worker requests and 100,000 database rows written a day. Each error writes about 8 rows. To keep you inside that, each app can send 5,000 errors a day (change `WATCH_DAILY_EVENTS_PER_APP` in `wrangler.jsonc` if you're on a paid plan), each IP address 60 a minute, and each ingest key 300 a minute. Repeats of the same error are grouped.

Over an app's daily cap, Watch refuses its new errors until midnight UTC. If Cloudflare's own daily limits are reached, writes fail until they reset. Nothing already stored is lost either way. The [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) raises the limits.

## Updating

FeedBakkr's Watch page tells you when a newer version is available. What changed is in [CHANGELOG.md](CHANGELOG.md).

To update, open your fork on GitHub and click **Sync fork → Update branch**. Cloudflare sees the change, applies any database changes and deploys the new version. Your errors, keys and admin key are kept.

## Develop

Needs Node 22 and pnpm.

```sh
pnpm install
cp .dev.vars.example .dev.vars   # then set an admin key
pnpm migrate:local
pnpm dev                          # http://localhost:9416
pnpm verify                       # lint, types and tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE)
