# luci-app-appflow

**Real-time per-application traffic visibility for OpenWrt.**

`appflow` answers the question stock OpenWrt cannot: *what is my network doing
right now, by application?* Netflix vs. YouTube vs. a Windows update, broken
down per device, live in LuCI — the kind of DPI dashboard normally reserved
for vendor firmware, built entirely on open components, with no cloud service
and no licence gate.

> Status: **working, published as a demonstration project.** Developed and
> tested on real hardware, with byte-attribution behaviour measured rather than
> assumed (see *Known limitations* and [docs/DESIGN.md](docs/DESIGN.md) §2.5).
> Not currently in the OpenWrt feeds, so it must be built from source.

## How it works

    netifyd (DPI engine, nDPI-based)
        │  JSON flow events (unix socket)
        ▼
    appflowd (ucode daemon: aggregates flows → apps × devices)
        │  ubus
        ▼
    LuCI view (hand-drawn inline SVG charts, live polling)

There is no database and no polling of the DPI engine: `appflowd` holds a live
aggregate in memory and publishes it over ubus. Design notes, including the
netifyd 4.4.7 event contract as observed on real hardware, are in
[docs/DESIGN.md](docs/DESIGN.md).

## Screenshots

Live overview:

![Overview](docs/overview.png)

Statistics (past hour):

![Statistics](docs/statistics.png)

## Requirements

- OpenWrt with `netifyd` available (developed and tested against **OpenWrt
  25.12.5** with **netifyd 4.4.7**).
- A device with enough headroom to run DPI. Measured baseline on the test
  device under light load: netifyd ~16.5 MB VSZ, negligible CPU.

Tested on a Linksys EA8500 (ipq806x). It is architecture-independent
(`LUCI_PKGARCH:=all`), but see *Known limitations* for what has and has not
been exercised on real hardware.

## Install

**This package is not in the official OpenWrt feeds**, so there is no
one-line install from a stock device. Build it with the OpenWrt SDK for your
release and architecture, then install the resulting package.

Build:

    # from an OpenWrt SDK tree matching your device's release
    ./scripts/feeds update -a
    ./scripts/feeds install -a
    git clone https://github.com/VolanticSystems/luci-app-appflow.git \
        package/luci-app-appflow
    make package/luci-app-appflow/compile V=s

Install on the device (copy the built package over first):

    apk add --allow-untrusted /tmp/luci-app-appflow-*.apk

`--allow-untrusted` is required because a locally built package is not signed
by an OpenWrt repository key. On releases still using opkg, use
`opkg install ./luci-app-appflow_*.ipk` instead.

### Optional icon pack

`luci-app-appflow-icons` adds brand icons for the applications netifyd can
detect. Without it the dashboard renders letter-tile avatars, which is a
supported configuration rather than a degraded one. It is packaged separately
so the base package stays small:

    apk add --allow-untrusted /tmp/luci-app-appflow-icons-*.apk

## Known limitations

These are measured and documented rather than discovered later. Details and
the supporting measurements are in [docs/DESIGN.md](docs/DESIGN.md) §2.5 and §8.

- **Flows in progress across a restart are attributed to "Unknown."** netifyd
  4.4.7 has no established-flow dump, so when `appflowd` (or netifyd) restarts,
  any flow already running is reported to us without the event that carries its
  identity. Its remaining bytes accumulate under "Unknown" until the flow ends.
  This is confined to the window after a restart, resolves on its own as flows
  cycle, and never loses bytes; byte conservation through this path is
  verified. There is no fix available without upstream support.
- **Late re-classification may leave early bytes under "Unknown."** If netifyd
  initially reports a flow as unclassified and identifies it only after several
  packets, bytes counted before that point are not retroactively moved, because
  the accounting path is deliberately append-only. This has not been observed
  in practice and its real-world magnitude is unmeasured; it is recorded as an
  open item rather than assumed negligible.
- **NAT dual-capture attribution is unvalidated on hardware.** The rule for
  reconciling the two captures of a NAT'd flow is implemented and reasoned
  through (DESIGN §3.2) but has not been exercised with a real client routed
  through the device, which the development bench could not provide.

## License

Apache-2.0 — see [LICENSE](LICENSE).
