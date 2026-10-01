import { git, gitStream } from "./git"

/**
 * Reads historical trees straight out of the git object database.
 *
 * The weekly backfill needs every source file's content at every sampled
 * commit. Checking each one out would cost a working-tree write per file and
 * block anything else running.
 *
 * `ls-tree` plus `cat-file --batch` reads the same bytes with no checkout. The
 * blob id is a content hash, so a file that did not change is parsed once: on a
 * 3,000-file monorepo, 162,459 (blob, path) pairs across 141 weeks collapse to
 * about 15,000 unique blobs.
 */

/** One week of history, and the commit that represents it. */
export interface WeekPoint {
  /** ISO week key, `2026-W35`. Emitted by git, never computed here. */
  week: string
  /** Commit date, ISO 8601. */
  date: string
  commit: string
}

/** One entry of a tree listing. */
export interface TreeEntry {
  oid: string
  path: string
}

const decoder = new TextDecoder()

/**
 * A byte view over any buffer kind.
 *
 * A stream chunk is `Uint8Array<ArrayBufferLike>`; `new Uint8Array(n)` is
 * `Uint8Array<ArrayBuffer>`. Recent TypeScript does not assign one to the other.
 */
type Bytes = Uint8Array<ArrayBufferLike>

/**
 * The newest commit of every ISO week on `ref`, oldest week first.
 *
 * Git formats the week key itself (`%G-W%V` under `TZ=UTC`), keeping date
 * arithmetic out of TypeScript. Git logs newest first, so the first commit
 * seen for a week is kept and the rest dropped.
 *
 * Uses the committer date, not the author date: git orders the log by it,
 * and a rebased commit can carry an author date from an earlier week.
 *
 * Walks first-parent only: on a branch that receives merges, the first-parent
 * chain is the sequence of states the branch itself was in. Walking every
 * reachable commit would sample trees that only existed on a feature branch.
 *
 * A week with no merge is absent; carrying a value forward is a read-time
 * choice, not something to bake into the data.
 */
export const weekPoints = (root: string, ref: string): WeekPoint[] => {
  const log = git(
    root,
    [
      "log",
      "--first-parent",
      ref,
      "--date=format-local:%G-W%V",
      "--format=%cd %cI %H",
    ],
    { TZ: "UTC" }
  )

  const seen = new Set<string>()
  const points: WeekPoint[] = []

  for (const row of log.split("\n")) {
    const [week, date, commit] = row.split(" ")

    if (week === undefined || date === undefined || commit === undefined) {
      continue
    }

    if (!seen.has(week)) {
      seen.add(week)
      points.push({ week, date, commit })
    }
  }

  return points.toReversed()
}

/**
 * Every blob in a commit's tree.
 *
 * `-z` is required: without it, git quotes a path with a space or a
 * non-ASCII byte, and the split then produces a path matching no file.
 */
export const listTree = (root: string, commit: string): TreeEntry[] =>
  git(root, ["ls-tree", "-r", "-z", "--format=%(objectname) %(path)", commit])
    .split("\0")
    .filter((row) => row !== "")
    .map((row): TreeEntry => {
      const space = row.indexOf(" ")

      return { oid: row.slice(0, space), path: row.slice(space + 1) }
    })

const NEWLINE = 0x0a

/**
 * Cuts `<oid> <type> <size>\n<payload>\n` records out of a `cat-file --batch`
 * stream. Returns the tail that did not form a whole record, to prepend to
 * the next chunk. Kept separate from the process handling so the framing can
 * be tested against the cases that break a naive reader.
 *
 * Every offset is a byte offset: `size` is in bytes and the payload is
 * UTF-8, so counting characters would truncate a non-ASCII file and could
 * misread a payload line as a header.
 */
export const parseBatch = (
  buffer: Bytes,
  emit: (oid: string, body: Bytes) => void
): Bytes => {
  let offset = 0

  for (;;) {
    const newline = buffer.indexOf(NEWLINE, offset)

    if (newline === -1) {
      break
    }

    const header = decoder.decode(buffer.subarray(offset, newline)).split(" ")
    const [oid, kind, size] = header

    if (oid === undefined || kind === undefined) {
      break
    }

    // `<oid> missing` has no payload: git returns that for an object it
    // cannot resolve, e.g. a shallow clone.
    if (size === undefined) {
      offset = newline + 1
      continue
    }

    const start = newline + 1
    const end = start + Number(size)

    // The record needs its payload and the newline git writes after it.
    if (buffer.length < end + 1) {
      break
    }

    emit(oid, buffer.subarray(start, end))
    offset = end + 1
  }

  return buffer.subarray(offset)
}

/** How many object ids go into one `cat-file --batch` call. */
export const BATCH_SIZE = 1_000

const concat = (left: Bytes, right: Bytes): Bytes => {
  if (left.length === 0) {
    return right
  }

  const joined = new Uint8Array(left.length + right.length)

  joined.set(left)
  joined.set(right, left.length)

  return joined
}

/**
 * Reads many blobs, calling back with each one's text.
 *
 * One `cat-file --batch` process per chunk of `BATCH_SIZE` ids, so a backfill of
 * tens of thousands of blobs never holds one huge stdin or stdout in flight.
 */
export const readBlobs = async (
  root: string,
  oids: string[],
  onBlob: (oid: string, text: string) => void
): Promise<void> => {
  for (let index = 0; index < oids.length; index += BATCH_SIZE) {
    const chunk = oids.slice(index, index + BATCH_SIZE)

    let tail: Bytes = new Uint8Array(0)

    await gitStream({
      root,
      args: ["cat-file", "--batch"],
      input: `${chunk.join("\n")}\n`,
      onChunk: (part) => {
        tail = parseBatch(concat(tail, part), (oid, body) =>
          onBlob(oid, decoder.decode(body))
        )
      },
    })
  }
}
