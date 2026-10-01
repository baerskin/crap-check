import { existsSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { byWorkspaceMetric, totalsOf, type FileSummary } from "../lib/aggregate"
import { resolveRef } from "../lib/config"
import { weekPoints } from "../lib/gitTree"
import {
  measureCommit,
  mergeWeeks,
  type BlobCache,
  type History,
  type WeekRow,
  type WorkspaceHistory,
  type WorkspaceWeekRow,
} from "../lib/history"
import { readJson, SCHEMA_VERSION, writeJson } from "../lib/measure"
import { secondsSince, UsageError, type Context } from "./context"

/**
 * Build the weekly history from git, one row per ISO week.
 *
 * Each week is the newest first-parent commit on the ref that week. Content is
 * read from the object database, so no commit is checked out and the working
 * tree is never touched.
 *
 * Incremental: existing weeks are kept and only missing ones are measured,
 * except the newest week, which is always recomputed because it is partial and
 * its newest commit moves.
 */

export interface HistoryOptions {
  ref?: string
  /** An ISO week key. Older weeks are ignored. */
  since?: string
  rebuild: boolean
}

export const HISTORY_FILE = "history.json"
export const WORKSPACE_HISTORY_FILE = "history-by-workspace.json"

const sideOf = (files: FileSummary[], isTest: boolean): FileSummary[] =>
  files.filter((file) => file.isTest === isTest)

const readHistory = async <Shape extends { schemaVersion: number }>({
  path,
  empty,
  rebuild,
}: {
  path: string
  empty: Shape
  rebuild: boolean
}): Promise<Shape> => {
  if (rebuild || !existsSync(path)) {
    return empty
  }

  const parsed = await readJson<Shape>(path)

  // A schema bump changes what the numbers mean; mixing old and new rows
  // breaks comparability.
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    console.error(
      `${path} is schema ${parsed.schemaVersion}, this tool writes ${SCHEMA_VERSION}. Rebuilding.`
    )

    return empty
  }

  return parsed
}

export const runHistory = async (
  context: Context,
  options: HistoryOptions
): Promise<void> => {
  const { root, config, ts, outDir } = context
  const ref = options.ref ?? resolveRef(root, config)
  const historyPath = join(outDir, HISTORY_FILE)
  const workspacePath = join(outDir, WORKSPACE_HISTORY_FILE)
  const empty = { schemaVersion: SCHEMA_VERSION, weeks: [] }

  const history = await readHistory<History>({
    path: historyPath,
    empty,
    rebuild: options.rebuild,
  })
  const workspaces = await readHistory<WorkspaceHistory>({
    path: workspacePath,
    empty,
    rebuild: options.rebuild,
  })

  const points = weekPoints(root, ref).filter(
    (point) => options.since === undefined || point.week >= options.since
  )

  if (points.length === 0) {
    throw new UsageError(`No commits on ${ref}.`)
  }

  // A week is known only when both artifacts carry it: the chart pairs the two
  // files by position, and an interrupted run can leave one behind.
  const inWorkspaces = new Set(workspaces.weeks.map((week) => week.week))
  const known = new Set(
    history.weeks
      .map((week) => week.week)
      .filter((week) => inWorkspaces.has(week))
  )
  const newest = points.at(-1)?.week
  const missing = points.filter(
    (point) => !known.has(point.week) || point.week === newest
  )

  console.error(`${ref}: ${points.length} weeks, ${missing.length} to measure`)

  const cache: BlobCache = new Map()
  const freshWeeks: WeekRow[] = []
  const freshWorkspaces: WorkspaceWeekRow[] = []
  const started = performance.now()

  for (const [index, point] of missing.entries()) {
    const files = await measureCommit({
      root,
      commit: point.commit,
      ts,
      cache,
      config,
    })
    const source = sideOf(files, false)
    const tests = sideOf(files, true)
    const totals = totalsOf(source)

    freshWeeks.push({
      week: point.week,
      date: point.date,
      commit: point.commit,
      source: totals,
      test: totalsOf(tests),
    })

    freshWorkspaces.push({
      week: point.week,
      commit: point.commit,
      source: byWorkspaceMetric(source, "complexity"),
      test: byWorkspaceMetric(tests, "complexity"),
      sourceCognitive: byWorkspaceMetric(source, "cognitive"),
      testCognitive: byWorkspaceMetric(tests, "cognitive"),
    })

    console.error(
      `  ${String(index + 1).padStart(4)}/${missing.length}  ${point.week}  ` +
        `files=${String(source.length).padStart(5)}  ` +
        `cyclomatic=${String(totals.complexity).padStart(6)}  ` +
        `cognitive=${String(totals.cognitive).padStart(6)}`
    )
  }

  await writeJson(historyPath, {
    schemaVersion: SCHEMA_VERSION,
    weeks: mergeWeeks(history.weeks, freshWeeks),
  } satisfies History)

  await writeJson(workspacePath, {
    schemaVersion: SCHEMA_VERSION,
    weeks: mergeWeeks(workspaces.weeks, freshWorkspaces),
  } satisfies WorkspaceHistory)

  console.error(
    `wrote ${missing.length} week(s) in ${secondsSince(started)}s, ${cache.size} blobs parsed`
  )
}

export const historyCommand = async (
  context: Context,
  argv: string[]
): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      ref: { type: "string" },
      since: { type: "string" },
      rebuild: { type: "boolean", default: false },
    },
  })

  if (values.since !== undefined && !/^\d{4}-W\d{2}$/.test(values.since)) {
    throw new UsageError(`--since must be an ISO week such as 2026-W01.`)
  }

  await runHistory(context, {
    ref: values.ref,
    since: values.since,
    rebuild: values.rebuild,
  })
}
