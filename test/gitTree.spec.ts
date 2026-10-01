import { afterAll, describe, expect, it } from "bun:test"
import { listTree, parseBatch, readBlobs, weekPoints } from "../src/lib/gitTree"
import { createFixture } from "./fixture"

/**
 * `parseBatch` is the part worth testing hardest: the framing looks trivial and is
 * not, with a size in bytes over UTF-8 content, a payload that can contain anything
 * including a line shaped like a header, and a stream that splits wherever the pipe
 * decides to split it.
 */

const encoder = new TextEncoder()

/** One `<oid> blob <size>\n<payload>\n` record, sized in bytes as git sizes it. */
const record = (oid: string, payload: string): Uint8Array => {
  const body = encoder.encode(payload)
  const header = encoder.encode(`${oid} blob ${body.length}\n`)
  const out = new Uint8Array(header.length + body.length + 1)

  out.set(header)
  out.set(body, header.length)
  out.set(encoder.encode("\n"), header.length + body.length)

  return out
}

const join_ = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0

  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }

  return out
}

const drain = (chunks: Uint8Array[]): Map<string, string> => {
  const decoder = new TextDecoder()
  const seen = new Map<string, string>()
  let tail: Uint8Array<ArrayBufferLike> = new Uint8Array(0)

  for (const chunk of chunks) {
    tail = parseBatch(join_(tail, chunk), (oid, body) =>
      seen.set(oid, decoder.decode(body))
    )
  }

  return seen
}

describe("parseBatch", () => {
  it("reads consecutive records", () => {
    const seen = drain([join_(record("aaa", "one"), record("bbb", "two"))])

    expect([...seen]).toEqual([
      ["aaa", "one"],
      ["bbb", "two"],
    ])
  })

  it("sizes a multi-byte payload in bytes, not characters", () => {
    // "é" is two bytes. Counting characters would cut the record one byte short
    // and desynchronise every record after it.
    const seen = drain([join_(record("aaa", "café ☕"), record("bbb", "next"))])

    expect(seen.get("aaa")).toBe("café ☕")
    expect(seen.get("bbb")).toBe("next")
  })

  it("survives a payload holding a line that looks like a header", () => {
    // The fake header must sit on a line of its own, so a parser that rescans for
    // the next header instead of trusting the byte size reads it and desynchronises.
    const payload = "const fake = `\nbbb blob 4\nboom`\n"
    const seen = drain([join_(record("aaa", payload), record("bbb", "real"))])

    expect(seen.get("aaa")).toBe(payload)
    expect(seen.get("bbb")).toBe("real")
    expect(seen.size).toBe(2)
  })

  it("holds a record split across two chunks until it is whole", () => {
    const whole = join_(record("aaa", "hello world"), record("bbb", "second"))
    const cut = 9

    expect(drain([whole.subarray(0, cut), whole.subarray(cut)])).toEqual(
      new Map([
        ["aaa", "hello world"],
        ["bbb", "second"],
      ])
    )
  })

  it("holds a header split mid-line", () => {
    const whole = record("aaa", "hello")

    expect(drain([whole.subarray(0, 4), whole.subarray(4)])).toEqual(
      new Map([["aaa", "hello"]])
    )
  })

  it("skips a missing object and keeps reading", () => {
    const seen = drain([
      join_(encoder.encode("deadbeef missing\n"), record("bbb", "still here")),
    ])

    expect([...seen]).toEqual([["bbb", "still here"]])
  })

  it("returns the unconsumed tail", () => {
    const partial = record("aaa", "hello").subarray(0, 6)

    expect(parseBatch(partial, () => undefined)).toEqual(partial)
  })
})

describe("readBlobs and listTree", () => {
  const fixture = createFixture()
  // A multi-byte payload, so a byte-length frame and a character count differ.
  const content = 'export const greet = () => "héllo ✓"\n'

  fixture.commit({
    files: { "package.json": "{}\n", "src/a.ts": content },
    message: "first",
    at: "2026-01-05T09:00:00Z",
  })

  afterAll(fixture.remove)

  it("lists paths and object ids for a commit", () => {
    const entries = listTree(fixture.dir, "HEAD")

    expect(entries.map((entry) => entry.path).toSorted()).toEqual([
      "package.json",
      "src/a.ts",
    ])
    expect(entries.every((entry) => /^[0-9a-f]{40}$/.test(entry.oid))).toBe(
      true
    )
  })

  it("reads a real blob out of the object database", async () => {
    const entries = listTree(fixture.dir, "HEAD")
    const seen = new Map<string, string>()

    await readBlobs(
      fixture.dir,
      entries.map((entry) => entry.oid),
      (oid, text) => seen.set(oid, text)
    )

    const source = entries.find((entry) => entry.path === "src/a.ts")

    expect(seen.get(source?.oid ?? "")).toBe(content)
    expect(seen.size).toBe(2)
  })

  it("rejects, and does not hang, when the consumer throws", async () => {
    const entries = listTree(fixture.dir, "HEAD")

    await expect(
      readBlobs(
        fixture.dir,
        entries.map((entry) => entry.oid),
        () => {
          throw new Error("consumer failed")
        }
      )
    ).rejects.toThrow("consumer failed")
  })
})

/**
 * A history this file writes. It isolates two rules a real log cannot: the
 * newest commit of a week represents it, and a week that exists only off the
 * first-parent line is not a week at all.
 */
const historyFixture = () => {
  const fixture = createFixture()
  const commit = (message: string, at: string): void =>
    fixture.commit({ files: { "file.txt": `${message}\n` }, message, at })

  // 2025-12-29 and 2026-01-02 are both 2026-W01, so the second one wins it.
  commit("first", "2025-12-29T09:00:00Z")
  commit("second", "2026-01-02T09:00:00Z")

  // 2026-W02 exists only on the side branch, so a first-parent walk never sees it.
  fixture.git(["checkout", "-q", "-b", "side"])
  commit("side", "2026-01-08T09:00:00Z")
  fixture.git(["checkout", "-q", "main"])
  fixture.git(
    ["merge", "--no-ff", "-q", "-m", "merge side", "side"],
    "2026-01-15T09:00:00Z"
  )

  commit("last", "2026-02-16T09:00:00Z")

  return fixture
}

describe("weekPoints", () => {
  const fixture = historyFixture()
  const { dir } = fixture

  afterAll(fixture.remove)

  it("returns the newest commit of every ISO week, oldest week first", () => {
    const points = weekPoints(dir, "main")

    expect(points.map((point) => point.week)).toEqual([
      "2026-W01",
      "2026-W03",
      "2026-W08",
    ])

    const subject = (commit: string): string =>
      fixture.git(["show", "-s", "--format=%s", commit]).trim()

    // "second", not "first": both are 2026-W01 and the newer one represents it.
    expect(points.map((point) => subject(point.commit))).toEqual([
      "second",
      "merge side",
      "last",
    ])
  })

  it("skips a week that exists only off the first-parent line", () => {
    // The side commit is 2026-W02 and is reachable, but the main line was never
    // in that state: it arrived as part of the merge that 2026-W03 carries.
    expect(weekPoints(dir, "main").map((point) => point.week)).not.toContain(
      "2026-W02"
    )
    expect(weekPoints(dir, "side").map((point) => point.week)).toContain(
      "2026-W02"
    )
  })

  it("reports the commit date of the commit it picked", () => {
    const [first] = weekPoints(dir, "main")

    // Git writes the zero offset as `Z` here and as `+00:00` on other versions.
    expect(first?.date).toMatch(/^2026-01-02T09:00:00(Z|\+00:00)$/)
  })
})
