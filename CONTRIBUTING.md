# Contributing: how this code is documented

## The requirement, and where it comes from

The author of this project asked, on 25 October 2026, that the code be documented so completely that
they can come back to it after time away and understand everything again from the code alone,
without this conversation or anyone's memory. Every file, every function and every line carries
that explanation. The cost, code that doubles in size, and the risk, comments that go stale, were
accepted knowingly. The rule that keeps the risk in check is the last section of this document.

## The three levels

**1. A file header,** at the top of every file, after the JSX pragma line in React files:

```ts
// <file name>: <one-line objective>.
//
// Objective
//   <what this file is for, in a few sentences>
//
// Dependencies
//   <each import, and what is taken from it>
//   <each external service or process it talks to, with its port>
//
// Consumers
//   <each file that imports or runs this one, and what it takes>
//
// How it relates to them
//   <the contract between this file and its consumers: what they may assume, what they must do>
```

**2. A header for every function, class, interface, type and exported constant,** as a JSDoc
block so editors show it on hover:

```ts
/**
 * <why it exists, and its objective>
 *
 * Called by: <file: function>, <file: function>   (from docs/callers.md, never from memory)
 * @param name <what it is, its shape, and what is not allowed>
 * @returns <what comes back, including the error cases>
 */
```

Types, interfaces and constants get the same block without `@param` and `@returns`.

**3. A comment for every line of code,** on the line above the statement, saying what it does
and why. Never a paraphrase of the syntax: "increment i" is not a comment. The rules that keep
the result readable:

- A multi-line statement, such as an object literal, a JSX element or a chained call, gets one
  comment above its first line; its continuation lines and closing brackets get none.
- Inside a JSX tree, each element gets a comment, written as `{/* … */}` where the syntax
  requires it. In a tag that spans several lines, each attribute line after the first gets a
  short `//` comment of its own, which is what the checker verifies.
- A test case's `it(...)` line gets a header that says what it proves and which function it
  covers; the lines inside follow the same rule as any code.
- Import lines are covered by the file header's "Dependencies" section.
- In `tsconfig.json`, `.gitignore`, `docker/compose.yml`, `.devcontainer/devcontainer.json`,
  `.devcontainer/codespace.sh` and the CSS, every setting, command or rule gets a comment above
  it or beside it.
- `package.json` and `.nvmrc` cannot carry comments; their sidecar READMEs document each key.

**Configuration sidecars.** Every configuration file has a `<name>_README.md` beside it,
with the leading dot dropped: `package.json_README.md`, `tsconfig.json_README.md`,
`nvmrc_README.md`, `gitignore_README.md`, `docker/compose.yml_README.md`,
`.devcontainer/devcontainer.json_README.md`. Each
explains the file's purpose, every key or line, who reads the file, and what breaks if it is
wrong.

Everything in English, lines of 100 characters or fewer, LF endings. No comment ever restates a
secret, a key or a password.

## Files left alone

`package-lock.json` is machine-written. `.agents/skills/remix/SKILL.md` belongs to Remix and is
refreshed by its CLI. `public/favicon.svg` is an image. `app/actions/public/flow/flow-bundle.*`
is built by `npm run build:flow` and ignored by git.

## The tools

- `npm run callers` writes `docs/callers.md`: every export of every file and where it is used.
  The "Called by" lines are copied from it.
- `npm run check:comments` reports every file without a header, every function without a JSDoc
  block, and every line of code without a comment, per the rules above. It must report nothing
  before a commit.

## The rule against obsolete comments

A comment is part of the line it describes. Whoever changes a line changes its comment in the
same edit; whoever moves a call updates the "Called by" lines on both sides, with `npm run
callers` to check; whoever adds a file writes its header first. `npm run check:comments` runs
before every commit and catches what is missing; what is wrong can only be caught by reading, so
a review of a change reads the comments as carefully as the code.

The same rule holds for `docs/architecture.md`: a change to a component updates the part that
explains it (part 16's file index says which), and a new decision gets a record in part 14.

## Diagrams

Each Mermaid diagram of `docs/architecture.md` and of the README has an image in
`docs/diagrams/`, linked right under it and listed in `docs/diagrams/README.md`. When you change a
diagram, render it again and keep the same file name: save its block in a file and run
`npx -y @mermaid-js/mermaid-cli -i block.mmd -o docs/diagrams/<name>.png -b white -s 2`. It needs
Chrome; set `PUPPETEER_EXECUTABLE_PATH` if it cannot find one. A diagram added to a document needs
its image, its link line and its row in the gallery.
