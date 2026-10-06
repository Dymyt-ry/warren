#!/usr/bin/env bash
set -euo pipefail

image="warren-ci:${GITHUB_RUN_ID:-local}"
container="warren-ci-smoke-${GITHUB_RUN_ID:-local}"
volume="warren-ci-data-${GITHUB_RUN_ID:-local}"
port=18790
setup_token="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --tag "$image" .
docker volume create "$volume" >/dev/null
docker run --detach --name "$container" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 256 \
  --health-interval 1s \
  --health-start-period 1s \
  --health-timeout 5s \
  --health-retries 5 \
  --publish "127.0.0.1:${port}:3000" \
  --volume "${volume}:/data" \
  --env "PUBLIC_URL=http://127.0.0.1:${port}" \
  --env "WARREN_SETUP_TOKEN=${setup_token}" \
  "$image" >/dev/null

for _ in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:${port}/healthz" >/dev/null; then break; fi
  sleep 0.25
done
curl --fail --silent "http://127.0.0.1:${port}/healthz" >/dev/null

test "$(docker image inspect --format '{{json .Config.Healthcheck.Test}}' "$image")" != "null"
health_status=starting
for _ in $(seq 1 60); do
  health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container")"
  if [ "$health_status" = "healthy" ]; then break; fi
  if [ "$health_status" = "missing" ] || [ "$(docker inspect --format '{{.State.Running}}' "$container")" != "true" ]; then
    docker inspect --format '{{json .State}}' "$container"
    exit 1
  fi
  sleep 0.5
done
if [ "$health_status" != "healthy" ]; then
  docker inspect --format '{{json .State.Health}}' "$container"
  exit 1
fi

test "$(docker exec "$container" id -u)" != "0"
docker exec "$container" test -d /app/node_modules/express
docker exec "$container" test ! -d /app/node_modules/react
docker exec "$container" test ! -d /app/node_modules/tsx
docker exec "$container" test ! -e /app/node_modules/@warren/bridge

setup_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --data "{\"name\":\"CI Owner\",\"org\":\"CI\",\"email\":\"ci@example.test\",\"password\":\"correct horse container smoke\",\"room\":\"CI\",\"setupToken\":\"${setup_token}\"}" \
  "http://127.0.0.1:${port}/api/setup")"
test "$setup_status" = "201"

docker stop --time 15 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = "0"
docker start "$container" >/dev/null
for _ in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:${port}/healthz" >/dev/null; then break; fi
  sleep 0.25
done
login_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --data '{"email":"ci@example.test","password":"correct horse container smoke"}' \
  "http://127.0.0.1:${port}/api/auth/login")"
test "$login_status" = "200"

echo "PASS  hardened container: scoped deps, non-root, read-only root, graceful stop, persistent volume"
