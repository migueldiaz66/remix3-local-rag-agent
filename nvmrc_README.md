# .nvmrc, explained

`.nvmrc` cannot carry comments: version managers read the whole file as a version. This file
explains it. Whoever changes the version changes this file in the same edit (CONTRIBUTING.md).

## Purpose

Names the exact Node version this app is developed and tested with, so a person or a tool can
switch to it before running anything. It complements `engines` in `package.json`: `engines`
says what is acceptable (`>=24.3.0`), `.nvmrc` says what is actually used.

## The value

### `24.22.1`

A bare version number, one line, LF ending. nvm also accepts `v24.22.1` or `24`, but the bare
exact form is what `nvm` itself writes and what every manager reads without ambiguity.

Why Node 24, and not the 22.19.0 also installed on this machine:

- Remix 3.1.0 requires Node 24.3 or newer; `engines` in `package.json` says the same.
- Node 24 runs a `.ts` file directly by stripping its types, which `npm run hmr`
  (`node hmr.ts`) relies on without any flag.
- Node 24 is the current long-term support line, so the version will keep receiving fixes for
  the life of this project.

Why 24.22.1 exactly: it is the 24.x release installed through nvm-windows on the author's
machine on 25 October 2026 and the one `npm test` and `npm run typecheck` were run with. Any
24.x from 24.3.0 satisfies the app; the exact number is for reproducibility, not a requirement.

## Who reads it

- nvm on macOS and Linux: a bare `nvm use` in the repository root reads it and switches.
- nvm-windows, used on this machine: not every version reads `.nvmrc`, which is why CLAUDE.md
  spells the command out: `nvm use 24.22.1` before any npm command, `nvm use 22.19.0` to go
  back.
- Other managers and CI steps that look for it: fnm (`fnm use`), GitHub Actions' `setup-node`
  with `node-version-file: .nvmrc`, and editors that show the expected version.
- People: it is the first place to look when `npm i` warns about `engines`.

Node and npm themselves never read it; `engines` in `package.json` is their constraint.

## What breaks if it is wrong

- A version below 24.3 (for instance 22.19.0): `npm i` warns `EBADENGINE` and continues; Remix
  then fails at run time, and `node hmr.ts` fails because older Node does not strip types
  without a flag.
- A version not installed: `nvm use` reports it is not installed and the shell keeps the previous
  Node; install it with `nvm install <version>` first.
- Text that is not a version, a second line, or a trailing comment: nvm reports an invalid
  version and does nothing.
- A version that does not match `engines`: nothing breaks by itself, but the two files no longer
  tell the same story; change both together.

## Last reviewed

25 October 2026, against Remix 3.1.0 and the Node 24.22.1 installed here.
