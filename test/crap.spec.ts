import { describe, expect, it } from "bun:test"
import type { FileComplexity, Unit } from "../src/lib/analyze"
import {
  CRAP_THRESHOLD,
  crapByWorkspace,
  crapOf,
  isPartialRun,
  MIN_LINES,
  runCovers,
  scoreFiles,
  uncoveredFraction,
  unmeasuredReason,
} from "../src/lib/crap"
import type {
  CoverageIndex,
  CoverageManifest,
  CoverageRun,
} from "../src/lib/lcov"

/** A unit 20 lines long by default, so the ND1609 length filter lets it through. */
const unit = ({
  name = "f",
  line = 1,
  endLine = 20,
  complexity = 10,
  cognitive = 0,
}: Partial<Unit> = {}): Unit => ({
  name,
  kind: "function",
  line,
  endLine,
  complexity,
  cognitive,
  owner: -1,
})

const file = ({
  path = "apps/owl/src/a.ts",
  units = [unit()],
}: {
  path?: string
  units?: Unit[]
} = {}): FileComplexity => ({
  path,
  workspace: path.split("/").slice(0, 2).join("/"),
  isTest: false,
  lines: 100,
  units,
  moduleComplexity: 0,
  total: units.reduce((sum, one) => sum + one.complexity, 0),
  max: units.reduce((worst, one) => Math.max(worst, one.complexity), 0),
  cognitiveModule: 0,
  cognitiveTotal: 0,
  cognitiveMax: 0,
})

const manifestOf = (runs: Partial<CoverageRun>[]): CoverageManifest => ({
  generatedAt: "2026-09-19T00:00:00.000Z",
  commit: "abc",
  restricted: false,
  runs: runs.map((run): CoverageRun => ({
    cwd: "apps/owl",
    status: "ok",
    exitCode: 0,
    lcov: "coverage/apps-owl/lcov.info",
    durationMs: 1,
    ...run,
  })),
})

const index = (entries: [string, [number, number][]][]): CoverageIndex =>
  new Map(entries.map(([path, hits]) => [path, new Map(hits)]))

describe("crapOf", () => {
  it("collapses to the cyclomatic score at full coverage", () => {
    expect(crapOf(30, 0)).toBe(30)
  })

  it("is CC squared plus CC at no coverage", () => {
    expect(crapOf(15, 1)).toBe(240)
  })

  it("puts the repo's worst function where the article says it lands", () => {
    // StockService.syncPinStock, apps/owl/src/services/stockService.ts, CC 164.
    expect(crapOf(164, 1)).toBe(27_060)
    expect(Math.round(crapOf(164, 0.1))).toBe(191)
  })

  it("agrees with the threshold table the rule publishes", () => {
    // A function at CC 10 needs 42% coverage to stay under 30.
    expect(crapOf(10, 0.59)).toBeGreaterThan(CRAP_THRESHOLD)
    expect(crapOf(10, 0.58)).toBeLessThan(CRAP_THRESHOLD)
  })

  it("leaves a function over 30 flagged at any coverage", () => {
    expect(crapOf(31, 0)).toBeGreaterThan(CRAP_THRESHOLD)
  })
})

describe("uncoveredFraction", () => {
  const hits = new Map([
    [10, 1],
    [11, 0],
    [12, 0],
    [13, 4],
    [50, 0],
  ])

  it("counts only the lines inside the range", () => {
    expect(uncoveredFraction({ hits, line: 10, endLine: 13 })).toBe(0.5)
  })

  it("ignores lines lcov never reported", () => {
    // 14 to 20 hold no DA record, so they neither cover nor dilute.
    expect(uncoveredFraction({ hits, line: 10, endLine: 20 })).toBe(0.5)
  })

  it("reads a range with no executable line as covered", () => {
    expect(uncoveredFraction({ hits, line: 30, endLine: 40 })).toBe(0)
  })

  it("reads a range no test ran as fully uncovered", () => {
    expect(uncoveredFraction({ hits, line: 50, endLine: 50 })).toBe(1)
  })
})

