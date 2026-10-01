import { describe, expect, it } from "bun:test"
import ts from "typescript"
import { analyze } from "../src/lib/analyze"

/**
 * Cognitive complexity has no oracle here: no ESLint rule exists to compare
 * against, and the plan rejected `eslint-plugin-sonarjs` as one. The whitepaper's
 * own worked examples are the next best thing, so the first block below
 * transcribes them with their published totals: if our walk disagrees, our walk
 * is wrong.
 *
 * @see https://www.sonarsource.com/docs/CognitiveComplexity.pdf (v1.7, 2023-08-29)
 */

/** The file's score: top-level units plus anything at module scope. */
const score = (source: string, path = "t.ts"): number =>
  analyze(path, source, ts).cognitiveTotal

/** One named unit's score, inclusive of everything nested inside it. */
const unit = (source: string, name: string): number => {
  const found = analyze("t.ts", source, ts).units.filter(
    (candidate) => candidate.name === name
  )

  expect(found).toHaveLength(1)

  return (found[0] as { cognitive: number }).cognitive
}

describe("cognitive — the whitepaper's worked examples", () => {
  it("scores the motivating pair: sumOfPrimes 7, getWords 1", () => {
    // Page 10. Identical cyclomatic complexity (4), and nobody believes they
    // are equally hard to read. This pair is the whole argument for the metric.
    const sumOfPrimes = `
      function sumOfPrimes(max: number) {
        let total = 0

        OUT: for (let i = 1; i <= max; ++i) {
          for (let j = 2; j < i; ++j) {
            if (i % j === 0) {
              continue OUT
            }
          }

          total += i
        }

        return total
      }
    `

    const getWords = `
      function getWords(n: number) {
        switch (n) {
          case 1:
            return "one"
          case 2:
            return "a couple"
          case 3:
            return "a few"
          default:
            return "lots"
        }
      }
    `

    expect(score(sumOfPrimes)).toBe(7)
    expect(score(getWords)).toBe(1)
  })

  it("scores myMethod at 9: try is free, catch is not", () => {
    // Page 9. `try` costs nothing and opens no nesting level, while the `catch`
    // that follows it does both.
    const source = `
      function myMethod() {
        try {
          if (condition1) {
            for (let i = 0; i < 10; i++) {
              while (condition2) { work() }
            }
          }
        } catch (e) {
          if (condition2) { work() }
        }
      }
    `

    expect(score(source)).toBe(9)
  })

  it("scores myMethod2 at 2: a lambda is free, and still nests", () => {
    const source = `
      function myMethod2() {
        const r = () => {
          if (condition1) { work() }
        }
      }
    `

    expect(score(source)).toBe(2)
  })

  it("scores model.js from YUI at 20", () => {
    // Appendix C, the one JavaScript example, transcribed as written: two
    // callbacks deep, a ternary at depth, an `else`, and three logical sequences.
    const source = `
      const Model = {
        save: function (options, callback) {
          var self = this

          if (typeof options === 'function') {
            callback = options
            options = {}
          }

          options || (options = {})

          self._validate(self.toJSON(), function (err) {
            if (err) {
              callback && callback.call(null, err)
              return
            }

            self.sync(self.isNew() ? 'create' : 'update', options, function (err, response) {
              var facade = { options: options, response: response },
                parsed

              if (err) {
                facade.error = err
                facade.src = 'save'
                self.fire(EVT_ERROR, facade)
              } else {
                if (!self._saveEvent) {
                  self._saveEvent = self.publish(EVT_SAVE, { preventable: false })
                }

                if (response) {
                  parsed = facade.parsed = self._parse(response)
                  self.setAttrs(parsed, options)
                }

                self.changed = {}
                self.fire(EVT_SAVE, facade)
              }

              callback && callback.apply(null, arguments)
            })
          })

          return self
        }
      }
    `

    expect(score(source)).toBe(20)
    expect(unit(source, "save")).toBe(20)
  })

  it("scores toRegexp from SonarQube at 20", () => {
    // Appendix C again, for the `else if` chain: six branches, each a flat +1,
    // and the nesting they open still charges the `if`s below them.
    const source = `
      function toRegexp(antPattern: string, separator: string) {
        const escaped = '\\\\' + separator
        const sb = []

        let i = antPattern.startsWith("/") || antPattern.startsWith("\\\\") ? 1 : 0

        while (i < antPattern.length) {
          const ch = antPattern.charAt(i)

          if (SPECIAL_CHARS.indexOf(ch) !== -1) {
            sb.push('\\\\', ch)
          } else if (ch === '*') {
            if (i + 1 < antPattern.length && antPattern.charAt(i + 1) === '*') {
              if (i + 2 < antPattern.length && isSlash(antPattern.charAt(i + 2))) {
                sb.push("(?:.*", escaped, "|)")
                i += 2
              } else {
                sb.push(".*")
                i += 1
              }
            } else {
              sb.push("[^", escaped, "]*?")
            }
          } else if (ch === '?') {
            sb.push("[^", escaped, "]")
          } else if (isSlash(ch)) {
            sb.push(escaped)
          } else {
            sb.push(ch)
          }

          i++
        }

        return sb.join('')
      }
    `

    expect(score(source)).toBe(20)
  })
})

