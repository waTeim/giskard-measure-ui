# Giskard Monitor — deployment

Single-page, real-time UI for the **giskard-measure** shadow monitor. This folder is a
self-contained container build: a prebuilt single-file UI plus a small Node server that
serves it and reverse-proxies the read-only giskard-measure API.

```
deploy/
├── public/index.html     # prebuilt, self-contained UI (fonts + runtime inlined)
├── server.js             # zero-dependency Node server: static + API proxy + health
├── package.json          # no dependencies; `npm start` → node server.js
├── Dockerfile            # base runtime image
├── Dockerfile.spec       # specialization image (bakes env onto the base)
├── Makefile              # build / push / specialization
├── spec/example.env      # sample specialization config
├── .env.example          # sample runtime config
└── .dockerignore
```

## What the server does

- Serves the UI from `public/` (the app shell is returned for any unknown path).
- **Reverse-proxies** the three documented endpoints to `GISKARD_API_BASE`, same-origin so
  the browser needs no CORS:
  - `GET /config`
  - `GET /metrics`
  - `GET /live/{product}`
  Only `GET` is forwarded — the dashboard is strictly read-only.
- `GET /healthz` — liveness (process up).
- `GET /readyz` — readiness (checks the upstream `/config` is reachable).
- Injects the client poll cadence into the page at serve time.

If `GISKARD_API_BASE` is unset or unreachable, the proxy returns `502` and the UI falls
back to its built-in simulation, so a static preview still looks alive. The **status bar**
and **coverage panel** bind to real `/metrics` when available; the band-channel hero and
ticker animate from the local model (see *Data binding* below).

## Run locally (Node)

```bash
cd deploy
GISKARD_API_BASE=http://localhost:8000 npm start
# open http://localhost:8080
```

## Build & run (container)

```bash
make build                                   # build base image
make run GISKARD_API_BASE=http://host:8000   # run on :8080
make push                                    # push base image
```

Override coordinates as needed:

```bash
make build VERSION=1.2.0 REGISTRY=ghcr.io/acme
```

## Specialization (env-baked deploy images)

A *specialization* promotes the same code artifact into a specific environment as an
immutable image with its configuration baked in:

```bash
cp spec/example.env spec/prod.env      # edit GISKARD_API_BASE, INSTANCE_LABEL, ...
make specialization SPEC=prod          # -> <image>:<version>-prod
make push-spec SPEC=prod
```

`Dockerfile.spec` layers the env (`GISKARD_API_BASE`, `INSTANCE_LABEL`, poll cadence,
timeout) onto the base image — no code rebuild.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `GISKARD_API_BASE` | _(unset)_ | Upstream giskard-measure base URL (required for live data) |
| `GISKARD_API_TIMEOUT_MS` | `5000` | Upstream request timeout |
| `METRICS_POLL_MS` | `3000` | Client `/metrics` poll cadence |
| `LIVE_POLL_MS` | `5000` | Client `/live/{product}` poll cadence |
| `INSTANCE_LABEL` | _(empty)_ | Label surfaced on `/healthz` and to the UI |

## Data binding

The UI polls same-origin `/config`, `/metrics`, and `/live/{product}` (via this server's
proxy). Today it binds the **status bar** (counters, uptime, errors, feed-lag freshness)
and the **coverage panel** (per-offset coverage / width / status) to live `/metrics`. The
band-channel hero and resolutions ticker currently render from the local animated model;
binding the hero to `/live/{product}` (its `recent_mids`, `bands`, `resolved`) is the next
data-integration step. Updating the UI is a matter of replacing `public/index.html` with a
freshly exported build — the server and container contract are unchanged.

## Kubernetes notes

- Liveness probe → `GET /healthz`; readiness probe → `GET /readyz`.
- Runs as the unprivileged `node` user; listens on `8080`.
- Set `GISKARD_API_BASE` to the in-cluster service (e.g.
  `http://giskard-measure:8000`), or bake it via a specialization image.
