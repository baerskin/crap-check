import { describe, expect, it } from "bun:test"
import { EMPTY_TOTALS } from "../src/lib/aggregate"
import { renderChart } from "../src/lib/chart"
import type { History, WorkspaceHistory } from "../src/lib/history"

/**
 * The picture is checked for the facts a reader relies on: every week is drawn,
 * the newest number is the one labelled, and nothing in the data can break the
 * markup. How it looks is a judgement, and no assertion here defends it.
 */

const week = (name: string, complexity: number): History["weeks"][number] => ({
  week: name,
  date: `${name}-01T00:00:00Z`,
  commit: "0123456789abcdef",
  source: {
    ...EMPTY_TOTALS,
    complexity,
    functions: 10,
    cognitive: Math.round(complexity * 0.8),
    cogOver15: Math.round(complexity / 50),
  },
  test: { ...EMPTY_TOTALS, complexity: Math.round(complexity / 2) },
})

const history: History = {
  schemaVersion: 1,
  weeks: [week("2025-W01", 100), week("2025-W02", 150), week("2026-W01", 300)],
}

const workspaces: WorkspaceHistory = {
  schemaVersion: 1,
  weeks: history.weeks.map((row) => ({
    week: row.week,
    commit: row.commit,
    source: { "apps/owl": row.source.complexity, "apps/bff": 10 },
    test: { "apps/owl": row.test.complexity },
    sourceCognitive: { "apps/owl": row.source.cognitive, "apps/bff": 8 },
    testCognitive: { "apps/owl": 0 },
  })),
}

describe("renderChart", () => {
  const svg = renderChart({ history, workspaces })

  it("writes one standalone SVG with no script and no external reference", () => {
    expect(svg.startsWith("<svg xmlns=")).toBe(true)
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true)
    // The xmlns is a namespace, not a fetch. Nothing else may reach outside.
    expect(svg).not.toContain("<script")
    expect(svg).not.toContain("href")
  })

  it("draws one point per week in every series", () => {
    const points = (svg.match(/ d="M[^"]+"/g) ?? []).map(
      (path) => path.split("L").length
    )

    // source, tests, and the two workspaces.
    expect(points).toEqual([3, 3, 3, 3])
  })

  it("labels each line with its newest value", () => {
    expect(svg).toContain(">source 300<")
    expect(svg).toContain(">tests 150<")
    expect(svg).toContain(">apps/owl 300<")
  })

  it("marks the year the series crosses", () => {
    expect(svg).toContain(">2025<")
    expect(svg).toContain(">2026<")
  })

  it("escapes the markup characters a workspace name could carry", () => {
    const hostile: WorkspaceHistory = {
      schemaVersion: 1,
      weeks: workspaces.weeks.map((row) => ({
        ...row,
        source: { "a<b&c": 5 },
        sourceCognitive: { "a<b&c": 4 },
      })),
    }

    expect(renderChart({ history, workspaces: hostile })).toContain(
      "a&lt;b&amp;c"
    )
  })

  it("marks an event on its week and ignores a week it does not have", () => {
    const marked = renderChart({
      history,
      workspaces,
      events: [
        { week: "2025-W02", label: "agent commits start" },
        { week: "1999-W01", label: "before the repository" },
      ],
    })

    expect(marked).toContain(">agent commits start<")
    expect(marked).not.toContain("before the repository")
  })

  it("draws the cognitive series in both panels when asked", () => {
    const cog = renderChart({ history, workspaces, metric: "cognitive" })

    expect(cog).toContain("Cognitive complexity by ISO week")
    // 300 * 0.8 in the newest week, for the total and for the workspace.
    expect(cog).toContain(">source 240<")
    expect(cog).toContain(">apps/owl 240<")
    expect(cog).not.toContain(">apps/owl 300<")
  })

  it("refuses a series too short to draw a line", () => {
    expect(() =>
      renderChart({
        history: { schemaVersion: 1, weeks: history.weeks.slice(0, 1) },
        workspaces,
      })
    ).toThrow("at least 2 weeks")
  })
})
