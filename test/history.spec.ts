import { afterAll, describe, expect, it } from "bun:test"
import ts from "typescript"
import { summarize, totalsOf } from "../src/lib/aggregate"
import { DEFAULT_CONFIG } from "../src/lib/config"
import {
  changedPaths,
  measureCommit,
  mergeWeeks,
  type BlobCache,
} from "../src/lib/history"
import { createScope } from "../src/lib/include"
import { measureWorkingTree } from "../src/lib/measure"
import { createFixture } from "./fixture"

describe("mergeWeeks", () => {
  it("keeps old rows, replaces a repeated week and sorts oldest first", () => {
    const merged = mergeWeeks(
      [
        { week: "2026-W02", value: "old" },
        { week: "2026-W01", value: "keep" },
      ],
      [{ week: "2026-W02", value: "new" }]
    )

    expect(merged).toEqual([
      { week: "2026-W01", value: "keep" },
      { week: "2026-W02", value: "new" },
    ])
  })
})

describe("measureCommit", () => {
  const fixture = createFixture()

  fixture.commit({
    files: {
      "package.json": "{}\n",
      "packages/a/package.json": "{}\n",
      "packages/a/src/index.ts":
        "export const pick = (a: number) => (a > 1 ? a : a < 0 ? -a : 0)\n",
      "packages/a/src/index.spec.ts": "if (true) { console.log(1) }\n",
      "src/main.js": "export function f(x) { if (x) { return 1 } return 2 }\n",
      "dist/out.js": "if (a) { b() }\n",
    },
    message: "first",
    at: "2026-01-05T09:00:00Z",
  })

  afterAll(fixture.remove)

  it("measures HEAD to the same numbers as the files on disk", async () => {
    // The history path and the snapshot path must agree, or the last row of the
    // series and a fresh measurement would disagree for no visible reason.
    const fromGit = await measureCommit({
      root: fixture.dir,
      commit: "HEAD",
      ts,
      cache: new Map(),
      config: DEFAULT_CONFIG,
    })
    const fromDisk = await measureWorkingTree({
      root: fixture.dir,
      ts,
      config: DEFAULT_CONFIG,
    })

    expect(fromGit.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual(
      fromDisk.map(summarize).toSorted((a, b) => a.path.localeCompare(b.path))
    )
    expect(totalsOf(fromGit).files).toBe(3)
    expect(fromGit.map((file) => file.path)).not.toContain("dist/out.js")
  })

  it("reuses the cache across commits instead of re-reading a blob", async () => {
    const cache: BlobCache = new Map()
    const measure = () =>
      measureCommit({
        root: fixture.dir,
        commit: "HEAD",
        ts,
        cache,
        config: DEFAULT_CONFIG,
      })

    await measure()
    const afterFirst = cache.size

    await measure()

    expect(cache.size).toBe(afterFirst)
    expect(afterFirst).toBe(3)
  })
})

describe("changedPaths", () => {
  const scope = createScope(DEFAULT_CONFIG, [])

  /** `-z` ends every field with a NUL, including the last. */
  const nameStatus = (...fields: string[]): string => `${fields.join("\0")}\0`

  it("reads one path per plain status", () => {
    const changed = changedPaths(
      nameStatus("M", "apps/owl/src/a.ts", "A", "apps/owl/src/b.ts"),
      scope
    )

    expect(changed.base).toEqual(["apps/owl/src/a.ts", "apps/owl/src/b.ts"])
    expect(changed.head).toEqual(changed.base)
    expect(changed.renames.size).toBe(0)
  })

  it("keeps both halves of a rename", () => {
    const changed = changedPaths(
      nameStatus("R097", "apps/owl/src/old.ts", "apps/owl/src/new.ts"),
      scope
    )

    expect(changed.base).toEqual(["apps/owl/src/old.ts"])
    expect(changed.head).toEqual(["apps/owl/src/new.ts"])
    expect(changed.renames.get("apps/owl/src/old.ts")).toBe(
      "apps/owl/src/new.ts"
    )
  })

  it("does not lose the entry that follows a rename", () => {
    const changed = changedPaths(
      nameStatus(
        "R100",
        "apps/owl/src/old.ts",
        "apps/owl/src/new.ts",
        "M",
        "apps/owl/src/after.ts"
      ),
      scope
    )

    expect(changed.head).toEqual([
      "apps/owl/src/new.ts",
      "apps/owl/src/after.ts",
    ])
  })

  it("drops a path the complexity metric does not measure", () => {
    const changed = changedPaths(
      nameStatus(
        "M",
        "apps/owl/README.md",
        "M",
        "apps/owl/src/__tests__/a.spec.ts",
        "M",
        "apps/owl/src/a.ts"
      ),
      scope
    )

    expect(changed.head).toEqual(["apps/owl/src/a.ts"])
  })

  it("reads an empty diff as no paths", () => {
    expect(changedPaths("", scope)).toEqual({
      base: [],
      head: [],
      renames: new Map(),
    })
  })
})
