// check-comments.ts: reports what the documentation rules of CONTRIBUTING.md still miss.
//
// Objective
//   Make "every file, function and line is documented" something a command can verify. The
//   script walks the tracked source files and reports: files without a header, functions and
//   exported declarations without a JSDoc block, lines of code without a comment above or
//   beside them, and configuration files without their sidecar README.
//
// Dependencies
//   node:fs: readdirSync and statSync to walk the roots, readFileSync to read each file,
//   existsSync to look for the sidecar READMEs. node:path: join to build paths, relative and
//   sep to print them with forward slashes. No package.
//
// Consumers
//   `npm run check:comments` (package.json), run by whoever changes the code and before every
//   commit. Nothing imports this file.
//
// How it relates to them
//   The rules are approximations of CONTRIBUTING.md, tuned to this code base: continuation
//   lines, closing brackets and JSX attribute lines are exempt, as the conventions say. It
//   catches what is missing; it cannot tell a true comment from a false one.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * The source roots to check, relative to the working directory (the repository root): the app,
 * the scripts and the two entry points at the root. TypeScript files get the three-level
 * check, CSS files the plain one.
 */
const SOURCE_ROOTS = ['app', 'scripts', 'server.ts', 'hmr.ts']

/**
 * The configuration files and shell scripts that can carry comments and get the plain check:
 * every setting or command line needs a comment above or beside it.
 */
const CONFIG = [
  'tsconfig.json',
  '.gitignore',
  'docker/compose.yml',
  '.devcontainer/devcontainer.json',
  '.devcontainer/codespace.sh',
]

/**
 * The configuration files and the sidecar README each one must have beside it, as
 * CONTRIBUTING.md names them: the leading dot of the file name is dropped.
 */
const SIDECARS: Record<string, string> = {
  'package.json': 'package.json_README.md',
  'tsconfig.json': 'tsconfig.json_README.md',
  '.nvmrc': 'nvmrc_README.md',
  '.gitignore': 'gitignore_README.md',
  'docker/compose.yml': 'docker/compose.yml_README.md',
  '.devcontainer/devcontainer.json': '.devcontainer/devcontainer.json_README.md',
}

/**
 * A line that is only a comment: it starts with a line comment, a block comment opener, a star
 * inside a block, or the JSX comment opener.
 */
