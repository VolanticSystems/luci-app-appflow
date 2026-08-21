# CI notes

## build.yml
Builds `luci-app-appflow` with `openwrt/gh-action-sdk@v11`, matrixed over the
EA8500 test device (`arm_cortex-a15_neon-vfpv4`) and the maintainer's
production target class (`aarch64_cortex-a53`), both pinned to OpenWrt
25.12.5. Uploads `bin/packages/**/*.{ipk,apk}`; build logs upload always.

## lint.yml
Three independent jobs: `shellcheck` (init.d + uci-defaults, `sh` dialect,
warning+ only), `json` (every `*.json` parses via `node -e`), `js` (ESLint 9
+ flat config generated at run time in `$RUNNER_TEMP`, mirroring
openwrt/luci's own globals/no-undef-as-warn approach for LuCI view files).

## Unverified — these are drafted, not run
Neither workflow has executed on GitHub yet. Most likely first-run break:
`LUCI_DEPENDS` (netifyd, luci-lib-chartjs, rpcd-mod-ucode, ucode-mod-*)
failing to resolve from the SDK's default feeds for 25.12.5 — the packages
exist upstream, but feed resolution itself wasn't checked. Second: ghcr.io
tags are assumed to mirror the Docker Hub tags I actually confirmed exist.

## Adding the icons package (`luci-app-appflow-icons`, roadmap §9) later
Add it to `PACKAGES:` in build.yml (space-separated), e.g.
`PACKAGES: luci-app-appflow luci-app-appflow-icons` — no other change needed.
