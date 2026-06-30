# giskard-measure live API — contract (for the UI)

**Audience:** an agent modifying **giskard-measure-ui**. This describes the *current, implemented*
HTTP contract of **giskard-measure** (`/config`, `/metrics`, `/live/{product}`) and exactly how to
consume `/live` to render the backtest. It supersedes the request/defect log in
`docs/live-backtest-api-spec.md` (that doc is the change history; this is the resulting contract).

> Note: these endpoints are served by the deployed giskard-measure pod. The per-leg / `t_resolve`
> behavior below is implemented in source and takes effect once the service is rebuilt+redeployed; if
> the cluster is still on an older image, `/live` falls back to the previous shape (additive fields
> absent) and the UI's full-fetch path still works.

---

## 0. Conventions

- **Returns are fractional, about an origin mid.** A band/realized value `v` maps to a price as
  `price = origin · (1 + v)`. (`realized` is computed as `ln(mid/origin)`; at sub-1% magnitudes log
  and simple returns coincide to <1e‑5, so `origin·(1+v)` is the correct plotting rule for all of
  `low`, `high`, `realized`.)
- **Timestamps are ISO‑8601 UTC** (e.g. `2026-06-30T01:23:45.678+00:00`) unless stated otherwise.
- **NOW is the right edge.** Everything in `resolved` has already happened (`t_resolve ≤ now`); the
  backtest draws nothing to the right of now. (`bands` is the sole forward-looking field — see §3.)
- **Horizons (`offsets`)** are seconds ahead: `[120, 300, 450, 500, 550, 600]`. `max_offset = 600`.
- **`stride`** is the prediction cadence in seconds (a new prediction every ~5 s) — *not* the UI poll
  interval and *not* the mid sampling rate (mids are ~1 s).

---

## 1. `GET /config`  (static-ish; fetch once)

```jsonc
{ "exec_target": "giskard-exec:63007", "model_name": "sk_q6",
  "products": ["BTC-USD","ETH-USD","SOL-USD","LINK-USD","HYPE-USD"],
  "history": 120, "stride": 5, "poll_interval": 2,
  "offsets": [120,300,450,500,550,600],
  "use_encoding": false, "q_low": 0.1, "q_high": 0.9,
  "metrics_window_s": 3600, "metrics_max_samples": 50000 }
```
Drives: product list, `offsets`, `stride`, poll cadence, the metrics window length.

---

## 2. `GET /metrics`  (poll ~every 3 s; the health heartbeat)

```jsonc
{ "monitoring": true, "model_name": "sk_q6", "started_at": "…Z",
  "fired": 35421, "resolved": 34980, "pending": 441, "errors": 0,
  "data_lag_s": { "BTC-USD": 2.0, "ETH-USD": 2.1, … },        // seconds behind real time per product
  "per_offset": [
    { "offset_s": 120, "n": 2859, "window_s": 3600,
      "coverage": 0.83, "mean_width": 0.0023, "hit_rate": 0.50, "hit_n": 2859, "ic": 0.02 },
    … one per offset … ] }
```
- `coverage` / `mean_width` / `hit_rate` / `ic` are over a **rolling `window_s`** (wall-clock) window.
- **Headline = `coverage` vs the 0.80 target** (q_high−q_low). Color: green ≈0.78–0.85, amber 0.65–0.78,
  red <0.65 (under-covering), distinct tint >0.90 (over).
- **De-emphasize `hit_rate`/`ic`** — directional metrics are ≈null by design (range model).
- `data_lag_s`: feed freshness (green <5 s, amber 5–15 s, red >15 s = stale).
- If `monitoring=false`, the rest is absent (`model_name`/config incomplete).

---

## 3. `GET /live/{product}`  (the backtest feed)

Two modes on one endpoint, selected by the optional `since` query param.

### 3a. Full snapshot — `GET /live/{product}`  (initial load / product switch)
```jsonc
{
  "product": "BTC-USD",
  "origin_mid": 60291.6,          // origin of the CURRENT (latest) forecast; null if none fired yet
  "t_origin": "…Z",               // time of that latest forecast
  "offsets": [120,300,450,500,550,600],
  "stride": 5,
  "max_offset": 600,
  "server_time": "…Z",            // cursor — pass back as ?since next tick
  "recent_mids": [ {"t":"…Z","mid":60288.1}, … ],   // realized mids, ~1 s spacing, spanning ≥ max_offset (≈600 s)
  "bands": [ {"offset_s":120,"low":-0.00099,"high":0.00074}, … ] ,  // FORWARD forecast (see note) | null
  "resolved": [
    { "offset_s":120, "t_pred":"…Z", "t_resolve":"…Z",   // t_resolve = t_pred + offset_s (≤ now)
      "origin":60388.3,            // mid at t_pred (band center for THIS entry)
      "low":-0.00113, "high":0.00124,   // band bounds as forecast at t_pred (fractions)
      "realized":-0.00066,         // realized fractional move at t_resolve
      "cover":true },              // realized ∈ [low,high]
    … ]
}
```