const COMMENT = /^\s*(\/\/|\/\*|\*|\{\/\*)/

/**
 * A comment beside code: a line comment or a block comment opener anywhere on the line.
 */
const INLINE = /\/\/|\/\*/

/**
 * A line that only closes something: closing brackets with optional commas or semicolons, a
 * JSX closing tag or self-closing end, the closing brace of a callback, or the backtick that
 * ends a template literal. Such lines never need a comment.
 */
const CLOSER = /^\s*[)\]}>]+[,;)]*\s*$|^\s*<\/|^\s*\/>|^\s*\}\)?;?\s*$|^\s*`/

/**
 * A code line that continues on the next one: it ends with a comma, an opening bracket, an
 * operator, a colon, an arrow or a logical operator. The next line is then exempt.
 */
const CONTINUATION_END = /[,(\[{=+?:|&]\s*$|=>\s*$|\|\|\s*$|&&\s*$|\(\s*$/

/**
 * A line that continues the previous one by its first characters: a chained call, a ternary
 * branch, an operator, a closing parenthesis, or an else, catch or finally clause.
 */
const STARTS_CONTINUED = /^\s*[.?:|&+)]|^\s*\?\?|^\s*(else|catch|finally)\b/

/**
 * A JSX attribute on its own line: a name followed by an equals sign or by nothing. Its
 * element's comment covers it.
 */
const JSX_ATTR = /^\s*[A-Za-z-]+(=|\s*$)/

/**
 * A declaration that needs a JSDoc block: a function, class, interface, type, enum, or a const
 * that is typed or assigned, with optional export, default and async. Applied at column 0 only.
 */
const DECLARATION = new RegExp(
  String.raw`^\s*(export\s+)?(default\s+)?(async\s+)?` +
    String.raw`(function\*?\s|class\s|interface\s|type\s|enum\s|const\s[A-Za-z_$][\w$]*\s*[:=])`,
)

/**
 * An import or re-export line, including the closing line of a multi-line import. The header's
 * Dependencies section covers them, so no comment is required.
 */
const IMPORT = /^\s*import\b|^\s*\}\s*from\s|^\s*export\s*\{|^\s*export\s+\*/

/**
 * The JSX pragma line that React files start with; the file header may follow it.
 */
const PRAGMA = /^\s*\/\*\*\s*@jsx/

/**
 * Lists the files to check under a root, skipping the generated bundle.
 *
 * Called by: main (this file)
 * @param root a file or folder relative to the working directory
 * @returns paths with forward slashes
 */
function files(root: string): string[] {
  // A file is returned as is.
  if (statSync(root).isFile()) return [root]
  // A folder is walked entry by entry.
  return readdirSync(root).flatMap((name) => {
    // The entry's path: the folder plus the name, in the system's separator.
    let path = join(root, name)
    // The React Flow bundle (flow-bundle.js, .js.map, .css) is built, not written: skipped.
    if (name.startsWith('flow-bundle')) return []
    // A folder is walked recursively.
    if (statSync(path).isDirectory()) return files(path)
    // A .ts, .tsx or .css file is kept; anything else is dropped.
    return /\.(tsx?|css)$/.test(name) ? [path] : []
  })
}

/**
 * Checks one TypeScript file against the three levels.
 *
 * Called by: main (this file)
 * @param path the file, for the report
 * @param lines its text, split by line
 * @returns the problems found, one line each
 */
function checkTypeScript(path: string, lines: string[]): string[] {
  // The problems found, as "path:line: message" or "path: message".
  let problems: string[] = []
  // Level 1: the header is the first comment block after an optional pragma line.
  // The index of the first line that is neither blank nor the pragma: the header starts there.
  let start = lines.findIndex((l) => l.trim() !== '' && !PRAGMA.test(l))
  // The header's text: up to 40 lines from its start, room enough for the four sections.
  let header = lines.slice(start, start + 40).join('\n')
  // An empty file, a first line that is not a line comment, or a header missing one of its two
  // mandatory sections, is one problem for the whole file.
  if (
    start < 0 ||
    !lines[start]!.startsWith('//') ||
    !/Objective/.test(header) ||
    !/Consumers/.test(header)
  ) {
    // The report names the file only, since the problem has no line.
    problems.push(`${path}: no file header with Objective and Consumers`)
  }
  // The lines inside template literals are skipped, with a simple toggle on backticks.
  let inTemplate = false
  // Whether the current line is inside a multi-line block comment, which is skipped too.
  let inBlock = false
  // The previous line of code, neither comment nor blank: continuation is judged against it.
  let prevCode = ''
  // Every line is classified in turn; i is 0-based, the report uses 1-based numbers.
  lines.forEach((line, i) => {
    // The line number for the report.
    let n = i + 1
    // The line without its surrounding whitespace.
    let t = line.trim()
    // Inside a block comment nothing is code; only its closing marker matters.
    if (inBlock) {
      // The closing marker ends the block.
      if (/\*\//.test(line)) inBlock = false
      // A comment line is never checked.
      return
    }
    // A blank line or a comment line is not code; a block opener without its closer starts one.
    if (t === '' || COMMENT.test(line)) {
      // A block comment opener with no closing marker on the same line opens a block.
      if (/^\s*\/\*/.test(line) && !/\*\//.test(line)) inBlock = true
      // Nothing else to check on a comment.
      return
    }
    // The number of backticks on the line: an odd count opens or closes a template literal.
    let ticks = (line.match(/`/g) ?? []).length
    // Inside a template literal the text is not code; an odd count closes the literal.
    if (inTemplate) {
      // The closing backtick ends the literal.
      if (ticks % 2 === 1) inTemplate = false
      // Template text is never checked.
      return
    }
    // An odd count on a code line opens a template literal that continues on the next lines.
    if (ticks % 2 === 1) inTemplate = true
    // Imports, re-exports and the pragma are covered by the header's Dependencies section.
    if (IMPORT.test(line) || PRAGMA.test(line)) {
      // The import still counts as the previous code line for continuation.
      prevCode = line
      // No comment is required on it.
      return
    }
    // Level 2: a declaration needs a JSDoc block right above it.
    // Only top-level declarations, at column 0, count; nested ones follow the line rule.
    if (DECLARATION.test(line) && !/^\s+/.test(line)) {
      // The line above, or nothing at the top of the file.
      let above = lines[i - 1] ?? ''
      // The block must end right above: its closing marker ends the previous line.
      if (!/\*\/\s*$/.test(above)) problems.push(`${path}:${n}: declaration without a JSDoc header`)
      // The declaration is the previous code line for what follows.
      prevCode = line
      // Nothing more to check on it.
      return
    }
    // Level 3: every other code line needs a comment above or beside it, unless exempt.
    // Exempt: a closer, a line that continues the previous one by its own first characters or
    // by the previous line's last ones, a JSX attribute under its element, or a bare key or
    // identifier of a literal that is not a switch label.
    let exempt =
      CLOSER.test(line) ||
      STARTS_CONTINUED.test(line) ||
      CONTINUATION_END.test(prevCode) ||
      (JSX_ATTR.test(line) && /[<,]\s*$|^\s*</.test(prevCode)) ||
      /^\s*case\b|^\s*default:/.test(line) === false && /^\s*[A-Za-z_$][\w$]*[,:]\s*$/.test(line)
    // The line above, or nothing at the top of the file.
    let above = lines[i - 1] ?? ''
    // Documented: a comment line above, a JSDoc block ending above, or a comment on the line.
    let documented = COMMENT.test(above) || /\*\/\s*$/.test(above) || INLINE.test(line)
    // A line that is neither exempt nor documented is one problem.
    if (!exempt && !documented) problems.push(`${path}:${n}: line without a comment`)
    // This line is the previous code line for the next one.
    prevCode = line
  })
  // The problems of this file.
  return problems
}

