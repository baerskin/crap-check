import type * as TS from "typescript"
import { analyze } from "./analyze"
import {
  summarizeBlob,
  type BlobSummary,
  type FileSummary,
  type Totals,
  type UnitSample,
} from "./aggregate"
import type { Config } from "./config"
import { createScope, type Scope } from "./include"
import { listTree, readBlobs } from "./gitTree"

/** One week of repository-wide totals. */
export interface WeekRow {
  week: string
  date: string
  commit: string
  source: Totals
  test: Totals
}

export interface History {
  schemaVersion: number
  /** Oldest week first. */
  weeks: WeekRow[]
}

/**
 * The same weeks, one integer per workspace and per metric.
 *
 * Four flat maps rather than one map of objects. `JSON.stringify` with two-space
 * indent puts a nested object on four lines, so `{ cyclomatic, cognitive }` per
 * workspace would cost about 56,000 lines. A flat map keeps one line per entry.
 */
export interface WorkspaceWeekRow {
  week: string
  commit: string
  /** Cyclomatic complexity. */
  source: Record<string, number>
  test: Record<string, number>
  /** Cognitive complexity, over the same workspaces. */
  sourceCognitive: Record<string, number>
  testCognitive: Record<string, number>
}

export interface WorkspaceHistory {
  schemaVersion: number
  weeks: WorkspaceWeekRow[]
}

/**
 * Measured content, keyed by blob id and extension.
 *
 * The key carries the extension because the same bytes parse differently as
 * `.ts` and `.tsx`: a lone type parameter is a generic in one and a JSX element
 * in the other. Everything else about a file comes from its path, not its content.
 */
export type BlobCache = Map<string, BlobSummary>

/** The scope fields that decide what a tree's files are. */
export type ScopeConfig = Pick<
  Config,
  "extensions" | "exclude" | "test" | "workspaces"
>

const kindOf = (path: string): string => path.slice(path.lastIndexOf("."))

const keyOf = (oid: string, path: string): string => `${oid}:${kindOf(path)}`

/**
 * Measure every file of one commit, reading blobs straight from the object database.
 *
 * `cache` is shared across weeks and is where the speed comes from. A file that did
 * not change between two weeks is the same blob id, so it is read and parsed once
 * for the whole backfill.
 */
export const measureCommit = async ({
  root,
  commit,
  ts,
  cache,
  config,
}: {
  root: string
  commit: string
  ts: typeof TS
  cache: BlobCache
  config: ScopeConfig
}): Promise<FileSummary[]> => {
  const tree = listTree(root, commit)
  const scope = createScope(
    config,
    tree.map((entry) => entry.path)
  )
  const entries = tree.filter((entry) => scope.isMeasured(entry.path))

  // One representative path per (blob, script kind), so an unseen blob is parsed
  // once per kind rather than once per path that holds it.
  const wanted = new Map<string, string>()

  for (const entry of entries) {
    const key = keyOf(entry.oid, entry.path)

    if (!cache.has(key) && !wanted.has(key)) {
      wanted.set(key, entry.path)
    }
  }

  const byOid = new Map<string, string[]>()

  for (const [key, path] of wanted) {
    const oid = key.slice(0, key.indexOf(":"))
    const paths = byOid.get(oid)

    if (paths === undefined) {
      byOid.set(oid, [path])
    } else {
      paths.push(path)
    }
  }

  await readBlobs(root, [...byOid.keys()], (oid, text) => {
    for (const path of byOid.get(oid) ?? []) {
      cache.set(keyOf(oid, path), summarizeBlob(analyze(path, text, ts)))
    }
  })

  return entries.map((entry): FileSummary => {
    const summary = cache.get(keyOf(entry.oid, entry.path))

    if (summary === undefined) {
      throw new Error(`no content for ${entry.path} at ${entry.oid}`)
    }

    return {
      path: entry.path,
      workspace: scope.workspaceOf(entry.path),
      isTest: scope.isTest(entry.path),
      ...summary,
    }
  })
}

/** Merge new rows into old ones, newest value wins, oldest week first. */
export const mergeWeeks = <Row extends { week: string }>(
  existing: Row[],
  fresh: Row[]
): Row[] => {
  const merged = new Map(existing.map((row) => [row.week, row]))

  for (const row of fresh) {
    merged.set(row.week, row)
  }

  return [...merged.values()].toSorted((a, b) => a.week.localeCompare(b.week))
}

/**
 * Read the units of named files at one commit.
 *
 * `measureCommit` throws every `units[]` away on purpose: the backfill measures
 * 162,459 file versions and holding them all would not fit. The pull-request
 * comment needs per-function detail, but only for the handful of files a branch
 * touched, so this is a second targeted pass over those paths alone.
 *
 * A path absent from the commit is absent from the result. That is how a new file
 * reads on the base side and a deleted one reads on the head side.
 */
/** The two sides of a changed file list, with the renames that link them. */
export interface ChangedPaths {
  /** Where each file was at the base commit, in entry order. */
  base: string[]
  /** Where the same file is at the head commit, in entry order. */
  head: string[]
  /** Base path against head path, for the entries where the two differ. */
  renames: Map<string, string>
}

/**
 * Read `git diff --name-status -M -z` into the paths each side has to be read at.
 *
 * `--name-only` prints a rename's destination alone, which loses the link between
 * the two halves. A unit diff keyed on the path then reads every function in a
 * renamed file as new, and any one above the threshold as a regression.
 *
 * A rename or a copy spends three fields on one entry. Every other status spends
 * two, and its one path stands for both sides. The head path decides whether the
 * entry is kept, because it is the identity the report prints.
 */
export const changedPaths = (
  nameStatus: string,
  scope: Pick<Scope, "isMeasured" | "isTest">
): ChangedPaths => {
  const fields = nameStatus.split("\0").filter((field) => field !== "")
  const changed: ChangedPaths = { base: [], head: [], renames: new Map() }

  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index] ?? ""
    const paired = status.startsWith("R") || status.startsWith("C")
    const from = fields[index + 1] ?? ""
    const to = paired ? (fields[index + 2] ?? "") : from

    index += paired ? 2 : 1

    if (!scope.isMeasured(to) || scope.isTest(to)) {
      continue
    }

    changed.base.push(from)
    changed.head.push(to)

    if (from !== to) {
      changed.renames.set(from, to)
    }
  }

  return changed
}

export const readUnits = async ({
  root,
  commit,
  paths,
  ts,
  scope,
}: {
  root: string
  commit: string
  paths: string[]
  ts: typeof TS
  scope: Pick<Scope, "isMeasured" | "isTest">
}): Promise<UnitSample[]> => {
  const wanted = new Set(paths)
  const entries = listTree(root, commit).filter(
    (entry) => wanted.has(entry.path) && scope.isMeasured(entry.path)
  )

  const byOid = new Map<string, string[]>()

  for (const entry of entries) {
    const bucket = byOid.get(entry.oid)

    if (bucket === undefined) {
      byOid.set(entry.oid, [entry.path])
    } else {
      bucket.push(entry.path)
    }
  }

  const samples: UnitSample[] = []

  await readBlobs(root, [...byOid.keys()], (oid, text) => {
    for (const path of byOid.get(oid) ?? []) {
      samples.push({
        path,
        isTest: scope.isTest(path),
        units: analyze(path, text, ts).units,
      })
    }
  })

  return samples
}
