#!/bin/sh
set -e

echo "[startup] Starting delay-tracker initialization..."

echo "[startup] Step 1: Creating schema..."
node scripts/init-schema.cjs
echo "[startup] Schema creation complete (exit code: $?)"

echo "[startup] Step 2: Running database migrations..."
./node_modules/.bin/node-pg-migrate up \
  -m ./migrations \
  --migrations-schema delay_tracker \
  --migrations-table pgmigrations \
  --create-schema \
  --verbose
echo "[startup] Migrations complete (exit code: $?)"

echo "[startup] Step 3: Starting server..."
exec node dist/index.js
