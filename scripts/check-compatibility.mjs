// Verifies the OpenCode 2 compatibility pin in package.json and the floor
// stated in the README. CI also audits the matching anomalyco/opencode Git tag.
import { readFileSync } from "node:fs"

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")

const packages = ["@opencode/plugin", "@opencode/theme"]

const versions = packages.map((name) => packageJson.devDependencies[name])

const version = versions[0]

if (!/^2\.\d+\.\d+$/u.test(version)) {
  throw new Error(`OpenCode 2 compatibility version has an unexpected format: ${version}`)
}

if (!versions.every((candidate) => candidate === version)) {
  throw new Error(`OpenCode 2 packages must use one exact version: ${versions.join(", ")}`)
}

const floor = /minimum supported OpenCode 2 version is\s+`(2\.\d+\.\d+)`/iu.exec(readme)?.[1]

if (floor === undefined) {
  throw new Error("README does not state a minimum supported OpenCode 2 version")
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number)
  const rightParts = right.split(".").map(Number)

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }

  return 0
}

if (compareVersions(floor, version) > 0) {
  throw new Error(`README floor ${floor} is newer than the pinned compatibility target ${version}`)
}

console.log(`OpenCode 2 compatibility target: ${version} (floor ${floor})`)
