# Development

Use Node.js `26.4.0` and Bun `1.4.4`, matching [CI](../.github/workflows/ci.yml). Load the checkout using [Run from source](../README.md#run-from-source). See [Architecture](ARCHITECTURE.md) for the module map.

| Command | Purpose |
| :- | :- |
| `npm ci --ignore-scripts` | Install the locked development dependencies. |
| `npm run lint` | Run oxlint. |
| `npm run check` | Check TypeScript types. |
| `npm test` | Run the Bun unit and OpenTUI renderer tests. |
| `npm run check:metadata` | Check SDK pin parity, OpenTUI pins, and the documented minimum. |
| `npm run build` | Rebuild `dist/`. |
| `npm pack` | Run lint, type checks, tests, and build through `prepack`, then create the publishable tarball. |

## Packaging and compatibility

Local directory entries load the root `tui.tsx` through OpenCode's source transform. Registry packages load the compiled `dist/tui.js` through the `./tui` export. OpenCode supplies the Solid and OpenTUI modules for both paths. Use matching versions of the OpenCode client, plugin, and theme for development. The host's OpenTUI pin determines which renderer to use for development.

CI installs the tarball into an isolated OpenCode package cache. It runs `opencode plugin add` to verify TUI routing, then opens the real terminal UI with isolated config and a loopback model server. The checks exercise the footer and session-top slots, the slash command, editor preview and save, live config reload, spinner, streaming and frozen TPS, token totals, cost, and context use.

| OpenCode | Host OpenTUI | Runtime checks |
| :- | :- | :- |
| 2.0.11 | 0.5.10 | Packed plugin, editor, and streamed session. |
| 2.2.0 | 0.7.0 | Packed plugin, editor, and streamed session. |
| 2.2.3 | 0.8.0 | Packed plugin, editor, and streamed session. |
| 2.3.0 | 0.8.4 | Packed plugin, editor, streamed session, background subagent count after the parent becomes idle, and source-directory loading. |

To reproduce on Linux x86-64 after `npm ci`, install the pinned terminal emulator in a virtual environment and run the same harness. It downloads the official CLI for the requested version. Pass `--binary /path/to/opencode` to reuse a binary.

```sh
test_dir=$(mktemp -d)
python3 -m venv "$test_dir/venv"
. "$test_dir/venv/bin/activate"
python -m pip install --only-binary=:all: --require-hashes -r scripts/runtime-test-requirements.txt
npm pack --pack-destination "$test_dir"
npm run test:opencode -- 2.3.0 "$test_dir"/opencode2-enhanced-composer-*.tgz --source "$PWD" --background
```

Use the other versions in the table without `--background` to run their packaged runtime checks. The harness exercises the local artifact through the host cache and uses synthetic model responses. The release runbook covers a separate install from the public registry.

## Dependency security

CI gates the production lockfile and the full lockfile, including development dependencies. The weekly run checks both against newly published advisories. Pull requests also run GitHub dependency review. Repository CodeQL default setup covers JavaScript/TypeScript and GitHub Actions.

```sh
npm audit --package-lock-only --omit=dev --audit-level=low
npm audit --package-lock-only --include=dev --audit-level=low
```

The tarball depends on `jsonc-parser` and `string-width`. It gets Solid and OpenTUI from OpenCode. The development graph uses Solid 1.9.19 and resolves Seroval 1.6.12 through Solid's normal dependency range. It resolves Undici 8.12.4 and 6.29.1 through the development toolchain. There are no Seroval or Undici imports or deserializers in the plugin. The versions in OpenCode's own binary come from its build. [Seroval advisory](https://github.com/advisories/GHSA-p6vx-979v-rg4c) · [Undici security release](https://github.com/nodejs/undici/releases/tag/v8.12.4)

The development lockfile uses two version-scoped overrides for Glob and Minimatch. OpenCode's SDK utility packages and OpenTUI's Babel resolver still depend on affected ranges. The override targets keep the `glob`, `glob.sync`, `minimatch`, and `Minimatch` interfaces used by those callers. Review both overrides when updating the SDK or renderer. [Glob advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) · [Minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)

Keep [options.schema.json](../options.schema.json) aligned with `src/options.ts`. See [Release](RELEASE.md) for publishing.
