import type { Totals } from "./aggregate"
import type { History, WorkspaceHistory } from "./history"

/**
 * Draw the weekly history of one metric as a standalone SVG.
 *
 * SVG rather than a chart library: the file has no dependency, no script and no
 * network call, so a browser, a Markdown viewer and GitHub all render it, and it
 * stays readable years after the library it would have used is gone.
 *
 * The upper panel is the repository total; the lower panel is the largest
 * workspaces. Two panels rather than one, since the largest workspace and the repository
 * total can differ by an order of magnitude and would flatten onto a shared y axis.
 * `history-by-workspace.json` carries both metrics, so the two charts share a shape.
 */

/** Which of the two metrics the chart draws. */
export type ChartMetric = "cyclomatic" | "cognitive"

/** How many workspaces the lower panel draws, largest in the newest week first. */
const TOP_WORKSPACES = 6

/** Colours in draw order. Distinguishable next to each other, readable on white. */
const PALETTE = [
  "#2563eb",
  "#dc2626",
  "#059669",
  "#d97706",
  "#7c3aed",
  "#0891b2",
] as const

const WIDTH = 1160
const PAD = { left: 78, right: 178, top: 128, bottom: 34 }
const TOTAL_PANEL_HEIGHT = 320
const WORKSPACE_PANEL_HEIGHT = 260
/** Space between the panels, holding the lower panel's title and the year labels. */
const PANEL_GAP = 62
const PLOT_WIDTH = WIDTH - PAD.left - PAD.right

interface Series {
  label: string
  values: number[]
  color: string
}

/** A dated fact worth marking on the curve, so a spike carries its cause. */
export interface ChartEvent {
  /** An ISO week key, `2026-W32`. A week absent from the series is ignored. */
  week: string
  label: string
}

/** The next round number above `value`, so the top gridline is a readable one. */
const niceMax = (value: number): number => {
  const step = 10 ** Math.floor(Math.log10(value)) / 2

  return Math.ceil(value / step) * step
}

const format = (value: number): string => value.toLocaleString("en-US")

/** SVG text is markup, and a workspace path or a week key could carry `&` or `<`. */
const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;")

