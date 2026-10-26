# package.json, explained

`package.json` cannot carry comments, so this file documents every key. Whoever changes a key
changes its entry here in the same edit (CONTRIBUTING.md, "Configuration sidecars").

## Purpose

The manifest of the app: its name, how Node loads its files, the commands that build, run, test
and check it, the Node version it needs, and the packages it depends on. `package-lock.json`
beside it records the exact versions installed; it is machine-written and never edited by hand.

## Keys

### `name`: `remix3-local-rag-agent`

The package's name, the project's name. The package is private, so the name only appears in
npm's own output (`npm ls`, warnings).

### `private`: `true`

npm refuses to publish a private package. This is an application, never a library, so an
accidental `npm publish` must fail.

### `type`: `module`

Every `.js` file, and every `.ts` file Node runs, is an ES module: `import` and `export`, never
`require`. Remix 3 is ESM only, and `tsconfig.json` (`"module": "NodeNext"`) reads this key to
decide how each file is treated.

### `scripts`

npm runs each script with the system's default shell: `sh` on macOS and Linux, `cmd.exe` on
Windows. Those two disagree on `NODE_ENV=x command`, which only POSIX shells understand, so
every script that sets `NODE_ENV` starts with `cross-env`, a small program that sets the
variable itself and then runs the rest of the command. The same line therefore works on
Windows, macOS and Linux with no `.npmrc` that points at a particular shell. A script named
`pre<name>` runs by itself before `<name>`.

- `predev`: `npm run build:flow`. Builds the React Flow island bundle before `dev`, so the page
  never serves a missing or stale bundle.
- `dev`: `cross-env NODE_ENV=development node --watch --import remix/node-tsx server.ts`. The
  server in development mode. `--watch` restarts Node when a file changes; `--import remix/node-tsx`
  registers Remix's loader, which transpiles `.ts` and `.tsx` on the fly, so `server.ts` runs
  without a build step. Only the server restarts; the browser does not reload by itself.
- `prehmr`: `npm run build:flow`. Same reason as `predev`, before `hmr`.
- `hmr`: `cross-env NODE_ENV=development node hmr.ts`. The development server with hot module
  replacement: server and browser update without a restart. AGENTS.md recommends it for
  day-to-day work. Node 24 runs a plain `.ts` file by stripping its types, so no loader flag is
  needed here; `hmr.ts` starts the rest.
- `prestart`: `npm run build:flow`. Same reason, before `start`.
- `start`: `cross-env NODE_ENV=production node --import remix/node-tsx server.ts`. The server in
  production mode, no watch, same loader: "production without a separate build step".
- `test`: `cross-env NODE_ENV=test remix test`. Remix's test runner, from the `remix` package's
  CLI. It finds the `*.test.ts` files beside the code and runs them; `NODE_ENV=test` lets the
  code tell a test run from a real one.
- `typecheck`: `tsc --noEmit`. TypeScript checks every file named by `tsconfig.json` and writes
  nothing. Run before reporting work done (CLAUDE.md).
- `build:flow`: `node --import remix/node-tsx scripts/build-flow.ts`. Bundles the React Flow
  island with esbuild into `app/actions/public/flow/flow-bundle.js`, `.js.map` and `.css`,
  which git ignores.
- `ingest`: `node --import remix/node-tsx scripts/ingest.ts`. Loads the POC's documents into
  Qdrant: chunks the Markdown (`app/ai/chunk.ts`), embeds each chunk through Ollama
  (`app/ai/ollama.ts`), recreates the collection and upserts the points (`app/ai/qdrant.ts`).
  Needs Ollama on port 11434 and Qdrant on port 6335 (`docker/compose.yml`).
- `callers`: `node --import remix/node-tsx scripts/callers.ts`. Writes `docs/callers.md`, the
  index of every export and where it is used; the "Called by" lines of the headers come from it.
- `check:comments`: `node --import remix/node-tsx scripts/check-comments.ts`. Reports every
  file, declaration and line that the documentation rules of CONTRIBUTING.md still miss, and
  every configuration file without its sidecar README. Exit code 1 when anything is missing.

