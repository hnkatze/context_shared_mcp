#!/usr/bin/env bash
# Brings up a local Postgres with the schema and a dev org/project/API key,
# then prints the environment the MCP server expects.
set -euo pipefail

NAME=ctxpg
DB=context_shared
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! docker ps --filter "name=^${NAME}$" --format '{{.Names}}' | grep -q "$NAME"; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16 >/dev/null
fi
docker exec "$NAME" bash -c 'until pg_isready -q -U postgres; do sleep 0.3; done'

export MSYS_NO_PATHCONV=1
docker exec "$NAME" psql -U postgres -q -c "drop database if exists ${DB};" -c "create database ${DB};"
docker cp supabase/migrations/0001_init.sql "$NAME":/tmp/0001.sql >/dev/null
docker cp supabase/seed/dev_seed.sql "$NAME":/tmp/seed.sql >/dev/null
docker exec "$NAME" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 -f /tmp/0001.sql
docker exec "$NAME" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 -f /tmp/seed.sql

echo "CONTEXT_SHARED_DATABASE_URL=postgres://mcp_app:mcp@localhost:55432/${DB}"
echo "CONTEXT_SHARED_API_KEY=ctx_dev_key"
