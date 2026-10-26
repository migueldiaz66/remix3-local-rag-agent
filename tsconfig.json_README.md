# tsconfig.json, explained

`tsconfig.json` carries a comment above every option (TypeScript reads it as JSON with
comments). This file gives each option the room a one-line comment does not have. Whoever
changes an option changes its comment and its entry here in the same edit (CONTRIBUTING.md).

## Purpose

Tells TypeScript how to check this app, and tells the tools that read the same file (editors,
esbuild) how its modules and JSX work. Nothing is emitted: Node runs the `.ts` files through
Remix's loader, esbuild bundles the React island, and `tsc` only reports type errors. The options
are the Remix 3 starter's, kept unchanged.

## Options

All under `compilerOptions`, in file order.

- `strict: true`: every strict check on (`strictNullChecks`, `noImplicitAny`,
  `strictFunctionTypes`, `strictPropertyInitialization`, `useUnknownInCatchVariables` and the
  rest). The code is written for it: `null` and `undefined` are always explicit.
- `lib: ["ES2024", "DOM", "DOM.Iterable"]`: the built-in declarations available everywhere.
  ES2024 for the language and its standard objects; DOM for the browser code (the chat panel,
  the island, the events); `DOM.Iterable` so `for...of` works on `NodeList` and friends. Server
  and browser code share one program, so the server code sees DOM types too; nothing checks
  that it does not use them.
- `types: ["node", "remix/assets/types/hmr"]`: the ambient type packages loaded for every file,
  and only these. `node` (from `@types/node`) gives `process`, `Buffer` and the `node:*` modules;
  `remix/assets/types/hmr` gives the globals Remix's hot module replacement adds in the browser.
  Without this key TypeScript would load every `@types/*` package it finds.
- `module: "NodeNext"`: module syntax is judged the way Node does it. With `"type": "module"` in
  `package.json`, every file is ESM; `import` and `export` only.
- `moduleResolution: "NodeNext"`: imports are resolved the way Node does it: the `exports` field
  of each package is honoured (`remix/component`, `remix/node-tsx` are such entries), and
  relative imports must write their extension.
- `target: "ESNext"`: the newest JavaScript is accepted and nothing is downleveled. Node 24 and
  current browsers run it as written; esbuild sets its own target for the island bundle.
- `allowImportingTsExtensions: true`: an import may name a `.ts` or `.tsx` file, as every import
  in this code does. TypeScript allows it only when nothing is emitted (`noEmit`) or when
  `rewriteRelativeImportExtensions` is on; both hold here.
- `rewriteRelativeImportExtensions: true`: were anything emitted, a relative import ending in
  `.ts` would be rewritten to `.js` in the output. With `noEmit` it changes nothing; it is kept
  from the starter so the `.ts` imports stay valid if emit is ever turned on.
- `verbatimModuleSyntax: true`: an import used only as a type must say `import type`, and import
  statements are kept exactly as written. A transpiler that works one file at a time (Remix's
  loader, esbuild) can then drop type-only imports without looking at other files.
- `isolatedModules: true`: each file must be transpilable on its own, with no cross-file type
  information: no `const enum` across files, no re-export of a type without `export type`. This
  is the condition under which the file-by-file transpilers above are correct.
- `skipLibCheck: true`: the `.d.ts` files in `node_modules` are not type-checked. Faster, and a
  broken declaration in a third-party package does not fail `typecheck`.
- `jsx: "react-jsx"`: JSX compiles to calls of a `jsx()` function imported automatically from the
  import source below, not to `React.createElement`, and no `import React` is needed.
- `jsxImportSource: "remix/component"`: that import source is Remix's component package, so
  `.tsx` files are Remix components by default. The React files of the island start with a
  `/** @jsxImportSource react */` pragma, which overrides this per file; CONTRIBUTING.md places
  the file header after that pragma.
- `noEmit: true`: `tsc` writes no JavaScript. `npm run typecheck` runs `tsc --noEmit` on top of
  it, which is redundant and harmless.

Outside `compilerOptions`:

- `exclude: ["dist"]`: a `dist/` folder, if one existed, would be left out of the program. This
  project never produces one; the entry comes from the starter. There is no `include`, so TypeScript
  takes every `.ts` and `.tsx` file under the repository root except `node_modules/` and `dist/`.

## Who reads it

- `tsc`, through `npm run typecheck`: the only full type check.
- Editors: the TypeScript language service uses it for errors, completion and hover (which is
  where the JSDoc blocks of CONTRIBUTING.md show).
- esbuild, in `scripts/build-flow.ts`: reads the JSX and path options when bundling the island.
- Remix's loader (`remix/node-tsx`) and test runner, when they need the JSX settings.

All of them read JSON with comments, which `npm run typecheck` and `npm test` confirm.

## What breaks if it is wrong

- `jsxImportSource` changed or removed: every Remix `.tsx` file type-checks against the wrong
  runtime, or the island's React files do, depending on the direction.
- `allowImportingTsExtensions` removed: every import in the code is an error.
- `types` removed: `process`, `Buffer` and `node:fs` are unknown, and so are Remix's HMR
  globals; or, worse, every stray `@types/*` package is loaded.
- `noEmit` set to `false`: `allowImportingTsExtensions` is rejected, or `.js` files appear beside
  the sources if that option is also removed.
- `strict` turned off: `null` and `undefined` errors disappear from `typecheck` and reappear at
  run time.
- `skipLibCheck` turned off: errors inside `node_modules` fail `typecheck` for reasons this code
  cannot fix.
- A comment with a syntax error, or a trailing comma after the last option: TypeScript stops at
  the parse error and nothing type-checks.

## Last reviewed

25 October 2026, against TypeScript `latest` as installed, Remix 3.1.0 and Node 24.22.1.
