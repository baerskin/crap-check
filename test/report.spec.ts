import { describe, expect, it } from "bun:test"
import type { Diff, FileDelta, Totals, UnitDelta } from "../src/lib/aggregate"
import { EMPTY_TOTALS } from "../src/lib/aggregate"
import { markdownReport, MARKER } from "../src/lib/report"

const totals = (over: Partial<Totals> = {}): Totals => ({
  ...EMPTY_TOTALS,
  ...over,
})

/** A changed file, with the cognitive side defaulting to the cyclomatic one. */
const changedFile = (over: Partial<FileDelta> = {}): FileDelta => ({
  path: "apps/owl/a.ts",
  isTest: false,
  base: 1,
  head: 9,
  delta: 8,
  cognitiveBase: 1,
  cognitiveHead: 9,
  cognitiveDelta: 8,
  ...over,
})

const diff = ({
  base = 100,
  head = 142,
  testBase = 10,
  testHead = 18,
  cogBase = 60,
  cogHead = 95,
  files = [],
}: {
  base?: number
  head?: number
  testBase?: number
  testHead?: number
  cogBase?: number
  cogHead?: number
  files?: FileDelta[]
} = {}): Diff => ({
  source: {
    base: totals({
      complexity: base,
      functions: 20,
      over10: 2,
      cognitive: cogBase,
      cogOver15: 1,
      cognitiveMaxFunction: 30,
    }),
    head: totals({
      complexity: head,
      functions: 22,
      over10: 3,
      cognitive: cogHead,
      cogOver15: 4,
      cognitiveMaxFunction: 41,
    }),
  },
  test: {
    base: totals({ complexity: testBase }),
    head: totals({ complexity: testHead }),
  },
  files,
})

/** A function that got worse, defaulting past the threshold so it is reported. */
const changedUnit = (over: Partial<UnitDelta> = {}): UnitDelta => ({
  path: "apps/owl/src/stock.ts",
  name: "StockService.sync",
  line: 922,
  base: 12,
  head: 25,
  delta: 13,
  cognitiveBase: 10,
  cognitiveHead: 30,
  ...over,
})

describe("markdownReport", () => {
  it("opens with the marker the workflow looks the comment up by", () => {
    expect(markdownReport(diff()).startsWith(`${MARKER}\n`)).toBe(true)
  })

  it("signs the delta and states the percentage", () => {
    const report = markdownReport(diff())

    expect(report).toContain("### Complexity +42")
    expect(report).toContain("100 -> 142 (+42.00%)")
    expect(report).toContain("| cyclomatic | 100 | 142 | **+42** |")
  })

  it("signs a removal too", () => {
    expect(markdownReport(diff({ base: 142, head: 100 }))).toContain(
      "### Complexity -42"
    )
  })

  it("says so plainly when nothing moved", () => {
    expect(markdownReport(diff({ base: 100, head: 100 }))).toContain(
      "### Complexity no change"
    )
  })

  it("reads 'new' rather than dividing by zero on an empty base", () => {
    expect(markdownReport(diff({ base: 0, head: 12 }))).toContain("(new)")
  })

  it("names changed source files and leaves test files out of that table", () => {
    const report = markdownReport(
      diff({
        files: [
          changedFile(),
          changedFile({ path: "apps/owl/a.spec.ts", isTest: true }),
        ],
      })
    )

    expect(report).toContain("`apps/owl/a.ts`")
    expect(report).not.toContain("`apps/owl/a.spec.ts`")
    expect(report).toContain("(1 changed)")
  })

  it("gives cognitive the same four rows cyclomatic gets", () => {
    const report = markdownReport(diff())

    expect(report).toContain("| cognitive | 60 | 95 | +35 |")
    expect(report).toContain("| cognitive over 15 | 1 | 4 | +3 |")
    expect(report).toContain("| worst cognitive function | 30 | 41 | +11 |")
    expect(report).toContain("| cyclomatic over 10 | 2 | 3 | +1 |")
    expect(report).toContain("| worst cyclomatic function | 0 | 0 | 0 |")
    // The headline stays cyclomatic: one metric leads, the other informs.
    expect(report).toContain("### Complexity +42")
  })

  it("puts both metrics in the changed-file table", () => {
    const report = markdownReport(
      diff({
        files: [
          changedFile({
            delta: 8,
            head: 9,
            cognitiveDelta: -4,
            cognitiveHead: 2,
          }),
        ],
      })
    )

    expect(report).toContain(
      "| file | cyclomatic delta | cyclomatic | cognitive delta | cognitive |"
    )
    expect(report).toContain("| `apps/owl/a.ts` | +8 | 9 | -4 | 2 |")
  })

  it("shows cognitive moving when cyclomatic does not, which is the point", () => {
    // Same decision count, nested one level deeper. Cyclomatic cannot see it.
    const report = markdownReport(
      diff({ base: 100, head: 100, cogBase: 60, cogHead: 80 })
    )

    expect(report).toContain("### Complexity no change")
    expect(report).toContain("| cognitive | 60 | 80 | +20 |")
  })

  it("keeps the test movement visible but apart", () => {
    expect(markdownReport(diff())).toContain("_Test files: +8, counted apart._")
  })

  it("drops the file table when no source file moved", () => {
    expect(markdownReport(diff())).not.toContain("| file | cyclomatic delta |")
  })

  it("prints the over-50 band, which the totals have always carried", () => {
    const report = markdownReport(diff())

    expect(report).toContain("| cyclomatic over 50 | 0 | 0 | 0 |")
  })

  it("names a function that got worse inside a file that did not", () => {
    // The whole reason the section exists: the file nets to zero, the function
    // went 12 to 25, and the per-file table cannot say so.
    const report = markdownReport(diff({ base: 100, head: 100 }), [
      changedUnit(),
    ])

    expect(report).toContain("### Complexity no change")
    expect(report).toContain("**Functions that got worse** (1 above 10)")
    expect(report).toContain(
      "| `apps/owl/src/stock.ts:922` `StockService.sync` | 12 | 25 | **+13** |"
    )
  })

  it("reads a new function as new rather than as a base of zero", () => {
    const report = markdownReport(diff(), [
      changedUnit({ base: 0, head: 30, delta: 30 }),
    ])

    expect(report).toContain("| 30 | **+30** |")
    expect(report).toContain("`StockService.sync` | new |")
  })

  it("leaves out a function that got worse and is still small", () => {
    expect(
      markdownReport(diff(), [changedUnit({ base: 2, head: 9, delta: 7 })])
    ).not.toContain("Functions that got worse")
  })

  it("leaves out a function that improved", () => {
    expect(
      markdownReport(diff(), [changedUnit({ base: 25, head: 12, delta: -13 })])
    ).not.toContain("Functions that got worse")
  })

  it("drops the section when no function moved", () => {
    expect(markdownReport(diff())).not.toContain("Functions that got worse")
  })
})
