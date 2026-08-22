# appflow — Design

Status: v1 spec LOCKED (2026-08-21). Remaining open items tracked in §8.

## 1. Goal

A LuCI-native, fully open per-application traffic dashboard for OpenWrt:
a functional equivalent of the DPI "traffic statistics" screens found in vendor
firmware (reference: GL.iNet 4.x admin panel), built on the Netify Agent.

Primary scope (v1): **live view** — per-application and per-device rates and
session totals, category grouping, live charts.
Explicit non-goal for v1, but designed-for: **historical accounting** (see §7).

## 2. Ground truth (verified on hardware, 2026-08-21)

Test platform: Linksys EA8500, OpenWrt 25.12.5, netifyd 4.4.7 (nDPI 5.0-based),
arch `arm_cortex-a15_neon-vfpv4`. All facts below observed live, not assumed.

### 2.1 Data source: netifyd JSON export socket

- netifyd **listens** on `unix:/var/run/netifyd/netifyd.sock`
  (`[socket] listen_path[0]`, enabled by default in the OpenWrt package).
- ucode connects with plain `socket.connect(path)` — verified.
- **Wire framing**: newline-delimited JSON where each payload line is preceded
  by a header line `{"length": N}`. Parser rule: parse each line; a lone
  `length` key = frame header (skip); anything else dispatches on `type`.
- Event types observed: `agent_hello`, `definitions`, `agent_status` (15 s
  cadence), `flow`, `flow_stats`.
- `/var/run/netifyd/status.json` contains **agent status only** (plus a useful
  MAC→IP `devices` map) — no flow data. The socket is the only flow source.

### 2.2 Event schemas (as observed)

`flow` (fires on detection; `detection_updated` re-fires on refinement):

```json
{ "type": "flow", "interface": "wan", "internal": false,
  "flow": {
    "digest": "9c2d…",                     // unique flow key
    "detected_application": 10465,
    "detected_application_name": "netify.openwrt",
    "detected_protocol": 5,
    "detected_protocol_name": "DNS",
    "category": { "application": 31, "protocol": 14, "domain": 0 },
    "host_server_name": "openwrt.org",     // SNI/hostname when known
    "local_ip": "…", "local_mac": "…", "local_port": 53,
    "other_ip": "…", "other_mac": "…", "other_port": 57052,
    "other_type": "local" | "remote",
    "local_origin": bool, "ip_nat": bool, "ip_version": 4, "ip_protocol": 17,
    "first_seen_at": 1787325075857, "last_seen_at": …,        // ms epoch
    "risks": { "ndpi_risk_score": 10, "risks": [46] }         // bonus signal
  } }
```

`flow_stats` (periodic per-flow counter updates):

```json
{ "type": "flow_stats", "interface": "wan", "internal": false,
  "flow": { "digest": "…",
    "local_bytes": 0, "other_bytes": 240, "total_bytes": 480,
    "local_packets": 0, "other_packets": 2, "total_packets": 4,
    "last_seen_at": 1787325070685 } }
```