/**
 * Checks a CSS or configuration file: every rule or setting needs a comment above or beside it.
 *
 * Called by: main (this file)
 * @param path the file, for the report
 * @param lines its text, split by line
 * @returns the problems found
 */
function checkPlain(path: string, lines: string[]): string[] {
  // The problems found, one line each.
  let problems: string[] = []
  // The file's syntax decides what a comment looks like. CSS uses block comments.
  let css = path.endsWith('.css')
  // JSON with comments (tsconfig.json) uses line or block comments; the rest use a hash.
  let json = path.endsWith('.json')
  // Whether a line is only a comment, in the file's syntax.
  let isComment = (l: string) =>
    css ? /^\s*(\/\*|\*)/.test(l) : json ? /^\s*(\/\/|\/\*)/.test(l) : /^\s*#/.test(l)
  // Whether a line carries a comment beside its code, in the file's syntax.
  let hasInline = (l: string) => (css ? /\/\*/.test(l) : json ? /\/\/|\/\*/.test(l) : /#/.test(l))
  // The header: one of the first three lines must be a comment.
  if (!lines.slice(0, 3).some(isComment)) problems.push(`${path}: no header comment`)
  // Every line is classified in turn; the report uses 1-based numbers.
  lines.forEach((line, i) => {
    // The line without its surrounding whitespace.
    let t = line.trim()
    // Blank lines and comment lines are not settings.
    if (t === '' || isComment(line)) return
    // In CSS only the selector line of a rule needs a comment; in JSON and the rest, every
    // setting line does, except closing brackets.
    if (css && !/\{\s*$/.test(t)) return
    // A line that is only brackets, opening or closing, is structure, not a setting.
    if (/^[}\]]+,?$/.test(t) || /^[{[]$/.test(t)) return
    // A JSON key that opens an object or array is covered by the comment above it.
    if (json && /^"[^"]+":\s*[{[]$/.test(t) && isComment(lines[i - 1] ?? '')) return
    // The line above, or nothing at the top of the file.
    let above = lines[i - 1] ?? ''
    // A setting with neither a comment above nor one beside it is one problem.
    let documented = isComment(above) || hasInline(line)
    // An undocumented setting is reported with its position.
    if (!documented) problems.push(`${path}:${i + 1}: line without a comment`)
  })
  // The problems of this file.
  return problems
}

/**
 * Runs every check and prints the problems; exits with 1 when there are any.
 *
 * Called by: the script's own top level
 */
function main(): void {
  // The problems of every file, in file order.
  let problems: string[] = []
  // Every source file under the roots, with forward slashes for the report.
  for (let path of SOURCE_ROOTS.flatMap(files).map((p) => relative('.', p).split(sep).join('/'))) {
    // The file's text, split by line.
    let lines = readFileSync(path, 'utf-8').split('\n')
    // CSS gets the plain check; TypeScript gets the three-level one.
    problems.push(
      ...(path.endsWith('.css') ? checkPlain(path, lines) : checkTypeScript(path, lines)),
    )
  }
  // Every configuration file that can carry comments gets the plain check.
  for (let path of CONFIG) {
    // The file's text, split by line.
    let lines = readFileSync(path, 'utf-8').split('\n')
    // The plain check on its lines.
    problems.push(...checkPlain(path, lines))
  }
  // Every configuration file must have its sidecar README beside it.
  for (let [file, sidecar] of Object.entries(SIDECARS)) {
    // A missing sidecar is one problem, named after the file it should describe.
    if (!existsSync(sidecar)) problems.push(`${file}: missing its sidecar ${sidecar}`)
  }
  // One problem per line, in "path:line: message" form, so an editor can jump to it.
  for (let p of problems) console.log(p)
  // A summary line: nothing missing, or the count of problems.
  let summary = problems.length === 0 ? 'nothing missing' : `${problems.length} problems`
  // The same line under both outcomes, so a script can match its start.
  console.log(`check:comments: ${summary}`)
  // Exit code 1 when anything is missing, so a hook or a CI step fails.
  process.exitCode = problems.length === 0 ? 0 : 1
}

// The script runs when loaded; nothing imports it.
main()
