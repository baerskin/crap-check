import { describe, expect, it } from "bun:test"
import type { FileComplexity, Unit } from "../src/lib/analyze"
import {
  byWorkspace,
  byWorkspaceMetric,
  diffOf,
  EMPTY_TOTALS,
  hotspots,
  summarize,
  totalsOf,
  unitDiffOf,
  worsened,
  type FileSummary,
  type UnitSample,
} from "../src/lib/aggregate"

/**
 * A file built from unit scores alone: the rest is noise for this maths.
 *
 * `cognitive` is positional against `units`, and every unit here is top level,
 * so the file's cognitive total is a plain sum. Leave it out and the fixture
 * scores 0, which keeps the cyclomatic cases readable.
 */
const file = ({
  path = "apps/owl/src/a.ts",
  units = [1],
  cognitive = [],
  moduleComplexity = 0,
  lines = 10,
  isTest = false,
}: {
  path?: string
  units?: number[]
  cognitive?: number[]
  moduleComplexity?: number
  lines?: number
  isTest?: boolean
} = {}): FileComplexity => {
  const built: Unit[] = units.map((complexity, index) => ({
    name: `f${index}`,
    kind: "function",
    line: index + 1,
    endLine: index + 1,
    complexity,
    cognitive: cognitive[index] ?? 0,
    owner: -1,
  }))

  const add = (a: number, b: number): number => a + b

  return {
    path,
    workspace: path.split("/").slice(0, 2).join("/"),
    isTest,
    lines,
    units: built,
    moduleComplexity,
    total: units.reduce(add, 0) + moduleComplexity,
    max: units.reduce((worst, value) => Math.max(worst, value), 0),
    cognitiveModule: 0,
    cognitiveTotal: built.map((unit) => unit.cognitive).reduce(add, 0),
    cognitiveMax: built.reduce(
      (worst, unit) => Math.max(worst, unit.cognitive),
      0
    ),
  }
}

/** The same fixture reduced, which is what every roll-up but `hotspots` takes. */
const sum = (...args: Parameters<typeof file>): FileSummary =>
  summarize(file(...args))

describe("totalsOf", () => {
  it("returns zeroes for no files", () => {
    expect(totalsOf([])).toEqual(EMPTY_TOTALS)
  })

  it("sums complexity, lines and units across files", () => {
    const totals = totalsOf([
      sum({ units: [1, 2], lines: 10 }),
      sum({ path: "apps/coin/src/b.ts", units: [3], lines: 5 }),
    ])

    expect(totals).toMatchObject({
      files: 2,
      functions: 3,
      complexity: 6,
      lines: 15,
      maxFunction: 3,
    })
  })

  it("keeps module-scope complexity in the total but out of the average", () => {
    // One unit of 3 and one module-scope decision point.
    const totals = totalsOf([sum({ units: [3], moduleComplexity: 1 })])

    expect(totals.complexity).toBe(4)
    expect(totals.functions).toBe(1)
    expect(totals.maxFunction).toBe(3)
  })

  it("rounds the average to two places", () => {
    expect(totalsOf([sum({ units: [1, 1, 2] })]).avgPerFunction).toBe(1.33)
  })

  it("reports an average of 0 rather than NaN when nothing declares a function", () => {
    expect(totalsOf([sum({ units: [], moduleComplexity: 2 })])).toMatchObject({
      functions: 0,
      complexity: 2,
      avgPerFunction: 0,
    })
  })

  it("counts a threshold strictly: exactly 10 is not over 10", () => {
    const totals = totalsOf([sum({ units: [10, 11, 20, 21, 50, 51] })])

    expect(totals).toMatchObject({ over10: 5, over20: 3, over50: 1 })
  })

  it("sums the cognitive score alongside the cyclomatic one", () => {
    const totals = totalsOf([
      sum({ units: [8, 2], cognitive: [20, 1] }),
      sum({ path: "apps/coin/src/b.ts", units: [3], cognitive: [4] }),
    ])

    expect(totals).toMatchObject({
      complexity: 13,
      cognitive: 25,
      cognitiveMaxFunction: 20,
    })
  })

  it("counts the cognitive threshold strictly too: exactly 15 is not over 15", () => {
    expect(
      totalsOf([sum({ units: [1, 1, 1], cognitive: [14, 15, 16] })]).cogOver15
    ).toBe(1)
  })

  it("ignores a nested unit when counting over 15, to avoid counting it twice", () => {
    const nested = file({ units: [1, 1], cognitive: [40, 40] })

    // The callback's 40 is already inside its owner's 40. One function is over
    // the limit here, not two.
    ;(nested.units[1] as Unit).owner = 0

    expect(totalsOf([summarize(nested)]).cogOver15).toBe(1)
  })
})

