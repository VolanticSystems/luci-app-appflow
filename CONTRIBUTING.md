# Contributing to luci-app-appflow

Contributions are welcome, including bug reports, and especially the two
hardware tests listed under *Where help is most useful* below.

## Reporting a problem

Useful reports include:

- Device and architecture, OpenWrt release, and `netifyd` version
  (`apk info netifyd` or `opkg info netifyd`).
- What the dashboard showed versus what you expected.
- `logread -e appflowd` output covering the period.
- `ubus call appflow status`, which reports the daemon's own flow counters
  (`seen`, `late`, `dropped`, `purged`, `no_total`). Those five numbers
  distinguish most classes of problem immediately.

If the complaint is about *where bytes were attributed*, read
[docs/DESIGN.md](docs/DESIGN.md) 2.5 first. Some attribution behaviour is
measured, understood and documented rather than accidental, and knowing which
case you are looking at saves everyone time.

## Building

This repository is a single LuCI package, with its `Makefile` at the root and
`icons/` as a second package beside it. That is the same layout upstream
`openwrt/luci` uses under `applications/`, and it drops straight into an
OpenWrt SDK tree's `package/` directory, which the build system scans
recursively.

It is **not** a feed. A feed is a directory *containing* package directories,
and adding this repo directly with `src-link` produces an empty feed index.
The CI workflow stages the packages into a temporary feed directory for
exactly this reason; see `.github/workflows/build.yml`.

    # from an OpenWrt SDK tree matching your target release
    ./scripts/feeds update -a
    ./scripts/feeds install -a
    git clone https://github.com/VolanticSystems/luci-app-appflow.git \
        package/luci-app-appflow
    make package/luci-app-appflow/compile V=s
    make package/luci-app-appflow-icons/compile V=s

CI builds both packages against the OpenWrt SDK on every push and pull
request, so a build break shows up without anyone having to reproduce it
locally.

## Testing a change on a device

The daemon is a single ucode script and the views are plain JS, so the
edit/test loop does not require a rebuild:

    # syntax-check the daemon before installing it
    ucode -c /usr/sbin/appflowd

    # after replacing a view under /www/luci-static/resources/view/appflow/
    rm -f /tmp/luci-indexcache.*
    /etc/init.d/rpcd restart && /etc/init.d/uhttpd restart

Please confirm a change on real hardware before sending it. This package
talks to a DPI engine whose behaviour is version-specific, and several
plausible-looking assumptions about netifyd have already turned out to be
wrong when measured (documented in DESIGN 2.4 and 2.5).

## Code style

Match the surrounding code. Specifically:

- **ucode**, not shell, for daemon logic. Note ucode's integer division and
  the requirement to declare functions before use.
- **No build step for the frontend.** The views are hand-written JS using
  LuCI's own `form`, `ui`, `rpc`, `poll` and `dom` modules, and the charts are
  hand-drawn inline SVG. Please do not introduce a bundler, a framework, or a
  charting dependency.
- Keep `appflowd`'s accounting funnelled through the single `account()` choke
  point. Byte conservation is a verified property of this package and it is
  easy to break by accounting somewhere else.
- SPDX headers on new files, Apache-2.0.

## Commits

Prefix the subject with the package name and keep it lowercase after the
colon, matching OpenWrt convention:

    luci-app-appflow: fix device table sort on equal byte counts

If you would like the change to be portable upstream to `openwrt/luci` later,
add a `Signed-off-by:` line with your real name, which is what upstream's DCO
requires.

## Where help is most useful

Two open items need hardware the author does not have. Both are documented in
[docs/DESIGN.md](docs/DESIGN.md) 8, with the exact observation that would
settle them:

1. **NAT dual-capture attribution.** Needs a real client routed *through* the
   device so netifyd produces both an internal (`br-lan`) and an external
   (`wan`) capture of the same flow. The deciding question is what netifyd
   4.4.7 puts in `local_mac` / `other_mac` when `ip_nat` is true, which
   determines whether the current rule double-counts or drops.
2. **Late re-point stranding.** If netifyd first reports a flow unclassified
   and identifies it only later, bytes counted before that point stay under
   "Unknown". This has not been observed in the wild and its magnitude is
   unmeasured. A socket capture correlating per-digest `flow` /
   `flow_stats` / detection-update ordering would settle it.

Reports of either, even without a patch, are genuinely valuable.