describe("cognitive — one rule at a time", () => {
  it("charges a structural increment once per nesting level", () => {
    expect(score("function f() { if (a) { work() } }")).toBe(1)
    expect(score("function f() { if (a) { if (b) { work() } } }")).toBe(3)
    expect(
      score("function f() { if (a) { if (b) { if (c) { work() } } } }")
    ).toBe(6)
  })

  it("charges else and else if flat, and still nests them", () => {
    // Three branches of one decision read as one thing. Three separate `if`s
    // do not, which is why the second line costs more than the first.
    expect(
      score("function f() { if (a) { x() } else if (b) { y() } else { z() } }")
    ).toBe(3)
    expect(
      score("function f() { if (a) { x() } if (b) { y() } if (c) { z() } }")
    ).toBe(3)
    // The `else` opens a level, so the `if` inside it pays 2.
    expect(
      score("function f() { if (a) { x() } else { if (b) { y() } } }")
    ).toBe(4)
  })

  it("charges a switch once, whatever the case count", () => {
    const cases = Array.from(
      { length: 30 },
      (_, index) => `case ${index}: return ${index}`
    ).join("\n")
    const source = `function f(n: number) { switch (n) { ${cases} } }`
    const file = analyze("t.ts", source, ts)

    // The blind spot `docs/code-complexity.md` admits, closed: 31 cyclomatic
    // for a table anyone can read at a glance, 1 cognitive.
    expect(file.units[0]?.complexity).toBe(31)
    expect(file.cognitiveTotal).toBe(1)
  })

  it("nests the body of a switch case", () => {
    expect(
      score("function f(n) { switch (n) { case 1: if (a) { x() } } }")
    ).toBe(3)
  })

  it("charges every loop form, and its body nests", () => {
    expect(score("function f() { for (;;) { work() } }")).toBe(1)
    expect(score("function f() { for (const a in b) { work() } }")).toBe(1)
    expect(score("function f() { for (const a of b) { work() } }")).toBe(1)
    expect(score("function f() { while (a) { work() } }")).toBe(1)
    expect(score("function f() { do { work() } while (a) }")).toBe(1)
    expect(score("function f() { for (;;) { if (a) { work() } } }")).toBe(3)
  })

  it("charges catch but not try or finally", () => {
    expect(score("function f() { try { work() } finally { close() } }")).toBe(0)
    expect(
      score("function f() { try { work() } catch (e) { report(e) } }")
    ).toBe(1)
    expect(
      score("function f() { try { work() } catch (e) { if (a) { x() } } }")
    ).toBe(3)
  })

  it("charges a ternary structurally, and nests both branches", () => {
    expect(score("function f() { return a ? b : c }")).toBe(1)
    expect(score("function f() { return a ? (b ? c : d) : e }")).toBe(3)
    expect(score("function f() { if (a) { return b ? c : d } }")).toBe(3)
  })

  it("charges a labelled jump, and nothing for a bare one", () => {
    expect(score("function f() { for (;;) { break } }")).toBe(1)
    expect(score("function f() { for (;;) { continue } }")).toBe(1)
    expect(score("function f() { OUT: for (;;) { break OUT } }")).toBe(2)
    expect(score("function f() { OUT: for (;;) { continue OUT } }")).toBe(2)
    // An early return is how you avoid nesting, so charging for it would push
    // people the wrong way.
    expect(score("function f() { if (a) { return 1 } return 2 }")).toBe(1)
  })

  it("charges one increment per run of like logical operators", () => {
    // A longer chain of one operator is barely harder to read than a short one,
    // so length is free and only the changes of operator cost anything.
    expect(score("function f() { return a && b }")).toBe(1)
    expect(score("function f() { return a && b && c && d }")).toBe(1)
    expect(score("function f() { return a || b || c || d }")).toBe(1)
  })

  it("charges each new run when the operators mix", () => {
    // Both fixtures are printed in the whitepaper with their increments, page 8.
    // `a && b && c` (+1), `|| d || e` (+1), `&& f` (+1), plus the `if`.
    expect(
      score("function f() { if (a && b && c || d || e && f) { work() } }")
    ).toBe(4)
    // A negation ends a run too: `a && !(…)` (+1), then `b && c` inside it (+1).
    expect(score("function f() { if (a && !(b && c)) { work() } }")).toBe(3)
    // Runs are counted as written, so parentheses that only restate the
    // precedence change nothing.
    expect(score("function f() { return a && b || c && d }")).toBe(3)
    expect(score("function f() { return (a && b) || (c && d) }")).toBe(3)
  })

  it("reads one run through any number of wrappers", () => {
    // A spare parenthesis or cast changes no control flow, so it must not split
    // one run into two. TypeScript's AST keeps both; ESTree, which Sonar's rule
    // walks, has no parenthesis node at all.
    expect(score("function f() { return a && (b && c) }")).toBe(1)
    expect(score("function f() { return a && ((b && c)) }")).toBe(1)
    expect(score("function f() { return ((a && b)) && c }")).toBe(1)
    expect(score("function f() { return a && ((b && c) as boolean) }")).toBe(1)
  })

  it("charges a logical sequence flat, whatever its depth", () => {
    expect(score("function f() { if (x) { if (y) { return a && b } } }")).toBe(
      4
    )
  })

  it("ignores the shorthand that makes code shorter to read", () => {
    // Rule 1 of the whitepaper. Each of these replaces an `if` a reader would
    // otherwise have to follow, so charging for them would be backwards.
    expect(score("function f() { return a ?? b }")).toBe(0)
    expect(score("function f() { return a?.b?.c }")).toBe(0)
    expect(score("function f(a = 1, { b = 2 } = {}) { return a + b }")).toBe(0)
    expect(score("function f() { a ||= b; a &&= c; a ??= d }")).toBe(0)
    expect(score("function f() { throw new Error('nope') }")).toBe(0)
  })

  it("charges nothing for declaring a unit", () => {
    // No cost of entry is what keeps the file and workspace sums meaningful:
    // splitting one function into three does not invent complexity.
    expect(score("function f() {}")).toBe(0)
    expect(
      score("const f = () => {}; const g = () => {}; class C { m() {} }")
    ).toBe(0)
  })
})