describe("byWorkspace", () => {
  it("groups by workspace and sorts the keys", () => {
    const grouped = byWorkspace([
      sum({ path: "packages/utils/src/a.ts", units: [4] }),
      sum({ path: "apps/owl/src/a.ts", units: [1] }),
      sum({ path: "apps/owl/src/b.ts", units: [2] }),
    ])

    expect(Object.keys(grouped)).toEqual(["apps/owl", "packages/utils"])
    expect(grouped["apps/owl"]).toMatchObject({ files: 2, complexity: 3 })
  })

  it("flattens to one integer per workspace for the history series", () => {
    const files = [
      sum({ path: "apps/owl/src/a.ts", units: [1, 2], cognitive: [4, 6] }),
      sum({ path: "apps/coin/src/a.ts", units: [5], cognitive: [9] }),
    ]

    expect(byWorkspaceMetric(files, "complexity")).toEqual({
      "apps/coin": 5,
      "apps/owl": 3,
    })
    expect(byWorkspaceMetric(files, "cognitive")).toEqual({
      "apps/coin": 9,
      "apps/owl": 10,
    })
  })
})

describe("hotspots", () => {
  it("returns the worst units first and caps the list", () => {
    const worst = hotspots(
      [
        file({ path: "apps/owl/src/a.ts", units: [3, 9] }),
        file({ path: "apps/coin/src/b.ts", units: [12] }),
      ],
      2
    )

    expect(worst).toEqual([
      {
        path: "apps/coin/src/b.ts",
        name: "f0",
        line: 1,
        complexity: 12,
        cognitive: 0,
      },
      {
        path: "apps/owl/src/a.ts",
        name: "f1",
        line: 2,
        complexity: 9,
        cognitive: 0,
      },
    ])
  })

  it("carries each unit's cognitive score, so a flat switch is visible", () => {
    const worst = hotspots(
      [file({ path: "apps/owl/src/a.ts", units: [31], cognitive: [1] })],
      1
    )

    // A 30-case switch: high cyclomatic, and nobody struggles to read it.
    expect(worst[0]).toMatchObject({ complexity: 31, cognitive: 1 })
  })

  it("breaks ties on path then line, so the order is stable", () => {
    const worst = hotspots(
      [
        file({ path: "apps/owl/src/b.ts", units: [5] }),
        file({ path: "apps/owl/src/a.ts", units: [5, 5] }),
      ],
      3
    )

    expect(worst.map((spot) => [spot.path, spot.line])).toEqual([
      ["apps/owl/src/a.ts", 1],
      ["apps/owl/src/a.ts", 2],
      ["apps/owl/src/b.ts", 1],
    ])
  })
})

