import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/**
 * A throwaway git repository for specs that read history.
 *
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` point at `/dev/null` so no hooks
 * path, signing key or local convention reaches the fixture. Dates are pinned
 * per commit, so week keys are deterministic.
 */
export interface Fixture {
  dir: string
  /** Run git in the fixture. Throws on a non-zero exit. Returns stdout. */
  git: (args: string[], at?: string) => string
  /** Write files (path to content) without committing. */
  write: (files: Record<string, string>) => void
  /** Write files, stage everything, and commit at `at`. */
  commit: (params: {
    files: Record<string, string>
    message: string
    at: string
  }) => void
  remove: () => void
}

export const createFixture = (): Fixture => {
  const dir = mkdtempSync(join(tmpdir(), "crap-check-fixture-"))
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  }

  const git = (args: string[], at?: string): string => {
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env:
        at === undefined ? env : (
          { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }
        ),
    })

    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
    }

    return result.stdout
  }

  const write = (files: Record<string, string>): void => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
  }

  git(["init", "-q", "-b", "main"])
  git(["config", "user.name", "Fixture"])
  git(["config", "user.email", "fixture@example.com"])

  return {
    dir,
    git,
    write,
    commit: ({ files, message, at }) => {
      write(files)
      git(["add", "-A"])
      git(["commit", "-q", "-m", message], at)
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  }
}
