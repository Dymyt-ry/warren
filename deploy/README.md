# Production deployment

## Docker Compose with a host reverse proxy

1. Copy `deploy/production-environment.template` to `.env` and set `PUBLIC_URL` and a freshly generated `WARREN_SETUP_TOKEN`.
2. Start Warren with `docker compose up -d`. Port 3000 binds to loopback only.
3. Install either `Caddyfile.example` or `nginx.conf.example`, replace the hostname, and enable TLS.
4. Create the owner through `PUBLIC_URL/app`. The setup token can remain configured; it has no effect after an owner exists.
5. Back up `/data/warren.db` with SQLite's online `.backup` command. Do not copy only the main file while WAL mode is active.

## Coolify / Traefik

- Build with the repository `Dockerfile`; route the domain to internal port `3000` without publishing that port on the host.
- Mount persistent storage at `/data`; use `/healthz` for health checks.
- Set `PUBLIC_URL=https://…`, `WARREN_DEMO=0`, `WARREN_SEED=0`, and the required setup token before the first request.
- Coolify/Traefik is the immediate proxy, so `WARREN_TRUST_PROXY=1` is normally correct when there is exactly one network hop to the container.

## Cloudflare

`WARREN_CLIENT_IP_HEADER=cf-connecting-ip` is accepted only together with `WARREN_TRUSTED_PROXY_HEADERS=1`. Set both only after the origin firewall allows Cloudflare IP ranges exclusively, or after enabling Authenticated Origin Pulls. Otherwise a client that reaches the origin directly can forge the header and bypass per-IP limits.

Use Full (strict) TLS between Cloudflare and the origin. Do not use Flexible TLS. Keep response buffering disabled for `/api/events`.
