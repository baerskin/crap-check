import { join } from "node:path"
import ts from "typescript"
import { loadConfig, type Config } from "../lib/config"
import { repoRoot } from "../lib/git"

/** What every command needs: where the repository is and how it is configured. */
export interface Context {
  root: string
  config: Config
  /** Absolute path of `config.outDir`. */
  outDir: string
  ts: typeof ts
}

/** A user error: printed without a stack trace, exit code 1. */
export class UsageError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export const createContext = (cwd: string = process.cwd()): Context => {
  const root = repoRoot(cwd)
  const config = loadConfig(root)

  return { root, config, outDir: join(root, config.outDir), ts }
}

/** Parse `--top` style integers. */
export const positiveInt = (
  value: string | undefined,
  fallback: number
): number => {
  if (value === undefined) {
    return fallback
  }

  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`Expected a positive integer, got "${value}".`)
  }

  return parsed
}

/** Elapsed seconds since `started`, a `performance.now()` reading. */
export const secondsSince = (started: number): string =>
  ((performance.now() - started) / 1000).toFixed(1)