**Correction (implementation ground truth, 2026-08-21):** `local_bytes` /
`other_bytes` are **per-update deltas** during a flow's life, but on the
final `flow_purge` event for that flow they are **always zero** (confirmed
on 10+ live purge events), while `total_bytes` is the flow's final
cumulative value. Since the purge event cannot supply a final directional
split, appflowd recovers it by distributing the `total_bytes` delta since the
last known total across up/down using the flow's established up/down ratio
(accumulated from that flow's prior `flow_stats` deltas), rather than
accounting `local_bytes`/`other_bytes` from the purge event itself.

### 2.3 Naming and taxonomy

- `definitions` event carries id→tag maps: 416 applications, 217 protocols.
  Applications and protocols are SEPARATE id spaces that can collide numerically
  (id 206 is both `WireGuard` the protocol and `netify.cloudflare` the app), and
  legacy netify apps exist below 10000 (netflix=133) — the `netify.` tag prefix,
  not the id range, is the discriminator. Details: docs/netifyd-4.4.7-interface.md.
- Category **names** live in `/etc/netify.d/netify-categories.json`:
  `application_tag_index` (32 tags: `streaming-media`, `social-media`, `games`,
  `voip`, `cdn`, `advertiser`, `os-software-updates`, `malware`, …) and
  `protocol_tag_index` (18 tags), plus `application_index` /
  `protocol_index` mapping category-id → member ids.
- Display-name policy: application name if detected (strip `netify.` prefix,
  title-case), else protocol name, else `Unknown`; hostname (`host_server_name`)
  shown as secondary detail.
- **Licensing**: the signature DB (`netify-apps.conf`) and generated category
  file are eGloo-proprietary data shipped by the `netifyd` package. appflow
  reads them at runtime and **vendors none of this data** in the repo.

### 2.4 Additional confirmed facts (research pass, 2026-08-21)

- `flow_purge` events carry `reason: closed|expired|terminated` and the
  flow's final cumulative `total_bytes`/`total_packets`, but
  `local_bytes`/`other_bytes` are always zero on purge (confirmed live, see
  §2.2); the final up/down split must be recovered from the accumulated
  ratio, not read off the purge event, before flow removal.
- **Corrected:** `dump_established_flows` does NOT exist in netifyd 4.4.7 (string absent from the binary; a research citation of v5-era docs was wrong). On (re)connect a
  client starts blind. appflow ships a forward-compatible uci-defaults script (harmless no-op today) and
  the daemon
  tolerates `flow_stats` for unknown digests (stub "Unknown" entry). **Corrected
  2026-08-22:** that stub is backfilled only when a `flow` event actually follows,
  which happens for a genuine stats-before-flow race but NOT for a flow that was
  already established at connect time — netifyd never emits a `flow` event for
  those, so they stay Unknown for their remaining lifetime. Measured in §2.5.
- App detections are `netify.<slug>` strings; protocol names are plain.
- OpenWrt ships netifyd **4.4.7** while upstream is v5.x with a different
  plugin architecture — all behavior here is pinned to 4.4.7-as-packaged.
- netifyd bundles its own nDPI statically: `libndpi` is NOT a dependency.

### 2.5 Byte-attribution behaviour (measured 2026-08-22)

Three questions about where bytes land were settled on the bench (EA8500,
netifyd 4.4.7). **Method matters here:** all earlier attempts were confounded by
upstream hosts throttling the test router's WAN IP under repeated fetches, and a
refused connection carries no SNI, so netifyd cannot classify it and it lands as
Unknown for reasons unrelated to this daemon. The measurements below therefore
use **LAN-local traffic only** (a file served from the router over `br-lan` via
`socat`, pulled by a LAN client with `curl --limit-rate`), so no upstream can
participate and throttling is impossible by construction.

- **Byte conservation through the Unknown path: HOLDS.** 25 short flows of 2 MB
  = 50,000,000 bytes of client-side ground truth against 51,127,054 bytes
  accounted (the excess is TCP/HTTP overhead, both directions). Repeated with
  150 *tiny* 1 KB flows (the case most likely to complete inside one
  `update_interval`, and so most likely to be purged before any `flow_stats`):
  all 150 accounted, `no_total` = 0, nothing lost. A plausible reading of the
  `fr.total > 0` gate in `flow_update()` predicts silent loss for such flows;
  that prediction is **refuted** on this hardware, because netifyd supplies
  accountable byte counts for sub-interval flows.
- **Connect/reconnect blindness: REAL, bounded, not fixable here.** A flow that
  is already established when the daemon connects gets `flow_stats` but never a
  `flow` event (§2.4), so its identity never arrives and its ongoing bytes
  accumulate under Unknown until it ends. Forced deterministically by restarting
  the daemon mid-transfer: 10.7 MB of a correctly-classified HTTP flow moved to
  Unknown while the app's own total stayed flat, and a fresh socket client
  observed 5 `flow_stats` and 0 `flow` events for that flow. Confined to the
  window after a daemon restart or a netifyd restart, self-heals as flows cycle,
  and the bytes are parked rather than lost. No fix exists on our side without
  an established-flow dump from netifyd; see §8.
- **Late re-point stranding: OPEN, see §8.** Distinct from the above and not yet
  observed in the wild.

Counters relevant to all three (`status.flows`) behaved consistently: `dropped`
stayed 0 and `late` stayed flat under sustained load, so the daemon is not
losing events under load; the Unknown mass seen during earlier testing was the
upstream confound plus the restart blindness above, not an event-handling defect.

## 3. Architecture

```
netifyd (DPI, procd service; nDPI engine)
    │  unix stream, length-framed JSON events
    ▼
appflowd — ucode daemon (procd service)
    • connects to netifyd.sock, reconnects with backoff
    • parses frames, maintains flow table keyed by digest
    • aggregates: totals + windowed rates per (application × device),
      per category, per device; prunes idle flows
    • serves snapshots over ubus  ←— single writer, many readers
    ▼
rpcd ACL (usr/share/rpcd/acl.d) gates LuCI session access
    ▼
LuCI JS view (htdocs/…/view/appflow/*.js)
    • L.poll every 3–5 s → ubus call → render
    • hand-drawn inline SVG charts (theme-aware via CSS custom properties);
      standard LuCI tables/widgets
```

Two implementation options for the ubus surface:

- **A (preferred): appflowd registers a ubus object directly** via
  `ucode-mod-ubus` (`conn.publish()`); rpcd ACL still governs LuCI access.
- **B (fallback): snapshot file** — appflowd atomically writes
  `/var/run/appflow/state.json`; a stateless rpcd-ucode plugin serves reads.

**DECIDED: Option A shipped** — `publish()` proven reliable on 25.12 (typed args,
status returns, int64 all verified on-device). Option B text retained above only as design rationale.

### 3.1 Why a persistent daemon (not an on-demand reader)

The socket is a **stream**: flows announce once, then only counter deltas
follow. Any on-demand reader would miss all context before it connected.
State must live in a long-running consumer; ucode + uloop keeps that consumer
tiny (no C, no external deps beyond packaged ucode modules).

### 3.2 Flow attribution and the dual-capture problem

netifyd watches `br-lan` (internal) and `wan` (external) simultaneously, so a
NAT'd client flow can be captured **twice** (pre- and post-NAT, different
digests, one per interface). The device a flow belongs to and whether it is a
duplicate must be decided without double-counting.

