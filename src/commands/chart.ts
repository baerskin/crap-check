import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { renderChart, type ChartMetric } from "../lib/chart"
import { resolveRef } from "../lib/config"
import type { History, WorkspaceHistory } from "../lib/history"
import { readJson } from "../lib/measure"
import { UsageError, type Context } from "./context"
import { HISTORY_FILE, WORKSPACE_HISTORY_FILE } from "./history"

/**
 * Draw the history as a standalone SVG. Reads the two history files and
 * measures nothing, so run `history` first when the series is stale.
 */

/** One file per metric, so a rerun never overwrites the other picture. */
export const CHART_FILE: Record<ChartMetric, string> = {
  cyclomatic: "history.svg",
  cognitive: "history-cognitive.svg",
}

/** Draw one chart. Returns false when the history is too short to draw. */
export const runChart = async (
  context: Context,
  { metric, out, ref }: { metric: ChartMetric; out?: string; ref?: string }
): Promise<boolean> => {
  const { root, config, outDir } = context
  const historyPath = join(outDir, HISTORY_FILE)

  if (!existsSync(historyPath)) {
    throw new UsageError(
      `${join(config.outDir, HISTORY_FILE)} is missing. Run: crap-check history`
    )
  }

  const history = await readJson<History>(historyPath)
  const workspaces = await readJson<WorkspaceHistory>(
    join(outDir, WORKSPACE_HISTORY_FILE)
  )

  if (history.schemaVersion !== workspaces.schemaVersion) {
    throw new UsageError(
      `Schema mismatch: history is v${history.schemaVersion}, workspaces is v${workspaces.schemaVersion}. Run: crap-check history --rebuild`
    )
  }

  // The chart pairs the two files by position, one column per week.
  const paired =
    history.weeks.length === workspaces.weeks.length &&
    history.weeks.every(
      (week, index) => week.week === workspaces.weeks[index]?.week
    )

  if (!paired) {
    throw new UsageError(
      `The two history files hold different weeks. Run: crap-check history --rebuild`
    )
  }

  if (history.weeks.length < 2) {
    console.error(
      `skipped ${metric} chart: the history holds fewer than 2 weeks`
    )
    return false
  }

  const path =
    out === undefined ? join(outDir, CHART_FILE[metric]) : resolve(root, out)

  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    renderChart({
      history,
      workspaces,
      events: config.events,
      metric,
      ref: ref ?? resolveRef(root, config),
    })
  )

  console.error(
    `wrote ${path}: ${metric}, ${history.weeks.length} weeks, newest ${history.weeks.at(-1)?.week}`
  )

  return true
}

export const chartCommand = async (
  context: Context,
  argv: string[]
): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      metric: { type: "string", default: "cyclomatic" },
      out: { type: "string" },
    },
  })

  if (values.metric !== "cyclomatic" && values.metric !== "cognitive") {
    throw new UsageError(
      `Unknown metric ${values.metric}: use cyclomatic or cognitive.`
    )
  }

  await runChart(context, { metric: values.metric, out: values.out })
}
