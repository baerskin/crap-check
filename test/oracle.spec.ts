import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import pkg from "../package.json" with { type: "json" }
import { analyze } from "../src/lib/analyze"
import { DEFAULT_CONFIG } from "../src/lib/config"
import { createScope } from "../src/lib/include"
import { ORACLE } from "../src/lib/measure"

/**
 * Parity against the metric's oracle: ESLint's own `complexity` rule.
 *
 * The point of defining the metric as "whatever ESLint counts" is that a second
 * implementation exists and can be asked. Anything this file cannot explain is a
 * bug in `analyze.ts`, not a difference of opinion, so it runs before any number
 * reaches a history file.
 *
 * Two load-bearing constraints, both learned the hard way. The oracle config
 * lives in a temp directory and runs with `--no-config-lookup`: without it,
 * ESLint finds the repository config, and `globalIgnores` there makes every
 * fixture "ignored because no matching configuration was supplied".
 *
 * The comparison is the sorted multiset of complexity values per file, never
 * line-keyed entries. ESLint anchors an arrow function at its `=>` token
 * (`getFunctionHeadLoc`) while `node.getStart()` anchors at the function start, so
 * line-for-line matching reports false differences on almost every arrow.
 */

/** This package's root: ESLint and its parser are devDependencies here. */
const PACKAGE_ROOT = join(import.meta.dir, "..")

/** ESLint's own message text. The rule states the number it computed. */
const REPORTED = /has a complexity of (\d+)/

interface LintMessage {
  ruleId: string | null
  message: string
}

interface LintResult {
  filePath: string
  messages: LintMessage[]
}

const ORACLE_CONFIG = `
import { createRequire } from "node:module"

const require_ = createRequire(${JSON.stringify(join(PACKAGE_ROOT, "package.json"))})
const parser = require_("@typescript-eslint/parser")

export default [
  {
    files: ["**/*.ts"],
    languageOptions: { parser },
    // Maximum 0, so every unit is over the limit and every unit is reported.
    rules: { complexity: ["warn", 0] },
  },
  {
    files: ["**/*.tsx"],
    languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { complexity: ["warn", 0] },
  },
  {
    // ESLint's default parser, espree, so JS parity is checked against the
    // parser a plain JS project would use.
    files: ["**/*.{js,mjs,cjs,jsx}"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { complexity: ["warn", 0] },
  },
]
`

/**
 * What ESLint says, per absolute file path, as a sorted multiset.
 *
 * `cwd` must contain every file: ESLint 10 refuses anything above its base path
 * with "File ignored because outside of base path", arriving as a warning with a
 * null rule, so an empty report reads as "no complexity" instead of an error.
 */
