# luci-app-appflow

**Real-time per-application traffic visibility for OpenWrt.**

`appflow` answers the question stock OpenWrt cannot: *what is my network doing
right now, by application?* Netflix vs. YouTube vs. a Windows update, broken
down per device, live in LuCI, built entirely on open components.

> Status: **working, published as a demonstration project.** Developed and
> tested on real hardware, with byte-attribution behaviour measured rather than
> assumed. Read *Known limitations* below before installing: several are
> inherent to the DPI engine, and one affects anyone who restarts the service.
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

`appflow` itself contacts no network service: it reads a local socket and
publishes over ubus, with no account, key or registration of any kind. It does
not speak for `netifyd`, which is a separate package with its own configuration
and its own vendor-supplied application signature data. If you need to know
whether netifyd reaches the network on your install, check netifyd's own
configuration rather than taking this README's word for it.

## Screenshots

Live overview:

![Overview](docs/overview.png)

Statistics (past hour):

![Statistics](docs/statistics.png)

## Known limitations

Read these before installing. They are measured and documented rather than
left to be discovered. Details and supporting measurements are in
[docs/DESIGN.md](docs/DESIGN.md) sections 2.5 and 8.

- **All statistics live in memory and do not survive a restart.** There is no
  database, by design. Restarting `appflowd`, restarting netifyd, or rebooting
  starts the past-hour view from empty. If you need history across restarts,
  this package does not currently provide it.
- **Flows in progress across a restart are attributed to "Unknown".** netifyd
  4.4.7 sends counter updates for a flow that was already established when
  `appflowd` connected, but never the event carrying its identity, so those
  bytes accumulate under "Unknown" until the flow ends. Measured: restarting
  the daemon mid-transfer moved 10.7 MB of a correctly classified HTTP flow.
  It is bounded to the window after a restart, resolves as connections cycle,
  and loses no byte totals. A future version could mitigate the
  `appflowd`-restart case by checkpointing its own identity map; the case where
  *netifyd* restarts cannot be fixed without support from netifyd.
- **Late re-classification may leave early bytes under "Unknown".** If netifyd
  identifies a flow only after several packets, bytes counted before that point
  are not retroactively moved, because the accounting path is deliberately
  append-only. Not observed in practice and currently unquantified.
- **Detection quality is netifyd's, not ours.** Which applications are
  recognised, and how accurately, is a property of the DPI engine and its
  signature data. appflow reports what netifyd detects.
- **This inspects traffic.** Consider whether deep packet inspection is
  appropriate on your network, and for the people using it, before installing.

On accounting accuracy: measured against client-side ground truth, appflow
accounted for **at least** every byte transferred and never lost any (25 flows
of 2 MB gave 50,000,000 bytes transferred against 51,127,054 accounted; 150
flows of 1 KB were all accounted). The roughly 2% excess is consistent with
protocol overhead being counted, but it has not been reconciled packet by
packet, so treat these totals as a close upper bound rather than an exact
byte count.

## Requirements

- OpenWrt with `netifyd` available (developed and tested against **OpenWrt
  25.12.5** with **netifyd 4.4.7**).
- Enough headroom to run DPI. Measured on the test device under light load:
  **netifyd** around 17 MB VSZ, **appflowd** around 2 MB VSZ, negligible CPU
  for both. netifyd is the expensive component; appflow adds little on top.

Tested on a Linksys EA8500 (ipq806x). It is architecture-independent
(`LUCI_PKGARCH:=all`), and CI builds it for `arm_cortex-a15_neon-vfpv4` and
`aarch64_cortex-a53`.

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

The optional icon pack is a separate package in the same tree, so build it
separately if you want it:

    make package/luci-app-appflow-icons/compile V=s

Install on the device (copy the built package over first):

    apk add --allow-untrusted /tmp/luci-app-appflow-[0-9]*.apk

Note the `[0-9]` in that glob: a plain `luci-app-appflow-*.apk` would also
match `luci-app-appflow-icons-*.apk` and pull in the optional icon pack.

`--allow-untrusted` is required because a locally built package is not signed
by an OpenWrt repository key. On releases still using opkg, use
`opkg install ./luci-app-appflow_*.ipk` instead.

### Optional icon pack

`luci-app-appflow-icons` adds brand icons for the applications netifyd can
detect. Without it the dashboard renders letter-tile avatars, which is a
supported configuration rather than a degraded one. It is packaged separately
so the base package stays small, and so it can be removed on its own if the
third-party brand marks it ships ever need to be. Build it as shown above,
then:

    apk add --allow-untrusted /tmp/luci-app-appflow-icons-[0-9]*.apk

## License

Apache-2.0 — see [LICENSE](LICENSE). The icon pack is a separate package with
its own licensing; see `icons/licenses/` in that package.
