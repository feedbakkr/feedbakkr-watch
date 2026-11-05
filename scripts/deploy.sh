#!/bin/sh
# Cloudflare's deploy command (`pnpm run deploy`): create the database the first
# time, apply any new migrations, then deploy. Safe to run on every build.
set -eu

# Keep in step with database_name in wrangler.jsonc.
DATABASE=feedbakkr-watch

if ! wrangler d1 info "$DATABASE" > /dev/null 2>&1; then
	echo "Creating the $DATABASE database"
	wrangler d1 create "$DATABASE"
fi
wrangler d1 migrations apply DB --remote
wrangler deploy
