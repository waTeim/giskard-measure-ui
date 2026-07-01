# Repository Guidelines

## Project Structure & Module Organization

This repository is a self-contained deployment UI for `giskard-measure`. The Node entry point is `server.js`, which serves the single-page UI and reverse-proxies read-only API endpoints. The static UI artifact lives in `public/index.html`; replacing this file is the current UI update path. Deployment assets are in `Dockerfile`, `Dockerfile.spec`, `docker-compose.yml`, `Makefile`, and `chart/`. API notes live in `docs/`. Environment examples include `env.sample`, `spec/example.env`, `config.mk.example`, and `values.local.yaml.example`.

## Build, Test, and Development Commands

- `npm start`: runs `node server.js` on `PORT` or `8080`.
- `GISKARD_API_BASE=http://localhost:8000 npm start`: runs locally against a live upstream API.
- `make build`: builds the base Docker image.
- `make run GISKARD_API_BASE=http://host:8000`: runs the image locally on `PORT` or `8080`.
- `make specialization SPEC=prod`: builds an env-baked image from `spec/prod.env`.
- `make helm-install`: installs or upgrades the Helm release using `values.local.yaml`.

There is no dependency install step beyond Node >= 18 because `package.json` declares no runtime dependencies.

## Coding Style & Naming Conventions

Use CommonJS JavaScript in `server.js` and keep the server dependency-free unless a change clearly justifies expanding the runtime surface. Follow the existing style: two-space indentation, semicolons, `const`/`let`, uppercase constants for environment-derived configuration, and small helper functions. Environment variables use uppercase snake case, for example `GISKARD_API_BASE` and `LIVE_POLL_MS`. Helm values should match `chart/values.yaml`.

## Testing Guidelines

No automated test script is currently defined. For server changes, smoke test with `npm start`, then verify `GET /healthz`, `GET /readyz`, `/config`, `/metrics`, and `/live/{product}` as relevant. For container changes, run `make build` and, when practical, `make run`. For Helm changes, use `helm template` or `make helm-install` against a disposable namespace.

## Commit & Pull Request Guidelines

Recent history uses short, imperative fix messages such as `fix band left-right boundaries`. Keep commits focused and describe the behavioral change. Pull requests should include a concise summary, affected runtime or deployment paths, required configuration changes, and verification commands. Include screenshots or browser notes when `public/index.html` changes, and link related issues or deployment tickets when available.

## Security & Configuration Tips

Do not commit real environment files, registry credentials, cluster values, or upstream API secrets. Use the provided `*.example`, `env.sample`, and local ignored files for configuration. The proxy is intended to remain read-only; preserve the existing GET-only behavior unless the API contract is intentionally expanded.
