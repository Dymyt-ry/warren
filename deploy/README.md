# Production deployment

## Docker Compose with a host reverse proxy

1. Copy `deploy/production-environment.template` to `.env` and set `PUBLIC_URL` and a freshly generated `WARREN_SETUP_TOKEN`.
2. Start Warren with `docker compose up -d`. Port 3000 binds to loopback only.
3. Install either `Caddyfile.example` or `nginx.conf.example`, replace the hostname, and enable TLS.
4. Create the owner through `PUBLIC_URL/app`. The setup token can remain configured; it has no effect after an owner exists.
5. Back up `/data/warren.db` with SQLite's online `.backup` command. Do not copy only the main file while WAL mode is active.

### Upgrading an existing Compose deployment

Back up the database first and keep the existing `warren-data` named volume attached. Before the first upgrade to this Compose file, copy `deploy/production-environment.template` to `.env`, preserve the instance's existing `PUBLIC_URL`, and generate `WARREN_SETUP_TOKEN` with `openssl rand -hex 32`. The token is required at startup but cannot create another owner once setup is complete. Check the rendered configuration with `docker compose config`, then run `docker compose up -d` without deleting or renaming the volume.

## Coolify / Traefik

- Build with the repository `Dockerfile`; route the domain to internal port `3000` without publishing that port on the host.
- Prefer a managed named volume at `/data`; use `/healthz` for health checks. The container runs as the unprivileged `node` user, so a bind mount must already be writable by that user. Check the image's numeric identity with `docker run --rm --entrypoint id <image> node`, then set ownership on the dedicated host data directory to that exact UID/GID before starting Warren. Do not make the directory world-writable.
- Set `PUBLIC_URL=https://…`, `WARREN_DEMO=0`, `WARREN_SEED=0`, and the required setup token before the first request.
- Coolify/Traefik is the immediate proxy, so `WARREN_TRUST_PROXY=1` is normally correct when there is exactly one network hop to the container.

## Cloudflare

`WARREN_CLIENT_IP_HEADER=cf-connecting-ip` is accepted only together with `WARREN_TRUSTED_PROXY_HEADERS=1`. Set both only after the origin firewall allows Cloudflare IP ranges exclusively, or after the origin proxy is configured to require and verify Cloudflare's Authenticated Origin Pull client certificate. Merely enabling the Cloudflare dashboard toggle does not make the origin reject direct requests, and the supplied Caddy/nginx examples do not configure this mTLS check. Before trusting the header, verify that a direct request to the origin without the Cloudflare client certificate is rejected. Otherwise a client can forge the header and bypass per-IP limits.

Use Full (strict) TLS between Cloudflare and the origin. Do not use Flexible TLS. Keep response buffering disabled for `/api/events`.
