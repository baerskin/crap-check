import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ChartEvent } from "./chart"
import { globToRegExp } from "./glob"
import { gitText } from "./git"

/**
 * Loads and validates `crap-check.config.json`.
 *
 * The file is optional. Every field has a default that suits a typical
 * TypeScript or JavaScript repository, so a repository with no config still
 * measures. Unknown keys are an error: a typo that silently does nothing is
 * worse than a run that refuses to start.
 */

export const CONFIG_FILE = "crap-check.config.json"

/** One coverage command, run from `cwd`, that leaves an lcov report behind. */
export interface CoverageRunConfig {
  /** Repo-relative directory to run in. `.` is the repository root. */
  cwd: string
  /** Shell command. Its exit code decides whether the run counts. */
  command: string
  /** The lcov file the command writes, relative to `cwd`. */
  lcov: string
}

export interface Config {
  /** Where every artifact is written, repo-relative. */
  outDir: string
  /** The ref whose first-parent history is walked. `null` detects it. */
  ref: string | null
  /** File extensions to measure. */
  extensions: string[]
  /** Globs to skip, added to `DEFAULT_EXCLUDE`. */
  exclude: string[]
  /** Globs that mark a file as a test. Replaces `DEFAULT_TEST` when set. */
  test: string[]
  /**
   * Globs naming workspace directories, such as `packages/*`. `null` makes
   * every directory holding a `package.json` a workspace.
   */
  workspaces: string[] | null
  /** Labelled markers drawn on the charts. */
  events: ChartEvent[]
  /** Coverage commands for the CRAP score. Empty turns CRAP off. */
  coverage: CoverageRunConfig[]
}

export const DEFAULT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]

/**
 * Build output, vendored and generated code. Only tracked files are read.
 *
 * `build` and `out` match only at the root or a package root up to two levels
 * down (`build/`, `pkg/build/`, `apps/web/build/`). Deeper, the names are
 * common for source folders, such as `src/modules/order/build/`.
 */
export const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "{build,out}/**",
  "*/{build,out}/**",
  "*/*/{build,out}/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/generated/**",
  "**/__generated__/**",
  "**/*.d.{ts,mts,cts}",
  "**/*.min.js",
]

/** The suffixes Bun, Vitest and Jest pick up, and the usual test folders. */
export const DEFAULT_TEST = [
  "**/*{.,_}{test,spec}.*",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/__fixtures__/**",
  "**/test/**",
  "**/tests/**",
]

export const DEFAULT_CONFIG: Config = {
  outDir: ".complexity",
  ref: null,
  extensions: DEFAULT_EXTENSIONS,
  exclude: [],
  test: DEFAULT_TEST,
  workspaces: null,
  events: [],
  coverage: [],
}

const WEEK = /^\d{4}-W\d{2}$/

export class ConfigError extends Error {
  public constructor(message: string) {
    super(`${CONFIG_FILE}: ${message}`)
    this.name = "ConfigError"
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringList = (value: unknown, key: string): string[] => {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new ConfigError(`"${key}" must be an array of strings.`)
  }

  return value
}

const globList = (value: unknown, key: string): string[] => {
  const list = stringList(value, key)

  for (const pattern of list) {
    try {
      globToRegExp(pattern)
    } catch (error) {
      throw new ConfigError(
        `"${key}": ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return list
}

const string = (value: unknown, key: string): string => {
  if (typeof value !== "string" || value === "") {
    throw new ConfigError(`"${key}" must be a non-empty string.`)
  }

  return value
}

const events = (value: unknown): ChartEvent[] => {
  if (!Array.isArray(value)) {
    throw new ConfigError(`"events" must be an array.`)
  }

  return value.map((event, index) => {
    if (
      !isRecord(event) ||
      typeof event.week !== "string" ||
      !WEEK.test(event.week) ||
      typeof event.label !== "string"
    ) {
      throw new ConfigError(
        `"events[${index}]" must be { "week": "2026-W01", "label": "..." }.`
      )
    }

    return { week: event.week, label: event.label }
  })
}

const coverage = (value: unknown): CoverageRunConfig[] => {
  if (!Array.isArray(value)) {
    throw new ConfigError(`"coverage" must be an array.`)
  }

  return value.map((run, index) => {
    if (!isRecord(run)) {
      throw new ConfigError(`"coverage[${index}]" must be an object.`)
    }

    return {
      cwd:
        run.cwd === undefined ? "." : string(run.cwd, `coverage[${index}].cwd`),
      command: string(run.command, `coverage[${index}].command`),
      lcov:
        run.lcov === undefined ?
          "coverage/lcov.info"
        : string(run.lcov, `coverage[${index}].lcov`),
    }
  })
}

/** Validate parsed JSON and fill in the defaults. */
export const parseConfig = (raw: unknown): Config => {
  if (!isRecord(raw)) {
    throw new ConfigError("must hold a JSON object.")
  }

  const config: Config = { ...DEFAULT_CONFIG }

  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "$schema":
        break
      case "outDir":
        config.outDir = string(value, key)
        break
      case "ref":
        config.ref = value === null ? null : string(value, key)
        break
      case "extensions":
        config.extensions = stringList(value, key)
        break
      case "exclude":
        config.exclude = globList(value, key)
        break
      case "test":
        config.test = globList(value, key)
        break
      case "workspaces":
        config.workspaces = value === null ? null : globList(value, key)
        break
      case "events":
        config.events = events(value)
        break
      case "coverage":
        config.coverage = coverage(value)
        break
      default:
        throw new ConfigError(`unknown key "${key}".`)
    }
  }

  return config
}

/** Read the config at the repository root, or the defaults when there is none. */
export const loadConfig = (root: string): Config => {
  const path = join(root, CONFIG_FILE)

  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG }
  }

  const text = readFileSync(path, "utf8")
  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  return parseConfig(raw)
}

/**
 * The ref to walk when the config names none.
 *
 * `origin/HEAD` is the remote's default branch. A fresh `actions/checkout` does
 * not set it, which is why the generated workflow passes `--ref`.
 */
export const resolveRef = (root: string, config: Config): string => {
  if (config.ref !== null) {
    return config.ref
  }

  const remoteHead = gitText(root, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ])

  if (remoteHead !== "") {
    return remoteHead
  }

  for (const candidate of ["origin/main", "origin/master"]) {
    if (gitText(root, ["rev-parse", "--verify", "--quiet", candidate]) !== "") {
      return candidate
    }
  }

  return "HEAD"
}
