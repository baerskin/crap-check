import { readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

/**
 * Read lcov output into per-file line hits.
 *
 * Only `SF:`, `DA:` and `end_of_record` are read. That is the subset every
 * runner writes: Bun, for one, emits no `FN:`/`FNDA:` and no `BRDA:` records, so
 * per-function coverage is derived from line ranges. `crap.ts` does that, and it
 * is why `Unit` carries `endLine`.
 *
 * Two details decide the parsing:
 *
 * - **`SF:` may be relative to the directory the run used**, so `src/selectors.ts`,
 *   not `packages/collection-filters/src/selectors.ts`. Every path is resolved
 *   against that directory and then made repo-relative.
 * - **A file the suite never imported is absent from the report.** That absence is
 *   real information: the file is genuinely untested, not unmeasured. Keeping the
 *   two apart is the whole point of the manifest below.
 */

/** One file's executable lines, against the number of times each one ran. */
export interface FileCoverage {
  /** Repo-relative POSIX path. */
  path: string
  hits: Map<number, number>
}

/** Every covered file of a run, keyed by repo-relative path. */
export type CoverageIndex = Map<string, Map<number, number>>

/** What one coverage command did. */
export interface CoverageRun {
  /** Repo-relative directory the command ran in, `.` for the root. */
  cwd: string
  /** `ok` means the command passed and wrote a report. The rest are unmeasured. */
  status: "ok" | "failed" | "no-lcov"
  exitCode: number
  /** Repo-relative path to the `.info` file, or null when none was written. */
  lcov: string | null
  durationMs: number
}

/** What the coverage step hands to the scoring step. */
export interface CoverageManifest {
  generatedAt: string
  commit: string
  /** One entry per configured command, in path order. */
  runs: CoverageRun[]
  /**
   * True when `--only` held the run to a subset of the configured commands.
   *
   * The scoring step reads this as partial. A subset measures fewer functions and
   * would otherwise look like a week in which untested code disappeared.
   */
  restricted: boolean
}

/**
 * Turn one run's lcov text into per-file line hits.
 *
 * Paths that escape the repository, and paths the complexity metric does not
 * measure, are dropped: scoring a file the other half of the tool never counted
 * would put a function in the report that no snapshot can explain.
 */
export const parseLcov = ({
  text,
  cwd,
  repoRoot,
  isMeasured,
}: {
  text: string
  cwd: string
  repoRoot: string
  isMeasured: (path: string) => boolean
}): FileCoverage[] => {
  const runDir = join(repoRoot, cwd)
  const files: FileCoverage[] = []

  let path: string | undefined
  let hits = new Map<number, number>()

  for (const raw of text.split("\n")) {
    const line = raw.trim()

    if (line.startsWith("SF:")) {
      const source = line.slice(3)
      const absolute = isAbsolute(source) ? source : resolve(runDir, source)
      const repoPath = relative(repoRoot, absolute).split("\\").join("/")

      path = repoPath.startsWith("..") ? undefined : repoPath
      hits = new Map<number, number>()

      continue
    }

    if (line.startsWith("DA:")) {
      const [number, count] = line.slice(3).split(",")
      const lineNumber = Number(number)
      const runs = Number(count)

      if (Number.isFinite(lineNumber) && Number.isFinite(runs)) {
        hits.set(lineNumber, runs)
      }

      continue
    }

    if (line === "end_of_record") {
      if (path !== undefined && isMeasured(path)) {
        files.push({ path, hits })
      }

      path = undefined
      hits = new Map<number, number>()
    }
  }

  return files
}

/**
 * Fold every run's report into one index.
 *
 * Hit counts are summed, because a shared package is imported by more than one
 * suite and a line covered by any of them is covered. Only zero against non-zero
 * matters downstream, so the sum never needs to be exact.
 */
export const mergeCoverage = (files: FileCoverage[]): CoverageIndex => {
  const index: CoverageIndex = new Map()

  for (const file of files) {
    const existing = index.get(file.path)

    if (existing === undefined) {
      index.set(file.path, new Map(file.hits))
      continue
    }

    for (const [line, runs] of file.hits) {
      existing.set(line, (existing.get(line) ?? 0) + runs)
    }
  }

  return index
}

/** Read every `ok` run named by a manifest and merge the reports. */
export const loadCoverage = async ({
  manifest,
  repoRoot,
  isMeasured,
}: {
  manifest: CoverageManifest
  repoRoot: string
  isMeasured: (path: string) => boolean
}): Promise<CoverageIndex> => {
  const files: FileCoverage[] = []

  for (const run of manifest.runs) {
    if (run.status !== "ok" || run.lcov === null) {
      continue
    }

    const text = await readFile(join(repoRoot, run.lcov), "utf8")

    files.push(...parseLcov({ text, cwd: run.cwd, repoRoot, isMeasured }))
  }

  return mergeCoverage(files)
}
