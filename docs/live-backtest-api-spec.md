# giskard-measure `/live/{product}` — changes needed for the backtest view

**Audience:** an engineer/agent modifying the **giskard-measure** service (the FastAPI app
that serves `/config`, `/metrics`, `/live/{product}`). This document specifies the API
changes the **giskard-measure-ui** dashboard needs, and how the UI will consume them.

> This is a spec, not a patch — the giskard-measure source is a separate repo. Implement the
> contract below; the UI work is tracked separately and depends on it.

## 1. Goal (what the UI is trying to draw)

A **backtest** of the model's predictive bands against realized price — **no forward
speculation**:

- **NOW is the right-hand edge.** Nothing is drawn to the right of NOW.
- **Realized price line** across the visible window (the actual mids).
- **Predicted bands lag the price by their horizon.** A prediction made at time `t` for
  horizon `off` is drawn at its **resolution time** `t + off` (≤ NOW), as a band
  `[origin·(1+low), origin·(1+high)]`. As the realized line passes through each band you can
  see, per horizon, whether the prediction covered (green) or escaped (red).
- **Y-scale is derived from the band bounds** (model-specific, retrieved from the API), not
  invented client-side.

Key geometric fact that bounds the data size: because every drawn band has already resolved
(`t + off ≤ now`) and `off ≤ max_offset`, the prediction time `t ≥ now − max_offset`. So the
origin mid (at `t`), the band bounds (forecast at `t`), and the realized mid (at `t+off`) **all
fall within the last `max_offset` seconds** (here 600s / 10 min). A rolling **600s** cache per
product is sufficient.

## 2. Current contract (as of this writing, verified against the cluster)

`GET /live/{product}` (only the `product` path param; query params are ignored) returns:

```jsonc
{
  "product": "BTC-USD",
  "origin_mid": 60291.6,          // latest mid
  "t_origin": "2026-...Z",        // time of latest mid
  "offsets": [120,300,450,500,550,600],   // horizons, seconds
  "stride": 5,                    // prediction cadence (s) — NOT the mid sampling rate
  "recent_mids": [ {"t":"...Z","mid":60376.3}, ... ],   // ~128 pts, 1s spacing, ONLY ~120s
  "bands":    [ {"offset_s":120,"low":-0.00099,"high":0.00074}, ... ],  // CURRENT forecast only
  "resolved": [ {"offset_s":120,"t_pred":"...Z","origin":60388.3,
                 "realized":-0.00066,"cover":true}, ... ]   // only ~10 per offset; NO band bounds
}
```

`/config`: `{ history: 120, stride: 5, poll_interval: 2, offsets:[...], q_low:0.1,
q_high:0.9, ... }`.

## 3. Gaps (why the current contract can't drive the view)

| # | Gap | Evidence |
|---|-----|----------|
| G1 | **Mid history too short.** Only `history=120`s of `recent_mids`; need `max_offset` (600s). | `recent_mids.length==128`, span 127s; no param extends it. |
| G2 | **No historical band bounds.** `resolved` lacks `low`/`high`, so the band *as forecast in the past* can't be drawn; `bands` is current-only. | `resolved[0]` = `{offset_s,t_pred,origin,realized,cover}`. |
| G3 | **`resolved` history too shallow.** ~10 entries/offset; a 600s window at `stride`=5s needs ~120/offset. | 60 total resolved, 10 per offset. |
| G4 | **No incremental fetch.** Every call is a full snapshot; the UI cannot ask "only what's new". | OpenAPI: `/live/{product}` has only the `product` param. |

## 4. Required changes

### 4.1 Extend `recent_mids` to the max horizon
Retain and return mids covering at least `max_offset` seconds (≈600s ⇒ ~600 points at 1s).
Keep 1s spacing. (Equivalently: make the retained mid window `max(history, max_offset)`.)

### 4.2 Add band bounds to `resolved`, and return the full window
Each `resolved` entry gains the band bounds **as they were forecast at `t_pred`**, and the
array covers the whole retained window (one entry per prediction `stride`, per offset):

```jsonc
{ "offset_s": 120, "t_pred": "...Z", "t_resolve": "...Z",  // t_resolve = t_pred + offset_s
  "origin": 60388.3,            // mid at t_pred (band center)
  "low": -0.00113, "high": 0.00124,   // <-- NEW: band bounds forecast at t_pred (fractions)
  "realized": -0.00066,         // realized fractional move at t_resolve
  "cover": true }
```
`t_resolve` is optional (UI can compute `t_pred + offset_s`) but convenient.

### 4.3 Incremental fetch via `?since=`
Add an optional `since` query param (ISO-8601) to `GET /live/{product}`:

- **Omitted** → full snapshot over the retained window (initial load / product switch).
- **Provided** → return only `recent_mids` with `t > since` and `resolved` with
  `t_pred > since` (or `t_resolve > since` — pick one and document it; **`t_resolve`** is
  better, so newly-*resolved* predictions arrive even if predicted long ago). `bands`,
  `origin_mid`, `t_origin` always reflect current state. Include a top-level
  `server_time`/cursor so the client can pass it back next tick.

Keep responses backward compatible: existing fields stay; additions are additive, so the
current UI fallback keeps working.

## 5. UI consumption plan (for the giskard-measure-ui side)

