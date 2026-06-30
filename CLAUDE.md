# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A self-contained **container build + Helm chart** for the Giskard Monitor — the single-page,
real-time UI for the `giskard-measure` shadow monitor. It is not the UI's source: it ships a
*prebuilt* single-file UI (`public/index.html`) plus a tiny zero-dependency Node server that
serves it and reverse-proxies the read-only `giskard-measure` API.

The README still describes a `deploy/` subfolder, but that has been flattened — its contents
*are* the repo root now (the `deploy/` directory is gone, and `.env.example` was renamed
`env.sample`). The intended deploy target is **Kubernetes via the Helm chart in `chart/`**,
not raw Docker/compose — `docker-compose.yml` and `make run` are for local bring-up only.

## Commands

```bash
# Run locally (Node >= 18, no install needed — there are zero dependencies)
GISKARD_API_BASE=http://localhost:8000 npm start   # -> http://localhost:8080

# Container lifecycle (see Makefile; override VERSION/REGISTRY/PORT as needed)
make build                                   # build base image
make run GISKARD_API_BASE=http://host:8000   # run base image on :8080
make push                                    # push base image
make specialization SPEC=prod                # bake spec/prod.env -> <image>:<version>-prod
make push-spec SPEC=prod

# docker-compose (defaults GISKARD_API_BASE to http://giskard-measure:8000)
docker compose up --build

# Deploy to Kubernetes (copy the example values first, then install)
cp values.example.yaml values.local.yaml   # edit host, giskardApiBase, instanceLabel
make helm-install                           # helm upgrade --install -f values.local.yaml
```

**Makefile config without CLI args**: `make` auto-includes an optional `config.mk`
(`-include`, git-ignored — copy `config.mk.example`). Values there (REGISTRY, VERSION, SPEC,
NAMESPACE, HELM_VALUES, …) apply to every invocation; command-line args still override. The
`config.mk` is included *before* the `?=` defaults so it wins over them.

`make helm-install` runs `helm upgrade --install` against `chart/` with `-f $(HELM_VALUES)`
(default `values.local.yaml`), and injects the image coordinates from the Makefile
(`--set image.repository=$(IMAGE)`, `--set image.tag=$(DEPLOY_TAG)`) so the deployed image
always matches `make build`/`push` — including the `VERSION-SPEC` tag when `SPEC` is set.
Image repo/tag are therefore intentionally absent from the values file.

There is **no build step, no lint, and no test suite** — `npm start` runs `node server.js`
directly. Don't add a bundler/install step for the server; "zero runtime dependencies" is a
deliberate contract (the Dockerfile copies `server.js` + `public/` with no `npm install`).

## Architecture

Two pieces, one contract:

1. **`server.js`** — a single-file HTTP server using only Node core (`http`/`https`/`fs`/`url`).
   Its routing logic, in order:
   - `/healthz` (liveness), `/readyz` (deep readiness — actually fetches upstream `/config`).
   - **Proxy paths** `GET /config`, `GET /metrics`, `GET /live/{product}` — forwarded to
     `GISKARD_API_BASE` same-origin so the browser needs no CORS. **Only `GET` is ever
     forwarded** (non-GET → 405); the dashboard is strictly read-only. This is enforced by
     `PROXY_EXACT` / `PROXY_PREFIX` near the top of the file — keep that allowlist tight.
   - Everything else is **static** from `public/`, with SPA fallback: any unknown,
     non-API path returns the app shell (`index.html`), not a 404.
   - If `GISKARD_API_BASE` is unset/unreachable the proxy returns **502**, and the UI falls
     back to its built-in simulation so a static preview still animates.
   - At serve time the server **injects a `<script>` into `<head>`** of `index.html`
     (`window.__GISKARD_POLL__`, `__GISKARD_API_PREFIX__`, `__GISKARD_INSTANCE__`) so client
     poll cadence and instance label are runtime-configurable without rebuilding the UI.

