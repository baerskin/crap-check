import { describe, expect, it } from "bun:test"
import { DEFAULT_CONFIG } from "../src/lib/config"
import { createScope } from "../src/lib/include"
import { mergeCoverage, parseLcov, type FileCoverage } from "../src/lib/lcov"

/**
 * The fixtures are the shape Bun 1.4.2 writes, measured by running
 * `bun test --coverage --coverage-reporter=lcov` in a workspace directory:
 * `TN:`, `SF:`, the `FNF:`/`FNH:` counts, the `DA:` lines, `LF:`/`LH:`, then
 * `end_of_record`. No `FN:`, no `FNDA:`, no `BRDA:`, and an `SF:` path relative
 * to the directory the command ran in. Keep them that way, because the parser exists to read that subset.
 */

const ROOT = "/repo"

const record = (path: string, lines: [number, number][]): string =>
  [
    "TN:",
    `SF:${path}`,
    "FNF:2",
    "FNH:1",
    ...lines.map(([line, hits]) => `DA:${line},${hits}`),
    `LF:${lines.length}`,
    `LH:${lines.filter(([, hits]) => hits > 0).length}`,
    "end_of_record",
  ].join("\n")

const { isMeasured } = createScope(DEFAULT_CONFIG, [])

const parse = (text: string, cwd = "packages/collection-filters") =>
  parseLcov({ text, cwd, repoRoot: ROOT, isMeasured })

describe("parseLcov", () => {
  it("resolves a relative SF path against the run directory", () => {
    const [file] = parse(
      record("src/selectors.ts", [
        [36, 1],
        [37, 0],
      ])
    )

    expect(file?.path).toBe("packages/collection-filters/src/selectors.ts")
  })

  it("keeps every DA line with its hit count", () => {
    const [file] = parse(
      record("src/selectors.ts", [
        [36, 4],
        [40, 0],
      ])
    )

    expect([...(file?.hits ?? [])]).toEqual([
      [36, 4],
      [40, 0],
    ])
  })

  it("reads an absolute SF path as written", () => {
    const [file] = parse(record("/repo/apps/owl/src/a.ts", [[1, 1]]))

    expect(file?.path).toBe("apps/owl/src/a.ts")
  })

  it("resolves a path that climbs out of the run directory", () => {
    const [file] = parse(record("../utils/src/dates.ts", [[1, 1]]))

    expect(file?.path).toBe("packages/utils/src/dates.ts")
  })

  it("drops a path outside the repository", () => {
    expect(parse(record("../../../elsewhere/a.ts", [[1, 1]]))).toEqual([])
  })

  it("drops a file the complexity metric excludes", () => {
    expect(parse(record("src/generated/types.ts", [[1, 1]]))).toEqual([])
    expect(parse(record("src/a.d.ts", [[1, 1]]))).toEqual([])
  })

  it("reads every record in one report", () => {
    const text = [
      record("src/a.ts", [[1, 1]]),
      record("src/b.ts", [[2, 0]]),
    ].join("\n")

    expect(parse(text).map((file) => file.path)).toEqual([
      "packages/collection-filters/src/a.ts",
      "packages/collection-filters/src/b.ts",
    ])
  })

  it("ignores a record with no end_of_record", () => {
    const text = ["TN:", "SF:src/a.ts", "DA:1,1"].join("\n")

    expect(parse(text)).toEqual([])
  })

  it("resolves paths against the root for a root-level run", () => {
    const [file] = parse(record("packages/a/src/x.ts", [[1, 1]]), ".")

    expect(file?.path).toBe("packages/a/src/x.ts")
  })

  it("reads an empty report as no coverage", () => {
    expect(parse("")).toEqual([])
  })
})

describe("mergeCoverage", () => {
  const coverage = (path: string, hits: [number, number][]): FileCoverage => ({
    path,
    hits: new Map(hits),
  })

  it("sums the hits two suites report for one shared file", () => {
    const merged = mergeCoverage([
      coverage("packages/utils/src/a.ts", [
        [1, 2],
        [2, 0],
      ]),
      coverage("packages/utils/src/a.ts", [
        [1, 3],
        [2, 5],
      ]),
    ])

    expect([...(merged.get("packages/utils/src/a.ts") ?? [])]).toEqual([
      [1, 5],
      [2, 5],
    ])
  })

  it("keeps a line uncovered when no suite ran it", () => {
    const merged = mergeCoverage([
      coverage("packages/utils/src/a.ts", [[9, 0]]),
      coverage("packages/utils/src/a.ts", [[9, 0]]),
    ])

    expect(merged.get("packages/utils/src/a.ts")?.get(9)).toBe(0)
  })

  it("keeps files from different suites apart", () => {
    const merged = mergeCoverage([
      coverage("apps/owl/src/a.ts", [[1, 1]]),
      coverage("apps/coin/src/b.ts", [[1, 1]]),
    ])

    expect([...merged.keys()].toSorted()).toEqual([
      "apps/coin/src/b.ts",
      "apps/owl/src/a.ts",
    ])
  })
})
