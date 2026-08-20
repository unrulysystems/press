/**
 * Starlark scanning for Tilt resource supervision.
 *
 * A `local_resource` with a `serve_cmd` starts a long-running process that Tilt
 * does not drain when it dies ungracefully: the server reparents to init and
 * keeps its port. `janitor_local_resource` wraps `serve_cmd` with janitor so the
 * process group is torn down when Tilt goes away.
 */

/** Callees that supervise their `serve_cmd` process group. */
export const SUPERVISED_SERVE_CALLEES: ReadonlySet<string> = new Set(['janitor_local_resource'])

export type ServeResource = {
  /** The function invoked, e.g. `local_resource`. */
  readonly callee: string
  /** First positional string argument, when it is a literal. */
  readonly name: string | null
  /** 1-indexed line of the call. */
  readonly line: number
}

const isIdentStart = (ch: string): boolean =>
  ch === '_' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')

const isIdentPart = (ch: string): boolean => isIdentStart(ch) || (ch >= '0' && ch <= '9')

/** Index just past the string literal opening at `start`. */
const skipString = (source: string, start: number): number => {
  const triple = source.slice(start, start + 3)
  const delim = triple === "'''" || triple === '"""' ? triple : source[start]
  if (delim === undefined) return source.length
  let index = start + delim.length
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source.startsWith(delim, index)) return index + delim.length
    index += 1
  }
  return source.length
}

/** Index just past the line comment starting at `start`. */
const skipComment = (source: string, start: number): number => {
  const newline = source.indexOf('\n', start)
  return newline === -1 ? source.length : newline
}

const isStringStart = (ch: string | undefined): boolean => ch === "'" || ch === '"'

/**
 * Text between the parentheses of the call whose `(` sits at `open`, or null
 * when the call is unterminated.
 */
const readArgs = (source: string, open: number): string | null => {
  let depth = 0
  let index = open
  while (index < source.length) {
    const ch = source[index] as string
    if (ch === '#') {
      index = skipComment(source, index)
      continue
    }
    if (isStringStart(ch)) {
      index = skipString(source, index)
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1
      index += 1
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1
      index += 1
      if (depth === 0) return source.slice(open + 1, index - 1)
      continue
    }
    index += 1
  }
  return null
}

/** True when `keyword=` appears as an argument of this call, not a nested one. */
const hasTopLevelKeyword = (argsText: string, keyword: string): boolean => {
  let depth = 0
  let index = 0
  while (index < argsText.length) {
    const ch = argsText[index] as string
    if (ch === '#') {
      index = skipComment(argsText, index)
      continue
    }
    if (isStringStart(ch)) {
      index = skipString(argsText, index)
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1
      index += 1
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1
      index += 1
      continue
    }
    if (depth === 0 && isIdentStart(ch)) {
      let end = index
      while (end < argsText.length && isIdentPart(argsText[end] as string)) end += 1
      if (argsText.slice(index, end) === keyword) {
        let after = end
        while (after < argsText.length && /\s/.test(argsText[after] as string)) after += 1
        // `==` is a comparison, not a keyword argument.
        if (argsText[after] === '=' && argsText[after + 1] !== '=') return true
      }
      index = end
      continue
    }
    index += 1
  }
  return false
}

/** The first positional argument when it is a string literal, else null. */
const firstPositionalString = (argsText: string): string | null => {
  let index = 0
  while (index < argsText.length && /\s/.test(argsText[index] as string)) index += 1
  if (!isStringStart(argsText[index])) return null
  const end = skipString(argsText, index)
  const quote =
    argsText.slice(index, index + 3) === "'''" || argsText.slice(index, index + 3) === '"""' ? 3 : 1
  return argsText.slice(index + quote, end - quote)
}

const lineOf = (source: string, index: number): number => {
  let line = 1
  for (let i = 0; i < index; i += 1) if (source[i] === '\n') line += 1
  return line
}

/** Every call in `source` that declares a `serve_cmd`. */
export const findServeResources = (source: string): readonly ServeResource[] => {
  const found: ServeResource[] = []
  let index = 0
  while (index < source.length) {
    const ch = source[index] as string
    if (ch === '#') {
      index = skipComment(source, index)
      continue
    }
    if (isStringStart(ch)) {
      index = skipString(source, index)
      continue
    }
    if (!isIdentStart(ch)) {
      index += 1
      continue
    }
    let end = index
    while (end < source.length && isIdentPart(source[end] as string)) end += 1
    let open = end
    while (open < source.length && /\s/.test(source[open] as string)) open += 1
    if (source[open] === '(') {
      const argsText = readArgs(source, open)
      if (argsText !== null && hasTopLevelKeyword(argsText, 'serve_cmd')) {
        found.push({
          callee: source.slice(index, end),
          name: firstPositionalString(argsText),
          line: lineOf(source, index),
        })
      }
    }
    // Resume just past the identifier so nested calls are scanned too.
    index = end
  }
  return found
}

/** Serve resources whose process group nothing tears down when Tilt dies. */
export const findUnsupervisedServeResources = (source: string): readonly ServeResource[] =>
  findServeResources(source).filter((resource) => !SUPERVISED_SERVE_CALLEES.has(resource.callee))
