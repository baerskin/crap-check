import { spawn, spawnSync } from "node:child_process"

/**
 * Git process helpers that run the same under Node and Bun.
 *
 * Every git call in the tool goes through here, so the runtime port is one file.
 */

/** Large enough for `ls-tree -r` and `log` on a big monorepo. */
const MAX_BUFFER = 512 * 1024 * 1024

const run = (root: string, args: string[], env?: Record<string, string>) =>
  spawnSync("git", args, {
    cwd: root,
    env: env === undefined ? process.env : { ...process.env, ...env },
    maxBuffer: MAX_BUFFER,
    encoding: "utf8",
  })

/** Run git and return stdout. Throws with git's stderr when git fails. */
export const git = (
  root: string,
  args: string[],
  env?: Record<string, string>
): string => {
  const result = run(root, args, env)

  if (result.error !== undefined) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
  }

  return result.stdout
}

/** Run git and return trimmed stdout, or `""` when git fails. */
export const gitText = (
  root: string,
  args: string[],
  env?: Record<string, string>
): string => {
  const result = run(root, args, env)

  return result.status === 0 ? result.stdout.trim() : ""
}

/** The repository root of the current directory. Throws outside a work tree. */
export const repoRoot = (cwd: string = process.cwd()): string => {
  const root = gitText(cwd, ["rev-parse", "--show-toplevel"])

  if (root === "") {
    throw new Error("Not a git work tree.")
  }

  return root
}

/**
 * Spawn git with `input` on stdin and stream stdout chunks to `onChunk`.
 *
 * Writing stdin and draining stdout run concurrently, so a large input cannot
 * deadlock against a full stdout pipe.
 */
export const gitStream = ({
  root,
  args,
  input,
  onChunk,
}: {
  root: string
  args: string[]
  input: string
  onChunk: (chunk: Uint8Array) => void
}): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const errors: Buffer[] = []

    // A throwing consumer must fail the run. Left alone, the error escapes the
    // stream handler and the promise never settles, so the process hangs.
    proc.stdout.on("data", (chunk: Buffer) => {
      try {
        onChunk(chunk)
      } catch (error) {
        proc.kill()
        reject(error)
      }
    })
    proc.stderr.on("data", (chunk: Buffer) => errors.push(chunk))
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          `git ${args[0]} failed: ${Buffer.concat(errors).toString("utf8")}`
        )
      )
    })

    proc.stdin.end(input)
  })