const askOracle = async (configDir: string, files: string[], cwd: string) => {
  const configPath = join(configDir, "oracle.config.mjs")
  writeFileSync(configPath, ORACLE_CONFIG, "utf8")

  const proc = Bun.spawn(
    [
      join(PACKAGE_ROOT, "node_modules", ".bin", "eslint"),
      "--config",
      configPath,
      "--no-config-lookup",
      "--format",
      "json",
      ...files,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" }
  )

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  if (!stdout.startsWith("[")) {
    throw new Error(`eslint produced no report: ${stderr || stdout}`)
  }

  const results = JSON.parse(stdout) as LintResult[]

  const ignored = results.filter((result) =>
    result.messages.some((message) => message.message.includes("File ignored"))
  )

  if (ignored.length > 0) {
    throw new Error(
      `eslint ignored ${ignored.length} file(s): ${ignored[0]?.messages[0]?.message}`
    )
  }

  return new Map(
    results.map((result): [string, number[]] => [
      result.filePath,
      result.messages
        .filter((message) => message.ruleId === "complexity")
        .map((message) => Number(REPORTED.exec(message.message)?.[1] ?? NaN))
        .toSorted((a, b) => a - b),
    ])
  )
}

/** What `analyze` says for the same file, in the same shape. */
const ours = (path: string, source: string): number[] =>
  analyze(path, source, ts)
    .units.map((unit) => unit.complexity)
    .toSorted((a, b) => a - b)

/**
 * One fixture per decision point, plus the shapes that broke earlier drafts.
 * Keep them small: a disagreement has to point at one construct.
 */
const FIXTURES: Record<string, string> = {
  "branches.ts": `
    export const branches = (a: number, list: number[]) => {
      if (a > 1) { return 1 }
      for (const n of list) { if (n) { return n } }
      while (a > 0) { a -= 1 }
      do { a += 1 } while (a < 3)
      for (const k in list) { void k }
      for (let i = 0; i < a; i += 1) { void i }
      return 0
    }
  `,
  "switch.ts": `
    export const pick = (a: string) => {
      switch (a) {
        case "one": return 1
        case "two": return 2
        default: return 0
      }
    }
  `,
  "try.ts": `
    export const guarded = () => {
      try { return 1 } finally { void 0 }
    }
    export const caught = () => {
      try { return 1 } catch { return 2 }
    }
  `,
  "logical.ts": `
    export const ops = (a: number, b: number) => a && b || a ?? b
    export const assigns = (o: { v?: number }) => {
      o.v ??= 1
      o.v ||= 2
      o.v &&= 3
      return o.v
    }
  `,
  "ternary.ts": `
    export const nested = (a: number) => (a > 2 ? (a > 4 ? "big" : "mid") : "small")
  `,
  "optional.ts": `
    interface Deep { b?: { c?: () => number[] } }
    export const reach = (d?: Deep) => d?.b?.c?.()?.[0]
  `,
  "defaults.ts": `
    export const withDefaults = (a = 1, { b = 2 }: { b?: number } = {}) => a + b
  `,
  "class.ts": `
    export class Boot {
      private ready = false
      public init = async (hard = false) => {
        if (hard) { this.ready = true }
        return this.ready
      }
      public get state() { return this.ready ? "up" : "down" }
      public set state(next: string) { this.ready = next === "up" }
      constructor(flag?: boolean) { this.ready = flag ?? false }
      public static from(flag?: boolean) { return new Boot(flag) }
      static { void 0 }
    }
  `,
  "nested.ts": `
    export function outer(list: number[]) {
      const inner = (a = 1) => (a ? 1 : 2)
      return list.map((n) => (n > 0 && n < 10 ? inner(n) : 0))
    }
  `,
  "generators.ts": `
    export async function* stream(list: number[]) {
      for (const n of list) { if (n) { yield n } }
    }
    export const iife = (function () { return 1 })()
  `,
  "object.ts": `
    export const handlers = {
      onTick(a?: number) { return a ?? 0 },
      onStop: (a = 1) => (a ? 1 : 2),
      get value() { return 1 },
    }
  `,
  "jsx.tsx": `
    export const Row = ({ label = "x" }: { label?: string }) =>
      label ? <span>{label}</span> : null
  `,
  "plain.js": `
    export function plain(a, b = 1) {
      if (a && b) { return a ?? b }
      return a?.c ? 1 : 2
    }
  `,
  "view.jsx": `
    export const View = ({ items = [] }) =>
      items.length > 0 ? <ul>{items.map((i) => i && <li>{i}</li>)}</ul> : null
  `,
}

describe("analyze — parity with the ESLint complexity rule", () => {
  it("agrees with ESLint on every decision point", async () => {
    // Real path, not the symlink: macOS `/var` is `/private/var`, and ESLint
    // compares the resolved base path against the resolved file paths.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "complexity-oracle-")))
    const paths = Object.entries(FIXTURES).map(([name, source]) => {
      const path = join(dir, name)
      writeFileSync(path, source, "utf8")

      return path
    })

    const oracle = await askOracle(dir, paths, dir)

    for (const path of paths) {
      const source = readFileSync(path, "utf8")

      expect({ [path]: ours(path, source) }).toEqual({
        [path]: oracle.get(path) ?? [],
      })
    }
  }, 60_000)
})

/**
 * The same comparison against a real repository. Opt-in: ESLint needs a few
 * seconds per hundred files, which is too slow for every `bun test` run.
 *
 * `CRAP_CHECK_ORACLE_REPO=/path/to/repo` lints the TypeScript files that
 * repository tracks. `CRAP_CHECK_ORACLE_SAMPLE=N` keeps one file in N (default 8).
 */
const ORACLE_REPO = process.env.CRAP_CHECK_ORACLE_REPO

describe("analyze — parity on real files", () => {
  it.skipIf(ORACLE_REPO === undefined)(
    "agrees with ESLint on a sample of a repository",
    async () => {
      const root = realpathSync(ORACLE_REPO ?? ".")
      const listed = spawnSync("git", ["ls-files"], {
        cwd: root,
        encoding: "utf8",
      })
      const every = Math.max(
        1,
        Number(process.env.CRAP_CHECK_ORACLE_SAMPLE ?? 8) || 8
      )
      const { isMeasured } = createScope(
        { ...DEFAULT_CONFIG, extensions: [".ts", ".tsx"] },
        []
      )
      const sample = listed.stdout
        .split("\n")
        .filter(isMeasured)
        .filter((_, index) => index % every === 0)
        .map((path) => join(root, path))

      expect(sample.length).toBeGreaterThan(0)

      const dir = realpathSync(
        mkdtempSync(join(tmpdir(), "crap-check-oracle-"))
      )
      const oracle = await askOracle(dir, sample, root)
      const differing: string[] = []

      for (const path of sample) {
        const mine = ours(path, readFileSync(path, "utf8"))
        const theirs = oracle.get(path) ?? []

        if (mine.join(",") !== theirs.join(",")) {
          differing.push(`${path}\n  ours:   ${mine}\n  eslint: ${theirs}`)
        }
      }

      expect(differing).toEqual([])
    },
    600_000
  )
})

describe("ORACLE", () => {
  it("names the ESLint version this spec runs against", () => {
    expect(ORACLE).toBe(`eslint@${pkg.devDependencies.eslint} complexity`)
  })
})
