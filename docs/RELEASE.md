# Release

Use the [development checks](DEVELOPMENT.md) with the release commit. The tarball contains `dist/`, `options.schema.json`, `package.json`, `README.md`, and `LICENSE`. OpenCode loads `dist/tui.js` through the `./tui` export.

## 1. Prepare and test the release

Open a release pull request with the version bump. Use a prerelease version such as `0.1.1-rc.1` for the `next` dist-tag. After approval and merge, tag the release commit `v<version>` and build the artifact from that commit.

```sh
pack_dir=$(mktemp -d)
npm pack --pack-destination "$pack_dir"
```

Run the OpenCode compatibility checks against that tarball. The harness uses an isolated XDG cache and switches between official OpenCode runtimes. It stages the tarball in the latest generation of `opencode/npm/opencode2-enhanced-composer@latest/` inside that cache, then exercises the same package export the registry install uses. Run it against the oldest supported and newest stable hosts when preparing a release. [Runtime check instructions](DEVELOPMENT.md#packaging-and-compatibility)

## 2. Verify a prerelease from npm

Publish the tested prerelease tarball with an explicit dist-tag.

```sh
npm publish "$pack_dir"/opencode2-enhanced-composer-*-rc.*.tgz --tag next
```

Use a fresh OpenCode config and cache for registry verification, or update an existing `@next` install with OpenCode's update command. Use one Enhanced Composer entry in the test config so the selected specifier is clear.

```sh
opencode plugin add opencode2-enhanced-composer@next
opencode plugin update opencode2-enhanced-composer@next
```

Start the TUI, send a prompt, and open **Customize footer**. Confirm the footer, composer-top row, and settings persistence. This step exercises public registry resolution for the prerelease.

## 3. Publish the stable release

Build and verify the stable-version tarball at the approved release commit. Push the tag for that commit, publish the tested tarball with `--tag latest`, then create a GitHub release using the same tag. Summarize the fixes, tested OpenCode versions, and any change users need to make. The npm tarball is the release artifact.

## 4. Verify an existing installation upgrades

OpenCode caches one or more generations of each package specifier under `${XDG_CACHE_HOME:-$HOME/.cache}/opencode/npm/` on Linux. `plugin add` and TUI startup can reuse the newest cached generation. `plugin update` checks the configured specifier for a newer version. Restart the TUI and use `opencode plugin list` to check the installed version.

```sh
opencode plugin update opencode2-enhanced-composer
opencode plugin list
```

Use the configured specifier if it includes a tag or range. When upgrading an exact pin, change the entry in `cli.json` to the new version.