### `engines`: `"node": ">=24.3.0"`

Remix 3.1.0 requires Node 24.3 or newer. Under an older Node, `npm i` prints an `EBADENGINE`
warning and goes on, because the project sets no `engine-strict`; the failure then comes at
run time. `.nvmrc` names the exact version used here, 24.22.1.

### `dependencies`

Packages the app needs at run time. The React ones are pinned exactly because they must match
each other.

- `@xyflow/react` `12.12.0`: React Flow, the diagram canvas inside the island
  (`app/actions/public/flow/`). The only reason React is in this project.
- `react` `19.3.1`: React Flow needs React. Used only inside the island; the rest of the UI is
  Remix components.
- `react-dom` `19.3.1`: mounts the island into the page (`app/actions/public/flow/mount.ts`).
  Must be the same version as `react`.
- `remix` `^3.1.0`: the framework. Router and route contract, the component renderer and JSX
  runtime (`remix/component`), the Node loader (`remix/node-tsx`), HMR, the test runner and the
  CLI (`remix test`, `remix doctor`). Caret: any 3.x from 3.1.0 on; the lockfile pins the one
  installed.

### `devDependencies`

Packages needed to build, type-check and bundle, never at run time.

- `@types/node` `latest`: types for Node's built-ins (`node:fs`, `process`, ...), loaded for
  every file by `"types"` in `tsconfig.json`. `latest` is resolved at install time and pinned by
  the lockfile; `npm update` moves it.
- `@types/react` `19.3.0`: types for the island's React code. Same major and minor as `react`.
- `@types/react-dom` `19.3.0`: types for `react-dom`. Same major and minor as `react-dom`.
- `cross-env` `10.1.0`: sets an environment variable and runs the command that follows, the
  same way on Windows, macOS and Linux. The scripts `dev`, `hmr`, `start` and `test` begin with
  it to set `NODE_ENV`. Pinned exactly, like the other build tools. Without it those four
  scripts would fail under `cmd.exe`, which does not understand `NODE_ENV=x command`.
- `esbuild` `0.27.7`: the bundler `scripts/build-flow.ts` uses for the island. Pinned exactly:
  esbuild has no stable major yet and changes between minors.
- `typescript` `latest`: `tsc` for `npm run typecheck`, and the language service editors use.
  Same `latest` caveat: a new TypeScript release may add errors; pin it if that happens.

## Who reads it

- npm: `npm i` (dependencies, engines, lockfile), `npm run` (scripts, with the system's default
  shell), `npm ls`.
- Node: `"type": "module"` decides how `.js` and `.ts` files are loaded.
- TypeScript: `"type"` and the dependencies' own manifests, through `"moduleResolution":
  "NodeNext"`.
- esbuild, when bundling the island: the dependencies' `exports` fields.
- People and agents: AGENTS.md lists the commands; CLAUDE.md requires `typecheck` and `test`
  before reporting work done.

## What breaks if it is wrong

- `"type": "module"` removed: every `import` in a `.js` or `.ts` file fails at load time.
- A `pre*` script removed: the page serves a stale or missing `flow-bundle.*`; the island does
  not render.
- `NODE_ENV=` removed from a script: the code cannot tell development, production and test
  apart.
- `cross-env` removed from a script that sets `NODE_ENV`, or from the devDependencies: on
  Windows the script fails with "'NODE_ENV' is not recognized as an internal or external
  command"; on macOS and Linux it still works, which hides the problem until someone runs it
  on Windows.
- `react`, `react-dom` and their types at different versions: run-time errors in the island or
  type errors in `typecheck`.
- `engines` lowered: nothing stops an install under Node 22, and Remix fails when it runs.
- `remix` removed or downgraded below 3.1.0: nothing runs; CLAUDE.md fixes the version at 3.1.0.
- `@types/node` or `typescript` left at `latest` and a release breaks the build: pin them.

## Not here, on purpose

No `version`, `main` or `exports`: the package is an application, not something others import.
No `packageManager` field: npm is assumed, as in the Remix 3 starter.

## Last reviewed

25 October 2026, against Remix 3.1.0 and Node 24.22.1.
