// Precompiles runtime modules into the published entrypoints. The host
// only applies its Solid transform to files outside node_modules, so ship JS.
import { transformAsync } from "@babel/core"
import ts from "@babel/preset-typescript"
import solid from "babel-preset-solid"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const src = join(root, "src")

const targets = []

for (const source of (await readdir(src)).sort()) {
  if (!/\.tsx?$/.test(source) || /\.(test|d)\.tsx?$/.test(source) || source === "tui.tsx") continue
  targets.push({
    source,
    out: `dist/${source === "footer.tsx" ? "tui.js" : source.replace(/\.tsx?$/, ".js")}`,
    // Presets apply in reverse order: TypeScript first, then Solid's JSX transform.
    presets: source.endsWith(".tsx")
      ? [[solid, { moduleName: "@opentui/solid", generate: "universal" }], [ts]]
      : [[ts]],
  })
}

// dist is generated as a unit; removed source modules must not remain in tarballs.
await rm(join(root, "dist"), { recursive: true, force: true })

for (const target of targets) {
  const source = join(src, target.source)
  const out = join(root, target.out)
  const code = await readFile(source, "utf8")

  const result = await transformAsync(code, {
    filename: source,
    configFile: false,
    babelrc: false,
    presets: target.presets,
  })

  if (!result?.code) throw new Error(`babel produced no output for ${target.source}`)

  const output = `${result.code}\n`

  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, output, "utf8")
  console.log(`built ${out} (${Buffer.byteLength(output)} bytes)`)
}
