# appflow — Design

Status: DRAFT (pending GL-firmware reference spec, sections marked ⏳)

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

Counters are **cumulative per flow** → rates are computed by the consumer as
`Δtotal_bytes / Δt` between updates.

### 2.3 Naming and taxonomy

- `definitions` event carries id→tag maps: 416 applications, 217 protocols.
  Two id spaces: nDPI protocol ids (< 10000: `Spotify`, `ZOOM`, `WireGuard`)
  and Netify app ids (≥ 10000: `netify.google-ads`).
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

Decision rule: A if `publish()` proves reliable on 25.12 during build week;
otherwise B. Both keep the same external contract (§5), so the UI is agnostic.

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

## 4. UI specification ⏳

Pending the GL firmware teardown (agent report). Committed structure so far:

- **Overview**: live throughput chart (total + top-N apps), category donut,
  top apps table (rate, session bytes, share), top devices table.
- **Applications**: sortable table — app, category, rate ↓/↑, totals, flows,
  first/last seen; expandable per-app device breakdown + hostnames.
- **Devices**: per-device totals/rates; expandable per-device app breakdown.
  Device names resolved via DHCP leases (`/tmp/dhcp.leases`) + status.json
  MAC map.
- Fidelity target: match GL 4.x information content; exceed it where the data
  allows (categories, nDPI risk flags) without cluttering v1.

## 5. ubus contract (v1 draft)

Object `appflow`:

| method | args | returns |
|---|---|---|
| `summary` | – | totals, rates, top_apps[], top_categories[], top_devices[], window meta |
| `apps` | `{sort, limit}` | full per-app aggregate list |
| `devices` | – | per-device aggregates (+resolved names) |
| `app_detail` | `{app}` | per-device + per-hostname breakdown for one app |
| `flows` | `{limit}` | live flow list (debug/power-user view) |
| `status` | – | daemon health: uptime, flows tracked, events/s, socket state |

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

- ⏳ GL reference spec (agent) — locks §4.
- ⏳ netifyd conf details (agent): socket keepalive, multi-client behavior,
  `flow_stats` cadence config. Purge event confirmed as `flow_purge` (extracted from the netifyd binary, 2026-08-21).
- ucode `publish()` reliability → decides §3 option A/B.
- Dual-capture dedup heuristic needs empirical validation (§3.2).
- EA8500 is a 2-core 1.4 GHz box; DPI + daemon CPU under load to be measured
  before recommending on modest hardware.
