#!/usr/bin/env bash
# Boots a throwaway Postgres, applies the migration, runs the tenancy tests.
# Leaves the container up on :55432 so the MCP server can be exercised against it.
#
# Paths stay relative on purpose: MSYS_NO_PATHCONV is required so the container
# side (/tmp/...) survives, and that same flag stops Git Bash from turning a
# Windows source path into /c/... which docker cannot resolve.
set -euo pipefail

NAME=ctxpg
cd "$(dirname "${BASH_SOURCE[0]}")/.."

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16 >/dev/null
docker exec "$NAME" bash -c 'until pg_isready -q -U postgres; do sleep 0.3; done'

export MSYS_NO_PATHCONV=1
docker cp supabase/migrations/0001_init.sql "$NAME":/tmp/0001.sql >/dev/null
docker cp supabase/tests/0001_tenancy_test.sql "$NAME":/tmp/test.sql >/dev/null

docker exec "$NAME" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/0001.sql
docker exec "$NAME" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/test.sql