2. **`public/index.html`** — a ~445KB **prebuilt, minified single-file artifact** (fonts and
   runtime inlined; the app code lives on one long minified line). **Do not hand-edit it to
   change UI behavior.** Updating the UI means replacing this whole file with a freshly
   exported build; the server and container contract stay unchanged. The UI reads the injected
   `window.__GISKARD_*` globals, polls the same-origin proxied endpoints, and binds the
   **status bar** + **coverage panel** to live `/metrics` (via `state.liveMetrics`). The
   hero is a **time-based backtest** of the model bound to `/live/{product}` (schema + API
   verified live in cluster ns `jeffw`). NOW is the right edge; there is **no forward
   projection**.
   - **`backtestHero(...)`** owns the live geometry; `renderVals` calls it whenever
     `liveDataFor(sel)` returns data, else falls back to the old index-based **simulation**
     geometry (offline/preview). Both return the same shapes the template consumes.
   - **realized line** = `recent_mids` (`[{t,mid}]`, 1s spacing) over the last `max_offset`
     (600s), mapped by **time** `X(t)` — not array index.
   - **predicted bands lag by their real offset** — each `resolved` entry
     (`{offset_s,t_pred,t_resolve,origin,low,high,realized,cover}`) is drawn at `x=t_resolve`
     as `[origin·(1+low), origin·(1+high)]`; same-offset points form a lagging ribbon. Escapes
     (`cover:false`) render as rings at the realized point.
   - **y-scale** = realized mids + all in-window band bounds, padded 6% (the model-derived,
     "retrievable" scale).
   - **data layer** — per the contract in **`docs/live-api-contract.md`**: `pullLive(p)`
     **prefills** with a full `GET /live/{product}` (no `since`) then each poll fetches
     `?since=<cursor>` and **merges** (dedup-append new `recent_mids` by `t` and `resolved` by
     `(offset_s,t_pred)`, refresh `bands`/`origin_mid`/`server_time`, evict anything older than
     `max_offset`). The cursor is the **max `t_resolve` seen** (the resolved watermark), *not*
     `server_time`: resolved legs lag `server_time` by the resolution delay (~10–24s), so
     cursoring on `server_time` skips them — the classic "price updates but bands just shift
     left" bug. Cursoring on the watermark re-pulls a small mid tail each poll (deduped) and
     catches every new leg. Stored per product in `this.lcache[p]`. `initLive` polls all
     `PRODUCTS` each `live_ms` (incremental deltas are tiny — ~1 mid-batch + ~6 legs), keeping
     switches instant. This relies on the API's per-leg emission + `t_resolve`-keyed `since`
     (both now implemented); with those, every offset's ribbon reaches ≈now and short horizons
     are denser than long (≈`window/stride` per offset).
   - **fallbacks / follow-ups** — sim runs when `/live` is absent/stale. Hover tooltip is
     disabled in backtest mode (`onChartMove` early-returns when live) — reimplementing it on
     the time axis is a known follow-up. The `covFor` coverage *fallback* still uses symmetric
     `WIDTHS` (only matters if `/metrics` is down).

   The older index-based ribbon was miscalibrated (assumed a 10s mid step; real is 1s) and
   couldn't lag horizons to 600s with only 120s of history. That required the API changes in
   **`docs/live-backtest-api-spec.md`** (now implemented). All bundle edits were validated by
   JSON-decoding the `__bundler/template` block, parsing the app script, and checking the
   geometry math against live payloads — **not** browser-verified.

   **Editing the bundle**: `public/index.html` is a custom-bundler artifact, not plain HTML.
   The whole app lives JSON-encoded inside the `<script type="__bundler/template">` block, so
   any edit to app code must preserve JSON-string escaping (e.g. newlines as `\n`, not raw).
   Validate after editing by JSON-parsing that block, extracting the inner `<script>` with the
   app code, and syntax-checking it (`new vm.Script(...)`); confirm the file still has exactly
   4 `</script>` tags.

## Configuration & images

All config is environment variables consumed by `server.js` (see `.env.example`):
`PORT`, `GISKARD_API_BASE`, `GISKARD_API_TIMEOUT_MS`, `METRICS_POLL_MS`, `LIVE_POLL_MS`,
`INSTANCE_LABEL`.

Two-layer image model:
- `Dockerfile` builds the **base** image (code + static UI, runs as unprivileged `node`).
- `Dockerfile.spec` builds a **specialization**: it takes `BASE_IMAGE` and bakes one
  environment's config (from `spec/<name>.env`, via `--build-arg` → `ENV`) into an immutable
  image — promoting a single code artifact into many environments without a code rebuild. The
  `make specialization` target parses `spec/<SPEC>.env` into `--build-arg`s automatically.

## Kubernetes (Helm chart in `chart/`)

The chart deploys the image produced by `make build`/`make push`
(`image.repository` defaults to the Makefile's `registry.example.com/giskard/giskard-measure-ui`,
tag = chart `appVersion` = `1.0.0`). Originally a `helm create` scaffold, now adapted to the
real app:

- **`config:` values block** exposes the five specialization env vars from `Dockerfile.spec`
  (`giskardApiBase`, `giskardApiTimeoutMs`, `metricsPollMs`, `livePollMs`, `instanceLabel`),
  injected as container `env` in `templates/deployment.yaml`. This lets one base image be
  promoted via Helm values instead of building a per-env specialization image — the two
  mechanisms are interchangeable (baked image ENV wins if both are set). Defaults follow
  `env.sample`/`docker-compose.yml`; `instanceLabel` is omitted from the pod spec when empty.
- **Ports**: `containerPort` (8080, server's `PORT`) is decoupled from `service.port` (80).
  The named `http` port and both probes target the container port.
- **Probes**: liveness → `/healthz`, readiness → `/readyz`. Readiness *intentionally* fails
  when `GISKARD_API_BASE` is unreachable (deep readiness), so the pod leaves the Service.
- **Exposure**: ingress-nginx (`ingress.className: nginx`) with TLS issued by **cert-manager**
  via the `cert-manager.io/cluster-issuer: letsencrypt` annotation. The gateway-API
  `httpRoute` from the scaffold was removed. Set `ingress.hosts[].host` + `ingress.tls` host
  to your DNS record.
- **Hardening**: runs as non-root uid 1000 with a read-only root filesystem and all caps
  dropped — safe because `server.js` only ever reads from disk.
- **Test**: `helm test` hits `/healthz` (template under `chart/templates/tests/`).

Validate changes with `helm lint chart` and `helm template r chart`.