export const renderChart = ({
  history,
  workspaces,
  events = [],
  metric = "cyclomatic",
  ref,
}: {
  history: History
  workspaces: WorkspaceHistory
  events?: ChartEvent[]
  metric?: ChartMetric
  /** The ref the history walked, named in the subtitle. */
  ref?: string
}): string => {
  const weeks = history.weeks
  const count = weeks.length

  if (count < 2) {
    throw new Error(`the history needs at least 2 weeks, it has ${count}`)
  }

  const first = weeks[0] as (typeof weeks)[number]
  const last = weeks[count - 1] as (typeof weeks)[number]
  const cognitive = metric === "cognitive"
  const totalOf = (totals: Totals): number =>
    cognitive ? totals.cognitive : totals.complexity
  const height =
    PAD.top +
    TOTAL_PANEL_HEIGHT +
    PANEL_GAP +
    WORKSPACE_PANEL_HEIGHT +
    PAD.bottom +
    26

  // Weeks are drawn evenly spaced, not by date: a week with no commit is absent,
  // and spacing by date would imply a measurement never taken.
  const xOf = (index: number): number =>
    PAD.left + (index * PLOT_WIDTH) / (count - 1)

  const yearTicks = weeks
    .map((week, index) => ({ year: week.week.slice(0, 4), index }))
    .filter(
      (tick, index, all) =>
        index === 0 || (all[index - 1] as { year: string }).year !== tick.year
    )

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="ui-sans-serif, -apple-system, Helvetica, Arial, sans-serif">`,
    `<rect width="${WIDTH}" height="${height}" fill="#ffffff"/>`,
    `<text x="${PAD.left}" y="26" font-size="17" font-weight="600" fill="#0f172a">${cognitive ? "Cognitive" : "Cyclomatic"} complexity by ISO week, ${escape(first.week)} to ${escape(last.week)}</text>`,
    `<text x="${PAD.left}" y="43" font-size="11.5" fill="#64748b">One point per week, measured on the newest first-parent commit${ref === undefined ? "" : ` of ${escape(ref)}`}. Source excludes test files.</text>`,
  ]

  const panel = (
    top: number,
    panelHeight: number,
    title: string,
    series: Series[]
  ): void => {
    const max = niceMax(Math.max(...series.flatMap((one) => one.values), 1))
    const yOf = (value: number): number =>
      top + panelHeight - (value / max) * panelHeight

    out.push(
      `<text x="${PAD.left}" y="${top - 12}" font-size="12.5" font-weight="600" fill="#334155">${escape(title)}</text>`
    )

    for (const step of [0, 1, 2, 3, 4]) {
      const y = yOf((step / 4) * max)

      out.push(
        `<line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${PAD.left + PLOT_WIDTH}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`,
        `<text x="${PAD.left - 10}" y="${(y + 4).toFixed(1)}" font-size="10.5" fill="#64748b" text-anchor="end">${format(Math.round((step / 4) * max))}</text>`
      )
    }

    for (const tick of yearTicks) {
      const x = xOf(tick.index).toFixed(1)

      out.push(
        `<line x1="${x}" y1="${top}" x2="${x}" y2="${top + panelHeight}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3 3"/>`,
        `<text x="${(xOf(tick.index) + 4).toFixed(1)}" y="${top + panelHeight + 15}" font-size="10.5" fill="#475569">${escape(tick.year)}</text>`
      )
    }

    // Labels sit at the line's own end height, pushed down only when two would
    // overlap. The reader matches a label to a line by height, not by a legend.
    let labelFloor = top + 4

    for (const one of series) {
      const path = one.values
        .map(
          (value, index) =>
            `${index === 0 ? "M" : "L"}${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`
        )
        .join(" ")
      const endValue = one.values[one.values.length - 1] ?? 0
      const labelY = Math.max(labelFloor, yOf(endValue))

      labelFloor = labelY + 15

      out.push(
        `<path d="${path}" fill="none" stroke="${one.color}" stroke-width="2" stroke-linejoin="round"/>`,
        `<circle cx="${xOf(count - 1).toFixed(1)}" cy="${yOf(endValue).toFixed(1)}" r="3" fill="${one.color}"/>`,
        `<text x="${PAD.left + PLOT_WIDTH + 10}" y="${(labelY + 4).toFixed(1)}" font-size="11" fill="${one.color}">${escape(one.label)} ${format(endValue)}</text>`
      )
    }
  }

  // Markers first, so a line is never hidden behind a label.
  const weekIndex = new Map(weeks.map((one, index) => [one.week, index]))
  // Labels are packed into rows above the panel. Events cluster (four of them
  // fall inside six weeks), and one row would overprint every label there.
  const rowEnds = [0, 0, 0, 0, 0, 0]

  for (const event of events.toSorted((a, b) => a.week.localeCompare(b.week))) {
    const index = weekIndex.get(event.week)

    if (index === undefined) {
      continue
    }

    const x = xOf(index)
    // 9.5px text is about 5.4px a character, plus 8px of clear space.
    const width = event.label.length * 5.4 + 8
    const flip = x + width > PAD.left + PLOT_WIDTH
    const startX = flip ? x - width - 4 : x + 3
    const row = rowEnds.findIndex((end) => startX > end)
    const lane = row === -1 ? 0 : row
    const y = 48 + lane * 12

    rowEnds[lane] = startX + width

    out.push(
      `<line x1="${x.toFixed(1)}" y1="${y + 4}" x2="${x.toFixed(1)}" y2="${PAD.top + TOTAL_PANEL_HEIGHT}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2 3"/>`,
      `<text x="${(flip ? x - 3 : x + 3).toFixed(1)}" y="${y}" font-size="9.5" fill="#475569"${flip ? ' text-anchor="end"' : ""}>${escape(event.label)}</text>`
    )
  }

  panel(PAD.top, TOTAL_PANEL_HEIGHT, "Repository total", [
    {
      label: "source",
      values: weeks.map((week) => totalOf(week.source)),
      color: PALETTE[0],
    },
    {
      label: "tests",
      values: weeks.map((week) => totalOf(week.test)),
      color: PALETTE[1],
    },
  ])

  // The same field on every week, so the lower panel reads one metric throughout.
  const perWorkspace = (week: WorkspaceHistory["weeks"][number]) =>
    cognitive ? week.sourceCognitive : week.source

  const newest = workspaces.weeks[workspaces.weeks.length - 1]
  const largest = Object.entries(
    newest === undefined ? {} : perWorkspace(newest)
  )
    .toSorted(([, a], [, b]) => b - a)
    .slice(0, TOP_WORKSPACES)
    .map(([workspace]) => workspace)

  panel(
    PAD.top + TOTAL_PANEL_HEIGHT + PANEL_GAP,
    WORKSPACE_PANEL_HEIGHT,
    `Source complexity by workspace, the ${largest.length} largest today`,
    largest.map((workspace, index) => ({
      label: workspace,
      values: workspaces.weeks.map(
        (week) => perWorkspace(week)[workspace] ?? 0
      ),
      color: PALETTE[index % PALETTE.length] as string,
    }))
  )

  // A year of weeks, or the whole series when it is shorter. The compound rate over
  // the full series is meaningless: week one is an empty repository.
  const yearAgo = weeks[Math.max(0, count - 53)] as (typeof weeks)[number]
  const delta = totalOf(last.source) - totalOf(yearAgo.source)
  const percent = (delta / (totalOf(yearAgo.source) || 1)) * 100
  const worst =
    cognitive ?
      `over 15: ${format(last.source.cogOver15)}, worst ${format(last.source.cognitiveMaxFunction)}`
    : `over 10: ${format(last.source.over10)}, over 20: ${format(last.source.over20)}`

  out.push(
    `<text x="${PAD.left}" y="${height - 8}" font-size="11" fill="#64748b">${count} weeks, ${format(totalOf(first.source))} to ${format(totalOf(last.source))} source complexity. Since ${escape(yearAgo.week)}: ${format(delta > 0 ? delta : -delta)} ${delta < 0 ? "removed" : "added"} (${percent.toFixed(0)}%). Functions ${format(last.source.functions)}, ${worst}. Commit ${escape(last.commit.slice(0, 9))}.</text>`,
    "</svg>"
  )

  return `${out.join("\n")}\n`
}
