# docker/compose.stack.yml, explained

`compose.stack.yml` carries a comment above every setting. This file gives each part the room a
one-line comment does not have, and says how to run it. Whoever changes a setting changes its
comment and this file in the same edit (CONTRIBUTING.md).

## Purpose

Runs the whole project as containers, with Docker as the only thing to install: Qdrant, Ollama,
the two models, the ingest and the app. It is the "Docker image" way to try the project. It is a
separate file from [compose.yml](compose.yml), which starts only Qdrant for development and
publishes it on port 6335. The two use different Compose project names, so they never share
containers or volumes.

## Commands

From the repository root:

- `docker compose -f docker/compose.stack.yml up --build`: build the app image if needed and
  start everything. The first start downloads the images and 1.7 GB of models.
- `docker compose -f docker/compose.stack.yml up -d`: the same, in the background.
- `docker compose -f docker/compose.stack.yml logs -f app`: follow the app's log.
- `docker compose -f docker/compose.stack.yml down`: stop and remove the containers. The two
  volumes stay, so the next start skips the downloads.
- `docker compose -f docker/compose.stack.yml down -v`: the same, and delete the volumes: the
  Qdrant collection and the downloaded models.
- `APP_PORT=8080 docker compose -f docker/compose.stack.yml up`: use another host port.

Then open `http://localhost:44100`.

## The services and their order

| Service | Image | Job | Starts after |
|---|---|---|---|
| `qdrant` | `qdrant/qdrant:v1.20.0` | The vector database | nothing |
| `ollama` | `ollama/ollama:0.40.11` | The model server | nothing |
| `models` | the same Ollama image | Pulls `qwen3:1.7b` and `nomic-embed-text` into the volume, then exits | `ollama` healthy |
| `ingest` | the app image | Runs `scripts/ingest.ts`: cuts, embeds and stores the article, then exits | `models` finished, `qdrant` healthy |
| `app` | the app image | The page and the chat endpoint | `ingest` finished |

The order is the point. The app starts only after the article is stored, so no question meets an
empty collection, and the ingest starts only after the models are on disk. `models` and `ingest`
are jobs: `restart: "no"`. On a later `up` they run again and finish quickly, because the models
are already in the volume and the ingest replaces the collection in seconds.

## Settings that need a reason

- **`127.0.0.1:${APP_PORT:-44100}:44100`.** The port is published to the local machine only. The
  chat endpoint has no sign-in and no rate limit, and one question keeps the CPU busy for seconds,
  so it should not be reachable from the network by accident. To expose it on purpose, write
  `0.0.0.0` or remove the prefix, and put a login in front.
- **The addresses.** `OLLAMA_URL` and `QDRANT_URL` point at the service names, which Compose
  resolves on its own network. Qdrant's port 6333 is the container's own port; the 6335 of the
  development file is a host mapping and does not apply here.
- **`OLLAMA_KEEP_ALIVE: 30m`.** The chat model stays in memory between questions.
- **The healthchecks.** `depends_on` with `service_healthy` needs them. Qdrant's image has bash but
  no curl, so its check opens a TCP connection. Ollama's check runs `ollama list`, which needs the
  server to answer.
- **`image` and `build` together.** `up --build` builds the image from the repository and tags it
  `mdiazm01/remix3-local-rag-agent:0.1.0`. Without `--build`, Compose uses the image if it exists
  locally and otherwise pulls it from Docker Hub, 120 MB compressed. The tag is pinned like the
  Qdrant and Ollama ones: a new version of the app image means a new tag here.
- **The models.** The compose file names them in the `models` job, and `app/ai/config.ts` names
  them as defaults. Change them in both places, or set `CHAT_MODEL` and `EMBED_MODEL` on the app
  and the ingest.

## Measured

On 26 October 2026, with Docker Desktop for Windows on the author's laptop, in a Docker VM of 4
CPU cores and 15.6 GiB, started with `APP_PORT=44101` because port 44100 was in use:

| What | Result |
|---|---|
| First start, from `up` to the app healthy | 18 min 33 s |
| of which: pulling the Qdrant and Ollama images | 14 min 12 s |
| of which: the `models` job, 1.7 GB | 3 min 55 s |
| of which: the `ingest` job, 25 passages | 18 s |
| Start again with the volumes kept | `up -d` returned after 39 s |
| Image sizes on disk | app 471 MB, Qdrant 281 MB, Ollama 8.43 GB |
| Volumes | the downloaded models, about 1.7 GB, and a small Qdrant volume |
| Memory in use, models loaded | app 119 MiB, Qdrant 27 MiB, Ollama 3.7 GiB |
| First RAG question after a start | 53.3 s here, 61.4 s and 102.9 s in two later runs |
| The same question again | 9.8 s here, 11.8 s, 22.2 s and 30.9 s in later runs |
| The same question after a restart | 52.1 s, because the model is loaded again |

The times of the questions vary by a factor of three because the laptop was busy with other
work. The raw files, three more runs and what they mean are in
[docs/docker-run.md](../docs/docker-run.md). Note also that `up -d` returns when the app
container has started, not when it listens: the page answered about 6 s later.

The pull time depends on the connection, which was slow: the Ollama image has a layer of 3.2 GB.
The official image carries GPU libraries that a CPU-only run does not use. Nothing smaller is
official, so this is the price of the stack. A variation not tested here: if Ollama already runs
on the host, point `OLLAMA_URL` at it (on Docker Desktop, `http://host.docker.internal:11434`) and
leave out the `ollama` and `models` services.

## What it does not do

- **No GPU.** The official Ollama image uses a GPU if Docker is given one; this file gives none.
  On Docker Desktop for Windows, the answers run on the CPU.
- **No sign-in and no rate limit**, as in the rest of the project.
- **Nothing is published to a registry.** See below.

## Where the image is published

It is published on Docker Hub, as `mdiazm01/remix3-local-rag-agent` with the tags `latest`, `0.1.0`
and `68c77ba`, and on GitHub's registry as `ghcr.io/migueldiaz66/remix3-local-rag-agent` with the
same tags and the same digest. The GitHub copy is private until it is made public in the package
settings. What is stored, the digests, how it was pushed and what is left to do are in
[docs/image-registries.md](../docs/image-registries.md). The comparison that led to publishing
on both:

| | GitHub Container Registry, `ghcr.io` | Docker Hub |
|---|---|---|
| Cost for a public image | Free, storage and bandwidth included | Not checked for this document |
| Pull limits | None stated for public images | 100 pulls per 6 hours per IP when anonymous, 200 for a free account |
| Link to the repository | The `source` label links the package to the repository and shows its README | A separate repository page with its own description |
| Publishing from CI | `GITHUB_TOKEN` in a GitHub Action, no extra secret | A Docker Hub account and an access token stored as a repository secret |
| Discoverability | Found through the repository | Found through Docker Hub's search, where most people look for images |

The tag policy in use: `latest` for the newest release, a version tag such as `0.1.0` for each
release, and the commit hash for traceability. Only `linux/amd64` is built; a multi-architecture
build would let it run on Apple Silicon without emulation.
