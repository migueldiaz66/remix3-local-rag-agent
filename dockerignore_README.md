# .dockerignore, explained

`.dockerignore` carries a comment above every pattern. This file gives the reasons in one place.
Whoever changes a pattern changes its comment and this file in the same edit (CONTRIBUTING.md).

## Purpose

Decides which files of the repository are sent to Docker as the build context. A smaller context
builds faster, keeps the host's files out of the image and stops a change to a document from
invalidating the layer cache of the install step.

## The patterns

| Pattern | Why it is left out |
|---|---|
| `node_modules` | Dependencies are installed inside the image, for its own platform. A copy from Windows would carry the wrong esbuild binary. |
| `tmp` | The author's scratch folder, already ignored by git. |
| `.git` | Version control data, not needed to run. |
| `docs` | The documents and their screenshots and diagrams, several MB. |
| `.devcontainer` | The Codespaces setup. |
| `Dockerfile`, `.dockerignore`, `docker` | The Docker files themselves. |
| `app/actions/public/flow/flow-bundle.*` | A bundle built on the host. The image builds its own in the `build` stage. |
| `*_README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `.agents`, `README.md` | Documents and agent guides, not needed to run. |

## What stays in

The source (`app`, `scripts`, `server.ts`, `tsconfig.json`), `public`, `data` with the corpus and
its notice, `package.json`, `package-lock.json` and `LICENSE`. Removing one of those from the
build context breaks the image.
