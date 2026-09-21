# Vendored anti-slop plugin

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), from the
`skills/install-anti-slop/assets/anti-slop` tree that is also published as the
`install-anti-slop` skill bundle.

- Base: `e8100a10da49858cfa8d26883d170e9cc8281988` — the pristine snapshot this
  tree was derived from.
- Incoming: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` — copied from the
  refreshed skill bundle at `~/.agents/skills/install-anti-slop/assets/anti-slop`,
  which is byte-identical to upstream at that commit.

The pre-update tree was byte-identical to the base, so this update was a clean
fast-forward with no local customizations to reconcile.

## Registered

- `index.ts` as the `anti-slop` JS plugin in `.oxlintrc.json`.
- All 18 generic rules at `"error"`, including the new
  `no-array-filter-map`, `no-reduce-accumulator-copy`, and
  `require-readable-spacing`, plus the native companion rule
  `oxc/no-accumulating-spread`.

## Copied but not registered

- `effect/**` — the opt-in `anti-slop-effect` plugin. This repository has no
  direct `effect` dependency, so the plugin is not registered and its rules are
  not enabled.

## Intentional deviations

- This `UPSTREAM.md` is the only file in this directory that is not part of the
  upstream bundle.

## Verification

- `npm run lint` reports 0 errors after `oxlint --fix` cleared 39 autofixable
  `require-readable-spacing` findings in project source. A second fix pass left
  the tree unchanged, and the source diffs are blank-line-only.
- `npm run check`, `npm run check:compatibility`, `npm test` (21 pass), and
  `npm run build` pass with the installed `oxlint` / `@oxlint/plugins` 1.82.0.
  No dependency changes were required for the incoming rule API.
- Upstream's RuleTester suite (`oxlint/plugins-dev`) does not run under Bun, the
  repository's test runner, so the adopted rules were exercised through the
  Oxlint CLI instead.
