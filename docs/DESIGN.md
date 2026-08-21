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
`other_bytes` are **per-update deltas** (verified: they return to zero in the
final `flow_purge` while `total_bytes` does not); only `total_bytes` is
cumulative. appflowd accounts the directional deltas directly, clamped
proportionally so they never exceed the growth of `total_bytes`.

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

- `flow_purge` events carry final counters plus `reason: closed|expired|
  terminated`; the final delta must be accounted before flow removal.
- **Corrected:** `dump_established_flows` does NOT exist in netifyd 4.4.7 (string absent from the binary; a research citation of v5-era docs was wrong). On (re)connect a
  client starts blind. appflow ships a forward-compatible uci-defaults script (harmless no-op today) and
  the daemon
  tolerates `flow_stats` for unknown digests (stub "Unknown" entry, backfilled on the
  next `flow` event).
- App detections are `netify.<slug>` strings; protocol names are plain.
- OpenWrt ships netifyd **4.4.7** while upstream is v5.x with a different
  plugin architecture — all behavior here is pinned to 4.4.7-as-packaged.
- netifyd bundles its own nDPI statically: `libndpi` is NOT a dependency.

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
    • Chart.js (luci-lib-chartjs) for charts; standard LuCI tables/widgets
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
digests). Policy:

- Attribute flows to the **local device** = `local_mac`/`local_ip` on
  `internal:true` captures; these carry true client identity.
- `internal:false` flows whose `local_ip` is the router itself = router-origin
  traffic, attributed to the device "Router".
- `internal:false` flows with `ip_nat:true` that mirror an internal flow are
  candidates for dedup; v1 heuristic: prefer internal capture, count external
  NAT'd flows only when no internal twin exists. ⏳ validate empirically with a
  real client routed through the box (planned: spare laptop).

### 3.3 Memory bounds (runs on 128 MB devices)

Flow table capped (default 4096 flows, uci-tunable); LRU-pruned on purge
events, idle timeout, and cap pressure. Aggregates are O(apps + devices +
categories), naturally small. No unbounded growth by construction.

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
the tabs disabled with a tooltip, so the seam is visible but honest).

Deliberate deviations from GL, documented as choices:
- **No app icons.** GL's per-app icons/descriptions ship from their CDN and
  are proprietary (netify/eGloo data). appflow renders letter-tile avatars
  colored by category — zero licensing exposure, still scannable.
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
├── htdocs/luci-static/resources/view/appflow/{overview,apps,devices}.js
├── root/etc/init.d/appflowd          # procd wrapper
├── root/etc/config/appflow           # uci: caps, window sizes, top-N
├── root/usr/sbin/appflowd            # ucode daemon (shebang /usr/bin/ucode)
├── root/usr/share/rpcd/acl.d/luci-app-appflow.json
├── root/usr/share/luci/menu.d/luci-app-appflow.json
└── docs/DESIGN.md                    # this file
```

Depends: `netifyd`, `luci-base`, `luci-lib-chartjs`, `rpcd-mod-ucode` (opt. B),
`ucode-mod-socket`, `ucode-mod-uloop`, (`ucode-mod-ubus` — in luci-base deps).

## 7. History extension seams (deliberate, v1 ships them dormant)

1. **Single aggregation choke point**: every counter delta flows through one
   `account(flow, delta_bytes, ts)` function — the only place history taps in.
2. **Time-bucketed accumulators**: aggregates are structured as
   `{cur, buckets[]}` from day one; v1 keeps `buckets` length 0/small (rate
   windows only), history = longer retention + persistence of the same shape.
3. **Persistence interface**: `store.flush(buckets)` no-op stub in v1; later
   implementations (RAM-rotating file / collectd exec / sqlite on USB) plug in
   without touching accounting. Flash-wear rule: never write per-sample to
   overlay; flush coarse buckets only.
4. **ubus contract reserves** `history` method name + `since/until` args.

## 8. Risks / open items

- ~~GL reference spec~~ — landed 2026-08-21, §4 locked against GL 4.9.1 stable.
- ~~netifyd conf details~~ — landed: multi-client listen socket, `dump_established_flows`,
  `flow_stats` cadence config. Purge event confirmed as `flow_purge` (extracted from the netifyd binary, 2026-08-21).
- ucode `publish()` reliability → decides §3 option A/B.
- Dual-capture dedup heuristic needs empirical validation (§3.2).
- EA8500 resource baseline MEASURED (2026-08-21, light load, 12 flows,
  synthetic traffic): netifyd ~16.5 MB VSZ, ~0% CPU, box 95% idle, 397 MB
  free. Heavy-load measurement (real client routed through) still pending.

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
