/**
 * Minimal glob matching for repo-relative POSIX paths.
 *
 * Supports `**` (any number of path segments, including none), `*` (anything but
 * `/`), `?` (one character but `/`) and `{a,b}` alternation. A pattern matches the
 * whole path, so `dist/**` matches only a top-level `dist` and `**\/dist/**`
 * matches one at any depth. That is the subset the config needs; a dependency
 * would cost more than these lines.
 */

const SPECIAL = /[.+^$()|[\]\\]/

/** Compile one glob into an anchored regular expression. */
export const globToRegExp = (pattern: string): RegExp => {
  let source = ""
  let depth = 0

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string

    if (char === "*" && pattern[index + 1] === "*") {
      const slashAfter = pattern[index + 2] === "/"
      const atSegmentStart = index === 0 || pattern[index - 1] === "/"

      // `**/` at a segment start also matches zero segments.
      if (slashAfter && atSegmentStart) {
        source += "(?:.*/)?"
        index += 2
      } else {
        source += ".*"
        index += 1
      }

      continue
    }

    if (char === "*") {
      source += "[^/]*"
    } else if (char === "?") {
      source += "[^/]"
    } else if (char === "{") {
      depth += 1
      source += "(?:"
    } else if (char === "}" && depth > 0) {
      depth -= 1
      source += ")"
    } else if (char === "," && depth > 0) {
      source += "|"
    } else if (SPECIAL.test(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }

  if (depth !== 0) {
    throw new Error(`Unbalanced "{" in glob: ${pattern}`)
  }

  return new RegExp(`^${source}$`)
}

/** Compile many globs into one predicate. An empty list matches nothing. */
export const matcher = (
  patterns: readonly string[]
): ((path: string) => boolean) => {
  const compiled = patterns.map(globToRegExp)

  return (path) => compiled.some((pattern) => pattern.test(path))
}
