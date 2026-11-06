#!/usr/bin/env bash
# mt-guardrails-r2 / local-test-stack: boot the disposable local Postgres.
#
# Runs the pinned supabase/postgres image with `docker run`, checks the pulled
# image's digest against the pin, and waits (bounded) until the server accepts
# TCP connections inside the container. The stack is local only: it publishes
# on 127.0.0.1 and nothing here connects to a remote host.
#
# Usage: scripts/mt/stack/up.sh [--seed]
#   --seed   after boot, run replay.sh (strict) and seed.sh.
# Env:
#   POSTGRES_PASSWORD     password of the throwaway server (default: postgres)
#   MT_STACK_CONTAINER    container name (default: mt-local-stack)
#   MT_STACK_DB_USER      role used for psql inside the container (default: postgres)
#   MT_STACK_BOOT_TIMEOUT seconds to wait for the server (default: 180)
# Pins: docs/multitenancy/LOCAL-STACK.md ("Pinned versions").
set -euo pipefail

IMAGE="supabase/postgres:17.4.1.074"
DIGEST="sha256:dc436b5b4ebeb0f3bdf6d8dda2b390cc094e14d24cd434d5fe02840459e67670"
CONTAINER="${MT_STACK_CONTAINER:-mt-local-stack}"
DB_USER="${MT_STACK_DB_USER:-postgres}"
BOOT_TIMEOUT="${MT_STACK_BOOT_TIMEOUT:-180}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
export PGPASSWORD="$POSTGRES_PASSWORD"

HERE="$(cd "$(dirname "$0")" && pwd)"

SEED=0
for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    *) echo "up.sh: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "up.sh: docker not found" >&2; exit 2; }

echo "up.sh: pulling $IMAGE"
docker pull "$IMAGE" >/dev/null

repo_digests="$(docker image inspect --format '{{join .RepoDigests " "}}' "$IMAGE")"
case " $repo_digests " in
  *"@$DIGEST "*) echo "up.sh: image digest verified ($DIGEST)" ;;
  *)
    echo "up.sh: digest mismatch for $IMAGE" >&2
    echo "up.sh:   expected: $DIGEST" >&2
    echo "up.sh:   RepoDigests: ${repo_digests:-<none>}" >&2
    exit 1
    ;;
esac

# Always start from an empty database.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "up.sh: starting container $CONTAINER on 127.0.0.1:54329"
docker run -d \
  --name "$CONTAINER" \
  -p 127.0.0.1:54329:5432 \
  -e POSTGRES_PASSWORD \
  "$IMAGE" >/dev/null

deadline=$(( SECONDS + BOOT_TIMEOUT ))
ready=0
while (( SECONDS < deadline )); do
  running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
  if [ "$running" != "true" ]; then
    echo "up.sh: container $CONTAINER is not running" >&2
    docker logs --tail 50 "$CONTAINER" >&2 || true
    exit 1
  fi
  # -h 127.0.0.1: the entrypoint's init-phase server listens on the socket only,
  # so a TCP answer means the final server is up.
  if docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 -U "$DB_USER" \
    && docker exec -e PGPASSWORD "$CONTAINER" \
      psql -X -q -At -h 127.0.0.1 -U "$DB_USER" -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done

if [ "$ready" -ne 1 ]; then
  echo "up.sh: server not ready after ${BOOT_TIMEOUT}s" >&2
  docker logs --tail 50 "$CONTAINER" >&2 || true
  exit 1
fi

server_version="$(docker exec -e PGPASSWORD "$CONTAINER" \
  psql -X -q -At -h 127.0.0.1 -U "$DB_USER" -d postgres -c 'SHOW server_version')"
echo "up.sh: ready (server_version=$server_version)"

if [ "$SEED" -eq 1 ]; then
  bash "$HERE/replay.sh"
  bash "$HERE/seed.sh"
fi