**The shipping rule (implemented in `flow_identify`).** An earlier design paired
the two captures on the remote endpoint and keyed the dedup on `ip_nat`; it was
replaced before v1 because that pairing was fragile (see §10). The rule that
ships is deterministic and needs no cross-flow pairing state:

- **Device side.** On an `internal` capture the device is the non-router
  endpoint; on an `external` capture the device is the router-owned endpoint
  (upstream infrastructure is the peer). `is_router()` decides which side is the
  router, from the interface MAC/IP maps learned from `agent_status`.
- **Multicast/broadcast** endpoints collapse to a single `multicast`
  pseudo-device (via netifyd's `other_type` when present, else the group-bit MAC
  test), so they cannot mint device aggregates.
- **Single-count (shadow) rule.** An `internal` capture is always counted (it is
  the device's own copy). An `external` capture is counted only when the device
  is the router itself; an external capture of a *client* flow is a NAT twin and
  is **shadowed** (tracked, never counted). This is gated on `saw_internal`, a
  process-wide latch meaning "internal capture is active at all": on an
  external-only netifyd (`-E` with no `-I`) nothing is shadowed, so every flow is
  counted rather than dropped to zero.

**What this rule is and is not.** It is a *mode* test ("is internal capture
running"), not a *per-flow twin* test ("does this specific flow have an internal
twin"). The two differ only for flows that appear on the WAN side alone, and
`fr.nat` (`ip_nat`) is retained as a diagnostic field in the `flows` method but
drives no decision.

**Open, and honestly unvalidated (the §8 bench test).** This sandbox never NATs
a client through its WAN, so the rule is confirmed only for the one case
observed (router-origin + LAN-client on the default `-I br-lan -E wan`). The
single fact that decides the NAT case is **what netifyd 4.4.7 puts in
`local_mac`/`other_mac` when `ip_nat` is true**: if those still carry the
router's WAN MAC, `dev_is_router` is true on the twin and it is correctly
shadowed; if netifyd substitutes the client identity, `dev_is_router` is false
and the twin would be dropped instead. Resolve by routing one real client
through the box and comparing the Overview total against the interface byte
counters, before changing the rule. ⏳

**Related sub-case, now mitigated.** A pre-existing external flow captured only
as a stub (`flow_stats` before any `flow` event) is identified once, before
`saw_internal` latches, and would otherwise stay counted alongside its internal
twin for its whole life, inflating the central total. `reshadow()` re-applies
the shadow rule on later stats updates, closing that window to at most one stats
interval. The residual sign question for an unidentifiable stub (a genuine NAT
twin vs. pre-existing router-origin traffic, both landing in the "unknown"
bucket) folds into the same bench test above.

### 3.3 Memory bounds (runs on 128 MB devices)

Flow table capped (default 4096 flows, uci-tunable); LRU-pruned on purge
events, idle timeout, and cap pressure. No unbounded growth by construction,
but the real worst case for the aggregate tables is not small: each of
`AGG_MAX` (384) aggregates per class can carry up to `APP_DEV_MAX` (64)
per-device ring objects, a ceiling of 384 x 64 = 24,576 per-(app x device)
ring objects, plus up to `APP_HOST_MAX` (16) host ring entries per aggregate,
384 x 16 = 6,144 more. Observed RSS was approximately 2 MB at a light load of
33 apps and 11 devices (§8); the structural ceiling above is one to two
orders of magnitude higher than that observed point, not a number the box is
expected to reach under normal use, but worth stating plainly rather than
waved off as "naturally small".

## 4. UI specification (locked 2026-08-21 against GL 4.9.1 stable teardown)

Reference: GL.iNet 4.9.1 "Flow Control → Data Statistics" screen, reverse-
engineered from the shipped firmware (see scratch spec `GL-APPFLOW-SPEC.md`).
Key reference facts: GL's screen is **range-based** (Past hour / Past day /
Past week tabs over SQLite with tiered downsampling: native <1 h, 5-min buckets
<26 h, daily to 8 days), polls every **15 s**, table columns are
Application / Download / Upload / Total (sorted total desc, searchable,
synthetic "All traffic" first row), a Top-10 bar chart, and a per-app detail
drawer (app time series + per-client rows: name, MAC, last seen, share %).
GL's engine is **netifyd itself** (cloud-license-gated); ours is the same
engine with no license gate — classification is 100 % local in both.

appflow v1 ships two tabs:

1. **Overview (live)** — our value-add; GL has no real-time view. Live total
   throughput chart, top apps by current rate, category breakdown, top
   devices. Poll 5 s.
2. **Statistics (Past hour)** — GL-parity range view from in-RAM buckets
   (12 × 5-min per app): Top-10 chart, the Application/Download/Upload/Total
   table (sorted, searchable, "All traffic" row), per-app detail drawer with
   12-point time series + per-device rows (name, MAC, last seen, DL/UL,
   share %), and a Clear button (`reset`). Poll 15 s, matching GL.

**Past day / Past week tabs are phase 2** (require persistence; the UI shows
the tabs disabled with a tooltip, so the seam is visible rather than hidden).

Deliberate deviations from GL, documented as choices:
- **No app icons in core, by design.** GL's per-app icons/descriptions ship
  from their CDN and are proprietary (netify/eGloo data). Core
  `luci-app-appflow` renders letter-tile avatars colored by category on its
  own, zero licensing exposure, still scannable. A separate, optional
  package, `luci-app-appflow-icons` (§9), adds brand icons for the ~100 most
  recognizable detectable apps; core probes for that package's icon
  directory at render time and falls back cleanly when it is not installed.
- **No per-app Block toggle** (GL wires it to their content-filter product;
  out of scope for a statistics package).
- **No enable/disable toggle** — GL gates a heavy NFQUEUE pipeline; appflowd
  is a lightweight socket consumer, service control via standard init.
- Device names resolved from `/tmp/dhcp.leases` + netifyd status.json MAC map
  (GL uses their proprietary client registry socket).

## 5. ubus contract (v1 draft)

Object `appflow`:

| method | args | returns |
|---|---|---|
| `summary` | – | totals, rates, top_apps[], top_categories[], top_devices[], window meta |
| `apps` | `{sort, limit}` | full per-app aggregate list |
| `devices` | – | per-device aggregates (+resolved names) |
| `app_detail` | `{app}` | per-device + per-hostname breakdown + hour time series for one app |
| `stats` | `{range:"hour"}` | GL-parity range totals: all/applications[]/top_apps[] with 12×5-min time series (only `hour` in v1; other ranges rejected until phase 2) |
| `flows` | `{limit}` | live flow list (debug/power-user view) |
| `status` | – | daemon health: uptime, flows tracked, events/s, socket state |
| `reset` | – | zero all aggregates/buckets (the "Clear" function; **write-scope ACL**, separate from read grants) |

All byte values in **bytes**, rates in **bytes/sec** (UI formats). Timestamps
ms epoch. Every response carries `generated_at` + `agent_connected`.

## 6. Package layout

```
luci-app-appflow/
├── Makefile                          # LuCI feed style, PKGARCH:=all
├── htdocs/luci-static/resources/view/appflow/{overview,statistics,common}.js
├── root/etc/init.d/appflowd          # procd wrapper
├── root/etc/config/appflow           # uci: caps, window sizes, top-N
├── root/usr/sbin/appflowd            # ucode daemon (shebang /usr/bin/ucode)
├── root/usr/share/rpcd/acl.d/luci-app-appflow.json
├── root/usr/share/luci/menu.d/luci-app-appflow.json
└── docs/DESIGN.md                    # this file
```

Depends (from `Makefile` `LUCI_DEPENDS`): `netifyd`, `luci-base`,
`ucode-mod-socket`, `ucode-mod-uloop`, `ucode-mod-ubus`, `ucode-mod-uci`,
`ucode-mod-fs`.

## 7. History extension seams (deliberate, v1 ships them dormant)

1. **Single aggregation choke point**: every counter delta flows through one
   `account(flow, delta_bytes, ts)` function — the only place history taps in.
2. **Time-bucketed accumulators**: aggregates are structured as
   `{cur, buckets[]}` from day one, and the buckets are load-bearing in v1,
   not a stub: every aggregate (totals, each app, each device, each
   category) carries a 12-slot, 5-minute ring covering the trailing hour
   (backs the GL-parity `stats`/`app_detail` time series), and every
   per-(app × device) and per-host breakdown carries a coarser 4-slot,
   15-minute ring covering the same trailing window at a quarter of the
   memory. History (§9) extends retention and adds persistence of that same
   shape; it does not introduce the buckets themselves.
3. **Persistence interface**: `store.flush(buckets)` no-op stub in v1; later
   implementations (RAM-rotating file / collectd exec / sqlite on USB) plug in
   without touching accounting. Flash-wear rule: never write per-sample to
   overlay; flush coarse buckets only.
4. **ubus contract reserves** `history` method name + `since/until` args.

## 8. Risks / open items

- ~~GL reference spec~~ — landed 2026-08-21, §4 locked against GL 4.9.1 stable.
- ~~netifyd conf details~~ — landed: multi-client listen socket, `dump_established_flows`,
  `flow_stats` cadence config. Purge event confirmed as `flow_purge` (extracted from the netifyd binary, 2026-08-21).
- ~~ucode `publish()` reliability → decides §3 option A/B~~: resolved, §3
  states Option A shipped, proven reliable on 25.12.
- Dual-capture dedup heuristic needs empirical validation (§3.2): still
  outstanding, no NAT client available on the test bench.
- EA8500 resource baseline MEASURED (2026-08-21, light load, 12 flows,
  synthetic traffic): netifyd ~16.5 MB VSZ, ~0% CPU, box 95% idle, 397 MB
  free. Heavy-load measurement (real client routed through) still pending.
- ~~Byte conservation through the Unknown/late-stub path~~ — VERIFIED sound
  2026-08-22 (§2.5), including the sub-`update_interval` case.
- **Connect/reconnect blindness (KNOWN LIMITATION, will ship).** Flows already
  established when the daemon or netifyd (re)starts have their remaining bytes
  attributed to Unknown, because netifyd 4.4.7 emits no `flow` event for them
  (§2.4, §2.5). Bounded to that window, self-healing, non-destructive. Cannot be
  fixed without an established-flow dump upstream; the forward-compatible
  uci-defaults script is already in place for when one exists. Documented in the
  README rather than hidden.
- **Late re-point stranding (OPEN, unquantified).** If netifyd first reports a
  flow unclassified (`app_id <= 0`) and only later re-points it via a detection
  update, bytes counted before the re-point stay under Unknown, because the
  accounting seam is append-only by design (see the re-point comment in
  `classify()`). No counter currently exposes this, so its real-world magnitude
  is unknown. It could not be induced deliberately on the bench (it needs a
  protocol netifyd classifies only after several packets on a stable
  connection). Cheapest settling test: a real-traffic socket capture correlating
  per-digest `flow`/`flow_stats`/detection-update ordering, excluding
  connect-time orphans by `first_seen_at`; alternatively instrument the re-point
  in `classify()` to accumulate stranded mass into a `status` counter. Deferred
  rather than guessed at.

## 9. Roadmap (queued, post-v1)

1. **v1.1 — `luci-app-appflow-icons`, a SEPARATE package.** Hand-curated mapping
   (netify app id → icon) for the ~100 most-recognizable detectable apps, using
   monochrome SVGs from CC0/Apache-licensed collections (simple-icons /
   dashboard-icons), bundled locally, tinted by category color. Deliberately
   split from core, i18n-style, for legal blast-radius isolation: brand icons
   are trademarks regardless of collection license, so if anyone ever objects
   the icon package is delisted on its own and core is untouched. Coupling is
   runtime-soft in BOTH directions: core probes the icon directory at render
   time and falls back to letter-tile avatars; the icon package depends on
   nothing and breaks nothing when absent or removed. Same repo, second
   package directory.
2. **v2 — Past day / Past week ranges** (persistence per §7 seams; flash-wear
   policy: coarse-bucket flushes only, tmpfs-first with periodic backup,
   GL-style tiered downsampling).

## 10. As-implemented contract notes (v1 final)

§5 sketched the method set; the implemented field naming is authoritative:
live aggregate rows use `bytes_up/bytes_down/bytes_total` +
`rate_up/rate_down/rate_total` (+ `key/name/tag/category`), while the
GL-parity `stats`/`app_detail` range views use `download/upload/total`,
matching GL's own vocabulary for that screen. `status` is nested
(`socket.*`, `flows.*`, `aggregates.*`, `agent.*`, `memory.*`).
`app_detail` takes the aggregate `key` or the raw tag or the display
label (resolver tries all three). The frontend ships normalisers for
both dialects in `view/appflow/common.js`. luci-lib-chartjs was dropped:
the packaged build is a Chart.js 1.x fragment (Doughnut/Pie only), and
inline SVG follows LuCI theme variables, which canvas cannot.
