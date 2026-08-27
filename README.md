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
publishes over ubus, with no account, key or registration of any kind.

`netifyd` is a separate package with its own configuration and its own
vendor-supplied signature data, so appflow cannot speak for it. It was measured
rather than assumed. On the development router, after 4 days 23 hours of
uptime, netifyd held 16 sockets: 12 unix and 3 packet capture, and **zero TCP
or UDP sockets**, with no outbound connection at any point. The agent does have
a telemetry sink, and OpenWrt's packaged `/etc/netifyd.conf` ships it turned
off:

    [netifyd]
    dump_established_flows = yes
    enable_sink = no

`enable_sink = no` is the line that matters. Check it on your own install
rather than trusting this one: it is netifyd's setting, not appflow's, and
anyone can change it.

The line above it is quoted only because it is really there. **It does
nothing on 4.4.7**: the string `dump_established_flows` does not appear in the
shipped binary at all, while `enable_sink` does. It is a stale key in the
packaged config, and if you were hoping it means the agent will replay
established flows to a client that connects late, it does not. That is the
cause of the "Unknown" limitation below, not something a setting can turn off.

## How it compares

`nlbwmon` is the usual answer to "what is using my bandwidth" on OpenWrt, and
it is the first thing worth checking before installing this.

| | `nlbwmon` | `appflow` |
|---|---|---|
| Axis | Per host, per protocol and port | Per application, per host |
| How it identifies traffic | Conntrack accounting | DPI, via netifyd |
| Storage | Persistent database, survives reboot | In memory only, live view, keeps nothing |
| Range | Days and months | Live, plus past hour |
| Cost | Under 1 MB VSZ for the daemon | netifyd, around 17 MB VSZ, plus about 2 MB for appflowd |

They answer different questions, and both were run on the same router at the
same time on identical traffic to check they can be: nlbwmon reported HTTP
9.99 MB and HTTPS 2.09 MB; appflow reported the same traffic as cloudflare,
github and wikipedia. Neither interfered with the other. If you want durable
per-host accounting, nlbwmon does it better and appflow does not attempt it;
if you want to know which *application* is doing it right now, that is the
question this package exists to answer.

## Screenshots

Live overview:

![Overview](docs/overview.png)

Statistics (past hour):

![Statistics](docs/statistics.png)

## AI services get their own rows

netifyd cannot classify AI traffic and will not soon. Its signature set is
dated **August 2023**, carries 199 applications, and contains no AI vendor at
all, so anything from Claude to Midjourney lands in generic HTTP/S.

The identifying data is already present: netifyd reports the TLS SNI, and
appflow already stores it. So appflow matches that name against a built-in
table of around ninety AI service domains and gives them their own application
rows and four categories: assistants, media, developer tools and
infrastructure (aggregators, inference APIs, GPU rental, vector stores).

**This is hostname matching, not DPI, and it is labelled as such.** It asserts
a classification netifyd did not make. netifyd's own answer always wins except
for a handful of services whose parent brand it recognises and would otherwise
swallow (Gemini under Google, Copilot under GitHub), so the table falls silent
by itself if Netify ever ship AI signatures.

Matching is anchored on label boundaries, never a substring, so
`anthropic.com.attacker.example` is not labelled Anthropic. It changes an
identity and never a byte: byte conservation is asserted across a batch
containing AI flows.

Turn it off with `option ai_breakout '0'` in `/etc/config/appflow`. Two things
it cannot do: match a service behind a shared CDN hostname, and survive ECH,
which encrypts the SNI. netifyd has the same ECH exposure. Detail in
[docs/DESIGN.md](docs/DESIGN.md) section 11.

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

  Accuracy across a restart was measured in 1.0.2 against the client's own
  interface counter: 0.89 and 1.01 of wire truth on two runs, against 0.70 and
  0.79 before that release, with a no-restart control at 1.01. If you want an
  exact figure, take it after the restart window rather than across it.
- **Accurate accounting for clients behind NAT needs conntrack.** netifyd
  reports the WAN-side capture of a NAT'd flow using the router's own address,
  which is indistinguishable from traffic the router originated. appflow
  resolves it by looking the flow up in `/proc/net/nf_conntrack`, which is
  present on any normal OpenWrt firewall install. Measured against interface
  counters: client traffic 99.8% and router traffic 97.9% of actual, each
  counted once. **If conntrack cannot be read**, appflow keeps client
  accounting correct and stops attributing the router's own traffic, rather
  than double-counting; it logs one warning saying so. Check
  `ubus call appflow status` under `conntrack` to see which mode you are in.
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

**If something looks wrong with the numbers**, run `ubus call appflow status`.
Three fields there answer most questions:

| field | what a non-zero value means |
|---|---|
| `bytes.leaked` | **Should read 0.** Traffic was reported by the agent and never reached an aggregate. If this moves, please tell me. |
| `aggregates.refused` | A per-class table filled with live entries, so new applications or devices stopped being tracked. The dashboard is incomplete. Nothing is being mis-counted; the totals stay correct. |
| `flows.shed` | The flow table hit `flow_max` and the least recently active flows were evicted to make room. Raise `flow_max` if this climbs steadily. |

`flows.shed` is counted separately from `flows.pruned`, which is ordinary
housekeeping of idle flows and is expected to be large. Reading them as one
number hides cap pressure underneath normal behaviour.

## Tests

Three suites, 117 checks, no failures. Two need a sandbox router; one needs
nothing but Node and runs on every push.

| suite | checks | what it does |
|---|---|---|
| `tests/frontend-suite.js` | 31 | loads the real view code under Node. Mostly regression tests for defects that shipped. |
| `tests/protocol-suite.sh` | 71 | replaces the agent with a socket the test controls, so byte arithmetic is checked against hand-computed totals rather than a tolerance band, and the error paths a real agent never produces get exercised. |
| `tests/hardware-suite.sh` | 15 | drives real traffic and compares against the client interface's own counter in `/sys/class/net`, which nothing in this daemon can influence. |

Every check names, in a comment written before the assertion, the smallest
edit to the *product* that turns it red, and those sabotages are actually
run. That is what caught three checks in the 2026-08-27 round that could
not fail at all, two of them in the group written to prove the AI matcher
refuses lookalike domains.


Every check carries a comment naming the edit to the *product* that turns it
red, written before the assertion. Details in
[CONTRIBUTING.md](CONTRIBUTING.md).

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

## A sibling package

[`luci-app-wansentry`](https://github.com/VolanticSystems/luci-app-wansentry)
generates a two-uplink mwan3 failover configuration from one page, for people
who want a second WAN to take over automatically without assembling six mwan3
sections by hand. Same author, same OpenWrt release, and it solves a problem
next to this one rather than the same one: appflow tells you what your traffic
is, wansentry keeps it moving when a line drops. Neither depends on the other.

## License

Apache-2.0 — see [LICENSE](LICENSE). The icon pack is a separate package with
its own licensing; see `icons/licenses/` in that package.
