import { spyOn } from "bun:test"
import { renameSync } from "node:fs"
import * as filesystem from "node:fs/promises"
import { dirname } from "node:path"

const [path, target, replacement, phase] = process.argv.slice(2)

if (path === undefined || target === undefined || replacement === undefined || (phase !== "temporary" && phase !== "validation")) {
  throw new Error("Expected config path, observed target, replacement and injection phase")
}

const originalOpen = filesystem.open

let targetReads = 0

let injected = false

const interception = spyOn(filesystem, "open").mockImplementation(async (...args: Parameters<typeof originalOpen>) => {
  const handle = await originalOpen(...args)

  if (!injected) {
    const filename = String(args[0])

    const atBoundary = phase === "temporary"
      ? filename.startsWith(`${target}.`) && filename.endsWith(".tmp")
      : filename === target && ++targetReads === 2

    if (atBoundary) {
      renameSync(replacement, path)
      injected = true
    }
  }

  return handle
})

try {
  const { savePluginOptions } = await import("../src/config-file.ts")
  const packageName = "opencode2-enhanced-composer"

  const result = await savePluginOptions({
    path,
    identity: { packageName, directory: dirname(path) },
    selection: { kind: "existing", index: 0, specifier: packageName },
    changes: [{ path: ["appearance", "spinner"], value: "blocks", expected: undefined }],
  })

  console.log(JSON.stringify({ injected, result }))
} finally {
  interception.mockRestore()
}
