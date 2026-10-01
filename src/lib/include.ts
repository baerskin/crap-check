import { DEFAULT_EXCLUDE, type Config } from "./config"
import { globToRegExp, matcher } from "./glob"

/**
 * Decides which files the metric measures, and where each one belongs.
 *
 * The population must be settled before anything counts: a file that drifts in
 * or out between runs moves the number for a reason nobody can see in the diff.
 * Tests are measured and kept apart, so a week of test writing does not read as
 * "the codebase got more complex".
 *
 * Workspaces come from the config's globs when it sets them. Otherwise every
 * directory holding a tracked `package.json` is a workspace, read from the tree
 * being measured, so a historical commit uses the layout it had at the time.
 */

/** What `workspaceOf` returns for a file outside every workspace. */
export const ROOT_WORKSPACE = "<root>"

/** The rules for one tree. Build one per commit with `createScope`. */
export interface Scope {
  /** Does the metric count this file? Repo-relative POSIX paths only. */
  isMeasured: (path: string) => boolean
  isTest: (path: string) => boolean
  /** Which workspace owns this file, as `packages/utils` or `<root>`. */
  workspaceOf: (path: string) => string
}

const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/")

  return slash === -1 ? "" : path.slice(0, slash)
}

/** Nearest ancestor directory in `dirs`, or `<root>`. */
const nearest = (path: string, dirs: Set<string>): string => {
  for (let dir = parentOf(path); dir !== ""; dir = parentOf(dir)) {
    if (dirs.has(dir)) {
      return dir
    }
  }

  return ROOT_WORKSPACE
}

/** Workspace by the first config glob that matches a leading run of segments. */
const byGlobs = (patterns: string[]): ((path: string) => string) => {
  const compiled = patterns.map((pattern) => ({
    regex: globToRegExp(pattern.replace(/\/+$/, "")),
    segments: pattern.replace(/\/+$/, "").split("/").length,
  }))

  return (path) => {
    const segments = path.split("/")

    for (const { regex, segments: count } of compiled) {
      // The workspace is a directory, so the file needs at least one more segment.
      if (segments.length <= count) {
        continue
      }

      const prefix = segments.slice(0, count).join("/")

      if (regex.test(prefix)) {
        return prefix
      }
    }

    return ROOT_WORKSPACE
  }
}

/**
 * Build the rules for one tree.
 *
 * `paths` is every tracked path in that tree. It is read only when the config
 * leaves workspaces to detection.
 */
export const createScope = (
  config: Pick<Config, "extensions" | "exclude" | "test" | "workspaces">,
  paths: readonly string[]
): Scope => {
  const isExcluded = matcher([...DEFAULT_EXCLUDE, ...config.exclude])
  const isTest = matcher(config.test)
  const hasExtension = (path: string): boolean =>
    config.extensions.some((extension) => path.endsWith(extension))

  const packageDirs = new Set(
    paths
      .filter(
        (path) =>
          path.endsWith("/package.json") && !path.includes("node_modules/")
      )
      .map(parentOf)
  )
  const workspaceOf =
    config.workspaces === null ?
      (path: string) => nearest(path, packageDirs)
    : byGlobs(config.workspaces)

  return {
    isMeasured: (path) => hasExtension(path) && !isExcluded(path),
    isTest,
    workspaceOf,
  }
}