describe("scoreFiles", () => {
  it("scores a covered function from its own line range", () => {
    const { scores, totals } = scoreFiles({
      files: [file()],
      coverage: index([
        [
          "apps/owl/src/a.ts",
          [
            [2, 1],
            [3, 0],
            [4, 0],
            [5, 0],
          ],
        ],
      ]),
      manifest: manifestOf([{}]),
    })

    expect(scores[0]?.uncovered).toBe(0.75)
    // Stored to 2dp, so the artifact stays diffable week to week.
    expect(scores[0]?.crap).toBe(52.19)
    expect(totals.scored).toBe(1)
    expect(totals.over30).toBe(1)
  })

  it("scores a file the suite never imported as fully uncovered", () => {
    const { scores, totals } = scoreFiles({
      files: [file()],
      coverage: index([]),
      manifest: manifestOf([{}]),
    })

    expect(scores[0]?.uncovered).toBe(1)
    expect(totals.untested).toBe(1)
    expect(totals.unmeasured).toBe(0)
  })

  it("never reads an unmeasured workspace as an uncovered one", () => {
    const { scores, totals } = scoreFiles({
      files: [file({ path: "infra/workers/src/a.ts" })],
      coverage: index([]),
      manifest: manifestOf([{}]),
    })

    expect(scores).toEqual([])
    expect(totals.unmeasured).toBe(1)
    expect(totals.scored).toBe(0)
    expect(totals.untested).toBe(0)
  })

  it("excludes a workspace whose suite failed", () => {
    const { totals } = scoreFiles({
      files: [file()],
      coverage: index([]),
      manifest: manifestOf([{ status: "failed", exitCode: 1 }]),
    })

    expect(totals.unmeasured).toBe(1)
    expect(totals.scored).toBe(0)
  })

  it("does not score a function of ten lines or fewer", () => {
    const { totals } = scoreFiles({
      files: [file({ units: [unit({ line: 1, endLine: MIN_LINES })] })],
      coverage: index([]),
      manifest: manifestOf([{}]),
    })

    expect(totals.short).toBe(1)
    expect(totals.scored).toBe(0)
  })

  it("scores a function one line longer than the filter", () => {
    const { totals } = scoreFiles({
      files: [file({ units: [unit({ line: 1, endLine: MIN_LINES + 1 })] })],
      coverage: index([]),
      manifest: manifestOf([{}]),
    })

    expect(totals.short).toBe(0)
    expect(totals.scored).toBe(1)
  })

  it("ranks the worst function first", () => {
    const { scores } = scoreFiles({
      files: [
        file({
          units: [
            unit({ name: "small", complexity: 4 }),
            unit({ name: "big", complexity: 40 }),
          ],
        }),
      ],
      coverage: index([]),
      manifest: manifestOf([{}]),
    })

    expect(scores.map((score) => score.name)).toEqual(["big", "small"])
  })

  it("scores a package file an application suite covered", () => {
    const { scores, totals } = scoreFiles({
      files: [file({ path: "packages/sun-client/src/a.ts" })],
      coverage: index([
        [
          "packages/sun-client/src/a.ts",
          [
            [5, 1],
            [6, 1],
          ],
        ],
      ]),
      manifest: manifestOf([{}]),
    })

    expect(totals.unmeasured).toBe(0)
    expect(totals.scored).toBe(1)
    expect(scores[0]?.uncovered).toBe(0)
  })

  it("leaves a hitless file of the same package unmeasured", () => {
    const { totals, skipped } = scoreFiles({
      files: [
        file({ path: "packages/sun-client/src/a.ts" }),
        file({ path: "packages/sun-client/src/b.ts" }),
      ],
      coverage: index([["packages/sun-client/src/a.ts", [[5, 1]]]]),
      manifest: manifestOf([{}]),
    })

    expect(totals.scored).toBe(1)
    expect(totals.unmeasured).toBe(1)
    expect(skipped.get("packages/sun-client")?.unmeasured).toBe(1)
  })

  it("averages over scored functions alone", () => {
    const { totals } = scoreFiles({
      files: [
        file({ units: [unit({ complexity: 10 })] }),
        file({ path: "infra/gvc/src/b.ts" }),
      ],
      coverage: index([]),
      manifest: manifestOf([{}]),
    })

    expect(totals.scored).toBe(1)
    expect(totals.avg).toBe(110)
  })
})