describe("diffOf", () => {
  const base = [
    sum({ path: "apps/owl/src/same.ts", units: [4] }),
    sum({ path: "apps/owl/src/changed.ts", units: [2] }),
    sum({ path: "apps/owl/src/removed.ts", units: [7] }),
    sum({ path: "apps/owl/src/x.spec.ts", units: [1], isTest: true }),
  ]
  const head = [
    sum({ path: "apps/owl/src/same.ts", units: [4] }),
    sum({ path: "apps/owl/src/changed.ts", units: [2, 9], cognitive: [1, 5] }),
    sum({ path: "apps/owl/src/added.ts", units: [3] }),
    sum({ path: "apps/owl/src/x.spec.ts", units: [1, 1], isTest: true }),
  ]

  it("reports added, removed and changed files, and drops the unchanged", () => {
    // Test files stay in the list, flagged, so the report can split them out
    // without a second pass over the file trees.
    expect(diffOf(base, head).files).toEqual([
      {
        path: "apps/owl/src/changed.ts",
        isTest: false,
        base: 2,
        head: 11,
        delta: 9,
        cognitiveBase: 0,
        cognitiveHead: 6,
        cognitiveDelta: 6,
      },
      {
        path: "apps/owl/src/removed.ts",
        isTest: false,
        base: 7,
        head: 0,
        delta: -7,
        cognitiveBase: 0,
        cognitiveHead: 0,
        cognitiveDelta: 0,
      },
      {
        path: "apps/owl/src/added.ts",
        isTest: false,
        base: 0,
        head: 3,
        delta: 3,
        cognitiveBase: 0,
        cognitiveHead: 0,
        cognitiveDelta: 0,
      },
      {
        path: "apps/owl/src/x.spec.ts",
        isTest: true,
        base: 1,
        head: 2,
        delta: 1,
        cognitiveBase: 0,
        cognitiveHead: 0,
        cognitiveDelta: 0,
      },
    ])
  })

  it("lists a file whose cognitive score moved on its own", () => {
    // Same decision count, nested one level deeper. Cyclomatic cannot see it,
    // and a filter on the cyclomatic delta alone would drop the file.
    const moved = diffOf(
      [sum({ path: "apps/owl/src/n.ts", units: [4], cognitive: [3] })],
      [sum({ path: "apps/owl/src/n.ts", units: [4], cognitive: [8] })]
    )

    expect(moved.files).toEqual([
      {
        path: "apps/owl/src/n.ts",
        isTest: false,
        base: 4,
        head: 4,
        delta: 0,
        cognitiveBase: 3,
        cognitiveHead: 8,
        cognitiveDelta: 5,
      },
    ])
  })

  it("keeps the test side out of the source totals", () => {
    const diff = diffOf(base, head)

    expect(diff.source.base.complexity).toBe(13)
    expect(diff.source.head.complexity).toBe(18)
    expect(diff.test.base.complexity).toBe(1)
    expect(diff.test.head.complexity).toBe(2)
  })

  it("handles an empty base, which is what a brand new file tree looks like", () => {
    const diff = diffOf([], [sum({ units: [3] })])

    expect(diff.source.base).toEqual(EMPTY_TOTALS)
    expect(diff.files).toEqual([
      {
        path: "apps/owl/src/a.ts",
        isTest: false,
        base: 0,
        head: 3,
        delta: 3,
        cognitiveBase: 0,
        cognitiveHead: 0,
        cognitiveDelta: 0,
      },
    ])
  })
})

/** One side of a per-function diff, built from `[name, complexity, line]`. */
const sample = ({
  path = "apps/owl/src/a.ts",
  units = [],
  isTest = false,
}: {
  path?: string
  units?: [string, number, number][]
  isTest?: boolean
} = {}): UnitSample => ({
  path,
  isTest,
  units: units.map(([name, complexity, line]) => ({
    name,
    kind: "function",
    line,
    endLine: line + 20,
    complexity,
    cognitive: complexity,
    owner: -1,
  })),
})

