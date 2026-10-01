import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type * as TS from "typescript"
import {
  analyze,
  COGNITIVE_RULES,
  DECISION_POINTS,
  type FileComplexity,
} from "./analyze"
import {
  byWorkspace,
  hotspots,
  summarize,
  totalsOf,
  type Hotspot,
  type Totals,
} from "./aggregate"
import { git } from "./git"
import type { ScopeConfig } from "./history"
import { createScope, type Scope } from "./include"

/**
 * Measure a working tree and shape the result into the committed snapshot.
 *
 * The snapshot describes its own metrics. A reader who finds `snapshot.json` can tell
 * what the numbers count without finding this package, and a change to the decision
 * points shows up as a diff that forces a `schemaVersion` bump.
 */

/** Bump when the meaning of any recorded number changes. Forces a full rebuild. */
export const SCHEMA_VERSION = 4

/** How many functions the snapshot names. Enough to act on, short enough to read. */
export const HOTSPOT_LIMIT = 50

export interface SnapshotMetric {
  name: "cyclomatic" | "cognitive"
  /**
   * What this metric is defined to match, exactly, with its version. Cyclomatic
   * names a tool, because `oracle.spec.ts` holds the two to parity. Cognitive
   * names a document, because there is no tool here to defer to.
   */
  oracle: string
  /** What the metric charges for. Cognitive groups its rules; see `COGNITIVE_RULES`. */
  counts: readonly string[] | Record<string, readonly string[]>
}

export interface Snapshot {
  schemaVersion: number
  generatedAt: string
  commit: string
  ref: string
  metrics: SnapshotMetric[]
  source: Totals
  test: Totals
  /** Source only. A workspace's test complexity is a different question. */
  workspaces: Record<string, Totals>
  hotspots: Hotspot[]
}

/**
 * The ESLint rule the cyclomatic number is held to. `oracle.spec.ts` runs this
 * exact version, and a spec checks it against `package.json`.
 */
export const ORACLE = "eslint@10.11.0 complexity"

/**
 * Every tracked file the metric measures, repo-relative, sorted by git, with
 * the scope built from the same listing.
 */
export const listMeasuredFiles = (
  root: string,
  config: ScopeConfig
): { scope: Scope; paths: string[] } => {
  const tracked = git(root, ["ls-files", "-z"])
    .split("\0")
    .filter((path) => path !== "")
  const scope = createScope(config, tracked)

  // `git ls-files` reads the index, which still lists a file the working tree no
  // longer holds. A file deleted on disk is not part of the working tree, so
  // leaving it out is the right measurement as well as the one that does not throw.
  const paths = tracked.filter(
    (path) => scope.isMeasured(path) && existsSync(join(root, path))
  )

  return { scope, paths }
}

/** Measure the files on disk. Sequential: the parse dominates, not the read. */
export const measureWorkingTree = async ({
  root,
  ts,
  config,
}: {
  root: string
  ts: typeof TS
  config: ScopeConfig
}): Promise<FileComplexity[]> => {
  const { scope, paths } = listMeasuredFiles(root, config)
  const measured: FileComplexity[] = []

  for (const path of paths) {
    const source = await readFile(join(root, path), "utf8")

    measured.push({
      ...analyze(path, source, ts),
      workspace: scope.workspaceOf(path),
      isTest: scope.isTest(path),
    })
  }

  return measured
}

export const sourceOf = (files: FileComplexity[]): FileComplexity[] =>
  files.filter((file) => !file.isTest)

export const testsOf = (files: FileComplexity[]): FileComplexity[] =>
  files.filter((file) => file.isTest)

export const buildSnapshot = ({
  files,
  commit,
  ref,
  generatedAt,
}: {
  files: FileComplexity[]
  commit: string
  ref: string
  generatedAt: string
}): Snapshot => {
  const source = sourceOf(files)
  const summaries = source.map(summarize)

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    commit,
    ref,
    metrics: [
      { name: "cyclomatic", oracle: ORACLE, counts: DECISION_POINTS },
      {
        name: "cognitive",
        oracle: "Cognitive Complexity v1.7 (Sonar, 2023-08-29), Appendix B",
        counts: COGNITIVE_RULES,
      },
    ],
    source: totalsOf(summaries),
    test: totalsOf(testsOf(files).map(summarize)),
    workspaces: byWorkspace(summaries),
    hotspots: hotspots(source, HOTSPOT_LIMIT),
  }
}

/**
 * Write JSON the way every artifact in the output directory is written.
 *
 * Two spaces and a trailing newline: deterministic, so a run that changes nothing
 * produces no diff, and `git diff` stays readable line by line.
 */
export const writeJson = async (
  path: string,
  value: unknown
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Read a JSON artifact. The caller states the shape it expects. */
export const readJson = async <Shape>(path: string): Promise<Shape> =>
  JSON.parse(await readFile(path, "utf8")) as Shape
