import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join, posix, resolve } from "node:path"
import { parseArgs } from "node:util"
import { git, gitText } from "../lib/git"
import type { CoverageManifest, CoverageRun } from "../lib/lcov"
import { writeJson } from "../lib/measure"
import { UsageError, type Context } from "./context"

/**
 * Run the configured coverage commands and record what each one produced.
 *
 * Complexity alone is half the picture: a function of 30 with full coverage is
 * a smaller liability than a function of 12 with none. `crap` joins the two,
 * and this command is where the coverage half comes from. Any runner works as
 * long as it writes lcov: Bun, Vitest, Jest, c8.
 *
 * A failing command does not stop the run. The workspaces it covers are
 * recorded as unmeasured, and `crap` leaves them out rather than reading them
 * as untested code. This command exits 0 whatever the commands do.
 *
 * The manifest lives inside `.git`, so it is never committed and never
 * conflicts.
 */

/** Where the manifest is written. Inside `.git`, so nothing can commit it. */
export const manifestPath = (root: string): string =>
  join(
    resolve(root, git(root, ["rev-parse", "--git-path", "crap-check"]).trim()),
    "coverage-manifest.json"
  )

export const runCoverage = async (
  context: Context,
  { only }: { only?: Set<string> }
): Promise<CoverageManifest> => {
  const { root, config } = context

  if (config.coverage.length === 0) {
    throw new UsageError(
      `No coverage commands configured. Add "coverage" to crap-check.config.json.`
    )
  }

  const targets = config.coverage.filter(
    (run) => only === undefined || only.has(run.cwd)
  )
  const runs: CoverageRun[] = []

  for (const target of targets) {
    const lcov = posix.normalize(posix.join(target.cwd, target.lcov))

    // A report left by an earlier run would read as this run's output.
    await rm(join(root, lcov), { force: true })

    console.error(`\n=== ${target.cwd}: ${target.command} ===`)

    const started = performance.now()
    const result = spawnSync(target.command, {
      cwd: join(root, target.cwd),
      shell: true,
      stdio: "inherit",
    })
    const exitCode = result.status ?? 1
    const wrote = existsSync(join(root, lcov))

    runs.push({
      cwd: target.cwd,
      status:
        exitCode !== 0 ? "failed"
        : wrote ? "ok"
        : "no-lcov",
      exitCode,
      lcov: wrote ? lcov : null,
      durationMs: Math.round(performance.now() - started),
    })
  }

  const manifest: CoverageManifest = {
    generatedAt: new Date().toISOString(),
    commit: gitText(root, ["rev-parse", "HEAD"]),
    restricted: targets.length < config.coverage.length,
    runs: runs.toSorted((a, b) => a.cwd.localeCompare(b.cwd)),
  }

  await writeJson(manifestPath(root), manifest)

  const bad = runs.filter((run) => run.status !== "ok")

  console.error(
    `\ncoverage: ${runs.length - bad.length} of ${runs.length} command(s) measured`
  )

  for (const run of bad) {
    console.error(`  ${run.cwd}: ${run.status} (exit ${run.exitCode})`)
  }

  return manifest
}

export const coverageCommand = async (
  context: Context,
  argv: string[]
): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: { only: { type: "string" } },
  })

  await runCoverage(context, {
    only:
      values.only === undefined ?
        undefined
      : new Set(values.only.split(",").map((entry) => entry.trim())),
  })
}