**`resolved` is the backtest data.** Semantics:
- One entry **per (prediction, offset) leg that has already resolved**. Windowed by **resolution
  time**: `t_resolve ≥ now − max_offset` (the last ~600 s). Because it's keyed on `t_resolve`, **every
  offset is populated up to ≈ now and back across the whole window** (~`window/stride` ≈ 120 entries
  per offset). Per-leg emission means a short-horizon leg appears ~`offset` seconds after `t_pred`
  (not held for the longest leg), so the 120 s ribbon reaches the right edge just like the 600 s one.
- Each entry stands alone: `(origin, low, high)` give the band rectangle, `realized`+`cover` the
  outcome. You do **not** need `recent_mids` to place a band — only to draw the realized line.
- `realized`/`low`/`high` are fractional (see §0). Draw the band at `x = t_resolve`, `y ∈
  [origin·(1+low), origin·(1+high)]`; color by `cover`.

**`bands` (note — forward, not backtest):** this is the *current* forecast for the latest prediction
(`t_origin`), so its legs resolve in the **future** (`t_origin + offset > now`). The backtest view
("nothing right of now") **must not** plot `bands` as resolved data. Use it only if you want a separate
forward cone; otherwise ignore it. `null` until the first prediction fires.

`origin_mid` / `t_origin` always reflect current state (both modes).

### 3b. Incremental — `GET /live/{product}?since=<ISO>`  (each poll)
Returns the *same shape*, but:
- `recent_mids` → only mids with `t > since`.
- `resolved` → only legs with `t_resolve > since` (i.e. **newly-resolved** legs — typically
  ≈`len(offsets)` per `stride`, one freshly-matured leg per horizon).
- `bands`, `origin_mid`, `t_origin`, `server_time` always reflect current state.

`since` is ISO‑8601; if unparseable it's treated as omitted (full snapshot).

---

## 4. Consumption protocol (UI)

1. **Prefill** (load / product switch): `GET /live/{product}` (no `since`). Build a per-product store:
   `mids[]`, `resolved[]` (with bounds), `offsets`, plus `cursor = server_time`.
2. **Each tick** (`poll_interval` ≈ 2 s): `GET /live/{product}?since=<cursor>`. **Append** new
   `recent_mids` and new `resolved` (dedup — see cursor note); **set `cursor = max `t_resolve`
   seen`**, *not* `server_time`. **Evict** `mids` with `t < now − max_offset` and `resolved`
   with `t_resolve < now − max_offset`. Replace `bands`/`origin_mid`/`t_origin` with the
   returned current values. Do **not** refetch the whole window.

   > **Cursor caveat (important).** Resolved legs lag `server_time` by the resolution delay
   > (observed ~10–24 s: feed lag + emission cadence). If you set `cursor = server_time`, the
   > next `?since=server_time` asks for `t_resolve > server_time` — which no leg satisfies yet —
   > so **`resolved` never updates while `recent_mids` (lag ~2 s) does**: the chart's price line
   > advances but the bands only shift left. Cursor on the **resolved watermark** (`max
   > t_resolve` you hold) instead; that re-pulls a small `recent_mids` tail each poll, so
   > **dedup** mids by `t` and resolved by `(offset_s, t_pred)`. When you hold no resolved yet,
   > leave the cursor empty and full-fetch until legs appear.
3. **Render (backtest, now at RHS):**
   - x-domain `[now − max_offset, now]`.
   - realized line ← `mids`.
   - per offset: plot each `resolved` band `[origin·(1+low), origin·(1+high)]` at `x = t_resolve`;
     connect same-offset entries into a lagging ribbon; color by `cover` (in = green, out = red).
   - y-scale ← union of all band bounds and the realized line.
   - (optional) forward cone from `bands` to the right of now, visually distinct — off by default.
4. **Fallback:** if `/live` is unreachable, keep the offline simulation/preview.

---

## 5. Edge cases

- **Unknown product** → `{ "error": "unknown product X", "products": [...] }` (HTTP 200). Guard before
  reading other fields.
- **No prediction yet** (cold start) → `bands: null`, `origin_mid: null`, `resolved: []`,
  `recent_mids` may be short until the buffer fills.
- **Data gap at a leg** → that leg is simply absent from `resolved` (it resolved-as-gap and was not
  emitted); ribbons can have holes. Don't assume contiguous coverage.
- **`monitoring: false`** (incomplete config) → `{ "monitoring": false, "reason": "…" }`.

---

## 6. What changed vs the old contract (so you can diff the UI)
- `resolved` entries gained **`low` / `high` / `t_resolve`** (previously only `offset_s, t_pred,
  origin, realized, cover`) — so a past band can be drawn as forecast, not reconstructed.
- `recent_mids` now spans **≥ max_offset** (~600 s), not ~120 s.
- `resolved` now covers the **full window per offset** (windowed by `t_resolve`), and short horizons
  reach ≈ now (per-leg emission) instead of lagging ~`max_offset−offset` behind.
- Added **`?since=`** incremental fetch + top-level **`server_time`** cursor, and **`max_offset`**.
- The old provisional geometry (bands around `mids[gi − offset/10]`, assuming a 10 s mid step) is
  obsolete — place bands at `t_resolve` from `resolved`, with 1 s mids.