describe("cognitive — attribution", () => {
  it("scores a top-level unit inclusive and a nested one standalone", () => {
    const source = `
      function outer() {
        items.forEach((item) => {
          if (item) { work(item) }
        })
      }
    `

    // The same `if`, read two ways: 2 to whoever reads `outer` top to bottom,
    // 1 to whoever reads the callback on its own.
    expect(unit(source, "outer")).toBe(2)
    expect(unit(source, "<anonymous>")).toBe(1)
    expect(score(source)).toBe(2)
  })

  it("counts each increment once in the file total", () => {
    const source = `
      function a() {
        run(() => {
          if (x) { work() }
        })
      }

      function b() {
        if (y) { work() }
      }
    `

    // Nested units are already inside their owner's score, so only top-level
    // units are summed. 2 + 1, not 2 + 1 + 1.
    expect(score(source)).toBe(3)
  })

  it("marks the owner of every unit", () => {
    const file = analyze(
      "t.ts",
      "function outer() { const inner = () => { const deep = () => {} } }",
      ts
    )
    const owners = file.units.map((found) => [found.name, found.owner])

    expect(owners).toEqual([
      ["outer", -1],
      ["inner", 0],
      ["deep", 1],
    ])
  })

  it("does not let a class field double the nesting of its arrow", () => {
    // `field = () => {}` is two cyclomatic units and one function. Charging a
    // nesting level for both would tax a style choice.
    const source = `
      class C {
        handle = () => {
          if (a) { work() }
        }
      }
    `

    expect(score(source)).toBe(1)
  })

  it("steps the field aside however the function is wrapped", () => {
    // Same code, four spellings. A parenthesis or a cast is not a decision, so
    // none of them may open a second frame and charge the body twice.
    const body = "() => { if (a) { work() } }"

    expect(score(`class C { handle = ${body} }`)).toBe(1)
    expect(score(`class C { handle = (${body}) }`)).toBe(1)
    expect(score(`class C { handle = (${body}) as Fn }`)).toBe(1)
    expect(score(`class C { handle = (${body}) satisfies Fn }`)).toBe(1)
  })

  it("counts increments at module scope, where ESLint cannot see them", () => {
    const file = analyze(
      "t.ts",
      "if (Bun.env.DEBUG) { if (verbose) { log() } }",
      ts
    )

    expect(file.cognitiveModule).toBe(3)
    expect(file.cognitiveTotal).toBe(3)
  })

  it("keeps module scope and unit scope apart", () => {
    const source = `
      if (a) { boot() }

      function f() {
        if (b) { if (c) { work() } }
      }
    `
    const file = analyze("t.ts", source, ts)

    expect(file.cognitiveModule).toBe(1)
    expect(file.cognitiveTotal).toBe(4)
    expect(file.cognitiveMax).toBe(3)
  })

  it("reports the worst top-level unit", () => {
    const source = `
      function small() { if (a) { work() } }
      function big() { if (a) { if (b) { work() } } }
    `

    expect(analyze("t.ts", source, ts).cognitiveMax).toBe(3)
  })

  it("reports 0 for a file that declares nothing", () => {
    const file = analyze("t.ts", "export const NAME = 'x'\n", ts)

    expect(file.cognitiveTotal).toBe(0)
    expect(file.cognitiveMax).toBe(0)
    expect(file.cognitiveModule).toBe(0)
  })
})
