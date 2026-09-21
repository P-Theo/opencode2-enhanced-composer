# Development

Use Node.js `26.4.0` and Bun `1.3.12`, matching [CI](../.github/workflows/ci.yml).

Load the checkout using [Run from source](../README.md#run-from-source). See [Architecture](ARCHITECTURE.md) to find the code you need.

## Checks

| Command | Purpose |
| :- | :- |
| `npm run lint` | Run oxlint. |
| `npm run check` | Check TypeScript types. |
| `npm test` | Run the Bun tests. |
| `npm run check:compatibility` | Check the OpenCode SDK pin and README version floor. |
| `npm run build` | Rebuild `dist/`. |
| `npm pack` | Run lint, type-checks, tests, and build, then create the publishable tarball. |

Tests live in [tests/](../tests), mostly named after the source module. `layout-invariants.test.ts` checks generated layouts across widths. `entrypoint.test.ts` builds and exercises the published entry point.

## Packaging and compatibility

Local directory entries load the root `tui.tsx`. Published packages load `dist/tui.js`, built from `src/footer.tsx` by [scripts/build.mjs](../scripts/build.mjs). Test the packed artifact when changing runtime code or packaging. CI also imports it against the host's bundled runtime versions.

Keep `options.schema.json` aligned with `src/options.ts`. Update the pinned `@opencode/plugin` version and README compatibility floor together when a change requires a newer host.

See [Release](RELEASE.md) for publishing.