1. **Initial load / product switch:** `GET /live/{product}` (no `since`) → full 600s cache.
   Build a client-side per-product store: `mids[]`, `resolved[]` (with band bounds), plus
   `offsets`, `origin_mid`.
2. **Each tick** (`poll_interval`≈2s, or `LIVE_POLL_MS`): `GET /live/{product}?since=<cursor>`
   → append new mids and newly-resolved entries; **do not refetch the whole cache**; evict
   anything older than `max_offset` from NOW.
3. **Render (backtest, NOW at RHS):**
   - x: time domain `[now − max_offset, now]`.
   - realized line: `mids`.
   - per offset: plot each resolved prediction's band `[origin·(1+low), origin·(1+high)]` at
     `x = t_resolve`; connect same-offset points into a lagging ribbon; color by `cover`.
   - y-scale: from the union of band bounds (`origin·(1+low/high)`) and the realized line.
4. Keep the existing simulation as the offline/preview fallback when `/live` is unreachable.

This replaces the current (provisional) geometry, which draws bands around `mids[gi−off/10]`
— miscalibrated because it assumes a 10s mid step (real spacing is 1s) and lacks the history
to lag correctly. Treat the present band rendering as a placeholder until 4.1–4.3 land.

## 6. Acceptance criteria

- `GET /live/{product}` returns `recent_mids` spanning ≥ `max_offset` seconds.
- Every `resolved` entry includes numeric `low`/`high` (forecast at `t_pred`) and the array
  covers the full retained window (~`window/stride` per offset).
- `GET /live/{product}?since=<t>` returns only newer mids/resolved and is markedly smaller
  than the full snapshot; replaying `since` cursors reconstructs the same state as one full
  fetch.
- `/openapi.json` documents the `since` param and the extended `resolved` schema.

## 7. DEFECT — `?since=` filters `resolved` by the wrong timestamp (found 2026-06-30)

The implemented `?since=<t>` filters `resolved` by **`t_pred > t`** instead of **`t_resolve > t`**.
A prediction resolves at `t_resolve = t_pred + offset`, so a prediction that *newly resolves*
has an **old `t_pred`** (up to 600s old) — and is therefore excluded by a `t_pred`-based filter.

Measured impact: over a 20s gap, a full fetch showed **24 newly-appeared resolved** entries,
but `?since=<prev server_time>` returned only **2**. A client that relies on `?since` to keep
`resolved` current thus loses ~92% of new predictions while still aging out old ones, so its
prediction set **dwindles and shifts left** instead of refreshing.

**Fix:** make `?since` filter `resolved` by **`t_resolve > since`** (the moment the entry
becomes visible), as stated in §4.3. `recent_mids` filtering (by mid timestamp) is already
correct.

**UI workaround in place until this is fixed:** `giskard-measure-ui` does **not** use `?since`
for predictions — it full-fetches `/live/{product}` (no `since`) for the selected product each
poll and replaces its store. Once this defect is fixed, incremental `?since` can be restored
for the large `recent_mids` payload.

## 8. DEFECT — resolutions are surfaced per *batch*, not per *leg* (found 2026-06-30)

**Symptom in the UI:** only the longest horizon (600s) reaches the right edge; every shorter
horizon's ribbon stops short of "now" (120s stops ~480s short, 300s ~300s short, …). Short
horizons cannot tile the display.

**Evidence (BTC, one snapshot):** for *every* offset the newest `t_pred` is identical
(`≈ now − max_offset`, here 611s), and each offset's newest `t_resolve` = that `t_pred + offset`:

| offset | newest `t_pred` age | newest `t_resolve` age |
|---|---|---|
| 120s | 611s | 491s |
| 300s | 611s | 311s |
| 600s | 611s | 11s |

That uniform newest `t_pred` is the signature of emitting a prediction batch's resolutions only
once the batch's **longest leg (`max_offset`)** has resolved. So a batch's 120s leg — which
actually resolved `offset` seconds after `t_pred` — is withheld until the same batch's 600s leg
resolves, ~`max_offset − offset` seconds later.

**Required:** emit each `(t_pred, offset)` resolution **independently, as soon as its own
realized price is known** (`t_pred + offset ≤ now`) — do not wait for the other legs of the
batch. Equivalently: the prediction cache should let a caller retrieve, for each offset,
predictions whose origin is as recent as `now − offset` (so each leg's newest resolution is
≈ `now`).

**Result:** per offset, `resolved` then has `t_resolve` values right up to ≈ `now`, with the
count inside a `window`-second display scaling as ≈ `window / stride` — i.e. ~`(600)/5` short
(120s) legs filling the whole width vs ~1 long (600s) leg near the right edge: the staggered,
right-aligned, denser-for-short picture. Composes with §7: with `?since` keyed on `t_resolve`
**and** per-leg emission, each incremental poll returns ≈ `len(offsets)` new resolutions (one
freshly-resolved leg per horizon — the "~6 new per tick" the client expects).

**UI side:** no change needed — the dashboard already plots each resolution at its `t_resolve`
(staggered by offset) and renders every in-window resolution, so legs appear and reach the
right edge as soon as the API emits them per-leg. (Efficiency TODO noted by the team: have the
API return the staggered-origin set in a single call so the client doesn't reconstruct it.)
