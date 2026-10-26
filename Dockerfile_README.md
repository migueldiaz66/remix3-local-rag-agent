# Dockerfile, explained

`Dockerfile` carries a comment above every instruction. This file gives them the room a one-line
comment does not have. Whoever changes an instruction changes its comment and this file in the
same edit (CONTRIBUTING.md).

## Purpose

Packs the app, which is the page, the chat endpoint and the ingest script, into one container
image. The image does **not** contain Ollama, Qdrant or the models. Those are separate services
with their own official images, and [docker/compose.stack.yml](docker/compose.stack.yml) starts
them next to this one. Keeping them apart is why the image is small and why a new Ollama or Qdrant
version is a one-line change in the compose file, not a rebuild.

## The two stages

| Stage | Base | What it does | What survives |
|---|---|---|---|
| `build` | `node:24.22.1-bookworm-slim`, always for the machine that builds | `npm ci` with every dependency, then `npm run build:flow`, which bundles React, React Flow and the canvas with esbuild | The source and the built bundle, copied out by the next stage |
| `runtime` | the same image, for the platform being built | `npm ci --omit=dev`, then the copies from `build` | The image |

The Node version is the one in `.nvmrc`, 24.22.1. The app needs 24.3 or later (`engines` in
`package.json`). The `slim` variant is Debian 12 without compilers, which the app does not need,
because its only native dependency, esbuild, ships as a prebuilt binary.

## Platforms

The image is built for `linux/amd64` and `linux/arm64`. The first `FROM` carries
`--platform=$BUILDPLATFORM`, which makes the `build` stage run on the machine that builds, whatever
the target. That is safe because the bundle it produces is JavaScript and CSS, identical on every
platform. The consequence is that a build for arm64 on an amd64 machine runs esbuild natively and
only the `runtime` stage, with `npm ci --omit=dev`, runs under emulation. `$BUILDPLATFORM` is
filled in by BuildKit, the default builder of current Docker.

A build for both platforms needs `docker buildx` with a builder that has the arm64 emulation:

```sh
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker buildx create --name multiarch --driver docker-container --bootstrap
docker buildx build --builder multiarch --platform linux/amd64,linux/arm64 -t <name> --push .
```

## The runtime stage, instruction by instruction

| Instruction | Why |
|---|---|
| `LABEL org.opencontainers.image.source` | GitHub links a package to the repository named here, and shows the README beside it. |
| `LABEL ...description`, `...licenses` | What the image is, and its licenses: the code is MIT, the corpus is CC BY-SA 4.0. |
| `ENV NODE_ENV=production` | The same mode as `npm run start`. The server serves the built bundle. |
| `ENV PORT=44100` | The port `server.ts` listens on. |
| `RUN chown node:node /app` and `USER node` | The server runs as the base image's user `node`, id 1000, not as root. |
| `npm ci --omit=dev` | Only the runtime dependencies. esbuild stays, because Remix's asset server uses it at run time. |
| `COPY ... app, public, data, scripts, server.ts, tsconfig.json, LICENSE` | What runs. `data/` holds the corpus and its notice. |
| `HEALTHCHECK` | A `node -e` call fetches the home page. The base image has no curl, and node is already there. |
| `CMD` | `node --import remix/node-tsx server.ts`. The Remix loader runs the TypeScript source directly, as in development. |

## What is not in the image

- **Ollama and the models.** The `ollama` and `models` services of the compose file.
- **Qdrant.** The `qdrant` service.
- **The documents and screenshots**, the sidecar READMEs, the Codespaces setup and the scratch
  folder, which `.dockerignore` keeps out.
- **TypeScript, the type packages and `cross-env`**, which are development dependencies. The
  container sets `NODE_ENV` itself.

## Commands

From the repository root:

- `docker build -t remix3-local-rag-agent .`: build the image.
- `docker run --rm -p 44100:44100 remix3-local-rag-agent`: run the app alone. The page loads,
  but the chat needs Ollama and Qdrant, so use the compose file for the whole stack.
- `docker compose -f docker/compose.stack.yml up --build`: build the image if needed and start
  everything.

## Measured

On 26 October 2026, with Docker Desktop for Windows on the author's laptop:

- A cold build took 1 minute 40 seconds, most of it `npm ci` in both stages.
- `docker image ls` shows 471 MB; the layers of `docker history` add up to about 352 MB. The raw
  outputs and the other measurements are in [docs/docker-run.md](docs/docker-run.md).
- Started alone, it logged `Server listening on http://localhost:44100`, answered the home page
  with status 200, served the island's stylesheet and the Remix runtime files, ran as user
  `node` (id 1000) and became healthy about 30 seconds after the start.

Not done: a build for `linux/arm64`. The base image has an arm64 variant and esbuild ships an
arm64 binary, so it should work, and nothing was run on arm64.

## Publishing

The image is published on Docker Hub as `mdiazm01/remix3-local-rag-agent`, with the tags `latest`,
`0.1.0` and `68c77ba`, built with the labels `revision`, `version` and `created` added. The same
image is on GitHub's container registry, `ghcr.io/migueldiaz66/remix3-local-rag-agent`, public, and
connected to this repository. The details are in
[docs/image-registries.md](docs/image-registries.md), and the compose file names the Docker Hub
image, so building it locally produces the name that was published.