describe("unmeasuredReason", () => {
  it("names the directory and exit code of a failed command", () => {
    expect(
      unmeasuredReason(
        manifestOf([{ cwd: "apps/coin", status: "failed", exitCode: 1 }]),
        "apps/coin"
      )
    ).toBe("coverage command in apps/coin exited 1")
  })

  it("names a run that wrote no report", () => {
    expect(
      unmeasuredReason(
        manifestOf([{ cwd: "apps/dam", status: "no-lcov" }]),
        "apps/dam"
      )
    ).toBe("coverage command wrote no lcov report")
  })

  it("names a workspace no command covers", () => {
    expect(unmeasuredReason(manifestOf([{}]), "apps/coin")).toBe(
      "no coverage command covers this workspace"
    )
  })

  it("says nothing about a workspace an ok run covers", () => {
    expect(unmeasuredReason(manifestOf([{}]), "apps/owl")).toBeUndefined()
  })

  it("lets an ok run outrank a failed one over the same workspace", () => {
    const manifest = manifestOf([
      { cwd: ".", status: "failed", exitCode: 1 },
      { cwd: "apps/owl" },
    ])

    expect(unmeasuredReason(manifest, "apps/owl")).toBeUndefined()
    expect(unmeasuredReason(manifest, "apps/coin")).toBe(
      "coverage command in . exited 1"
    )
  })
})

describe("runCovers", () => {
  it("covers every workspace from the root", () => {
    expect(runCovers(".", "packages/a")).toBe(true)
    expect(runCovers(".", "<root>")).toBe(true)
  })

  it("covers the directory and what sits below it, not a sibling prefix", () => {
    expect(runCovers("packages/a", "packages/a")).toBe(true)
    expect(runCovers("packages", "packages/a")).toBe(true)
    expect(runCovers("packages/a", "packages/ab")).toBe(false)
  })
})

describe("isPartialRun", () => {
  it("reads a full run of passing suites as complete", () => {
    expect(isPartialRun(manifestOf([{}]))).toBe(false)
  })

  it("reads a failed suite as partial", () => {
    expect(isPartialRun(manifestOf([{ status: "failed", exitCode: 1 }]))).toBe(
      true
    )
  })

  it("reads a restricted run as partial even when every suite passed", () => {
    expect(isPartialRun({ ...manifestOf([{}]), restricted: true })).toBe(true)
  })
})

describe("crapByWorkspace", () => {
  it("splits the scores by workspace", () => {
    const { scores } = scoreFiles({
      files: [
        file({ path: "apps/owl/src/a.ts" }),
        file({ path: "apps/coin/src/b.ts" }),
      ],
      coverage: index([]),
      manifest: manifestOf([{ cwd: "apps/owl" }, { cwd: "apps/coin" }]),
    })

    const byWorkspace = crapByWorkspace({ scores, skipped: new Map() })

    expect(Object.keys(byWorkspace)).toEqual(["apps/coin", "apps/owl"])
    expect(byWorkspace["apps/owl"]?.scored).toBe(1)
  })

  it("keeps a workspace that scored nothing but holds functions", () => {
    const byWorkspace = crapByWorkspace({
      scores: [],
      skipped: new Map([["infra/gvc", { unmeasured: 12, short: 0 }]]),
    })

    expect(byWorkspace["infra/gvc"]).toEqual({
      scored: 0,
      unmeasured: 12,
      short: 0,
      over30: 0,
      untested: 0,
      total: 0,
      avg: 0,
      worst: 0,
    })
  })
})