describe("unitDiffOf", () => {
  it("pairs a function with itself across two commits", () => {
    const deltas = unitDiffOf(
      [sample({ units: [["sync", 12, 10]] })],
      [sample({ units: [["sync", 25, 10]] })]
    )

    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({
      name: "sync",
      base: 12,
      head: 25,
      delta: 13,
    })
  })

  it("sees a function move inside a file whose total did not", () => {
    const deltas = unitDiffOf(
      [
        sample({
          units: [
            ["a", 12, 10],
            ["b", 20, 40],
          ],
        }),
      ],
      [
        sample({
          units: [
            ["a", 25, 10],
            ["b", 7, 40],
          ],
        }),
      ]
    )

    expect(deltas.map((unit) => unit.delta)).toEqual([13, -13])
  })

  it("reports a new function against a base of zero", () => {
    const deltas = unitDiffOf(
      [sample()],
      [sample({ units: [["fresh", 9, 1]] })]
    )

    expect(deltas[0]).toMatchObject({
      name: "fresh",
      base: 0,
      head: 9,
      delta: 9,
    })
  })

  it("reports a removed function against a head of zero", () => {
    const deltas = unitDiffOf([sample({ units: [["gone", 9, 1]] })], [sample()])

    expect(deltas[0]).toMatchObject({
      name: "gone",
      base: 9,
      head: 0,
      delta: -9,
    })
  })

  it("reads a rename as one removal and one addition", () => {
    const deltas = unitDiffOf(
      [sample({ units: [["old", 9, 1]] })],
      [sample({ units: [["new", 9, 1]] })]
    )

    expect(deltas).toHaveLength(2)
    expect(deltas.map((unit) => unit.name).toSorted()).toEqual(["new", "old"])
  })

  it("pairs repeated names in line order", () => {
    const deltas = unitDiffOf(
      [
        sample({
          units: [
            ["<anonymous>", 2, 30],
            ["<anonymous>", 3, 10],
          ],
        }),
      ],
      [
        sample({
          units: [
            ["<anonymous>", 5, 10],
            ["<anonymous>", 8, 30],
          ],
        }),
      ]
    )

    // Sorted by line, so 3 pairs with 5 and 2 pairs with 8.
    expect(deltas.map((unit) => unit.delta).toSorted()).toEqual([2, 6])
  })

  it("keeps two files with the same function name apart", () => {
    const deltas = unitDiffOf(
      [
        sample({ path: "apps/owl/src/a.ts", units: [["run", 4, 1]] }),
        sample({ path: "apps/owl/src/b.ts", units: [["run", 4, 1]] }),
      ],
      [
        sample({ path: "apps/owl/src/a.ts", units: [["run", 9, 1]] }),
        sample({ path: "apps/owl/src/b.ts", units: [["run", 4, 1]] }),
      ]
    )

    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.path).toBe("apps/owl/src/a.ts")
  })

  it("ignores test files: a spec that grew a branch is not a regression", () => {
    const deltas = unitDiffOf(
      [
        sample({
          path: "apps/owl/src/a.spec.ts",
          isTest: true,
          units: [["it", 1, 1]],
        }),
      ],
      [
        sample({
          path: "apps/owl/src/a.spec.ts",
          isTest: true,
          units: [["it", 9, 1]],
        }),
      ]
    )

    expect(deltas).toEqual([])
  })

  it("drops a function nobody touched", () => {
    expect(
      unitDiffOf(
        [sample({ units: [["same", 4, 1]] })],
        [sample({ units: [["same", 4, 1]] })]
      )
    ).toEqual([])
  })

  it("puts the worst regression first", () => {
    const deltas = unitDiffOf(
      [
        sample({
          units: [
            ["a", 1, 1],
            ["b", 1, 40],
          ],
        }),
      ],
      [
        sample({
          units: [
            ["a", 4, 1],
            ["b", 30, 40],
          ],
        }),
      ]
    )

    expect(deltas.map((unit) => unit.name)).toEqual(["b", "a"])
  })
})

describe("worsened", () => {
  const deltas = unitDiffOf(
    [
      sample({
        units: [
          ["big", 12, 1],
          ["small", 2, 40],
          ["fixed", 30, 80],
        ],
      }),
    ],
    [
      sample({
        units: [
          ["big", 25, 1],
          ["small", 9, 40],
          ["fixed", 11, 80],
        ],
      }),
    ]
  )

  it("keeps a complex function that got more complex", () => {
    expect(worsened(deltas).map((unit) => unit.name)).toEqual(["big"])
  })

  it("drops one that got worse and is still small", () => {
    expect(worsened(deltas).some((unit) => unit.name === "small")).toBe(false)
  })

  it("drops one that improved, however high it still is", () => {
    expect(worsened(deltas).some((unit) => unit.name === "fixed")).toBe(false)
  })
})
