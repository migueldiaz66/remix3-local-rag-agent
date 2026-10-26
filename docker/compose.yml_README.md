# docker/compose.yml, explained

`compose.yml` carries a comment above every setting. This file gives each setting the room a
one-line comment does not have, and says how to run it. Whoever changes a setting changes its
comment and this file in the same edit (CONTRIBUTING.md).

## Purpose

Runs Qdrant, the vector database of the project's retrieval (RAG), as one Docker container on
this machine. The app (`app/ai/qdrant.ts`) and `npm run ingest` connect to it on port 6335. The
file gives this project its own container name and host port, so it does not collide with a
Qdrant you may already run on Qdrant's usual ports 6333 and 6334. Its storage is a named Docker
volume, not a folder of the host, so the same file works on Windows, macOS and Linux.

## Commands

From the repository root:

- `docker compose -f docker/compose.yml up -d`: start, or create and start. Docker creates the
  volume `qdrant_data` on the first run.
- `docker compose -f docker/compose.yml down`: stop and remove the container. The volume stays;
  the next `up` finds the collections again.
- `docker compose -f docker/compose.yml down -v`: the same, and delete the volume too. Qdrant
  starts empty afterwards; `npm run ingest` fills it again.
- `docker compose -f docker/compose.yml logs -f`: follow Qdrant's log.
- Health: `curl http://localhost:6335/healthz`; the dashboard is at
  `http://localhost:6335/dashboard`.

The Compose project name is fixed by the file's top-level `name:`, `remix3-local-rag-agent`, and
it prefixes the volume's real name (`remix3-local-rag-agent_qdrant_data`). Without it Compose would
use the folder's name, `docker`, and two projects run from folders called `docker` would share a
volume; see the `name` section below.

## Settings

- `services`: the containers this file manages. One.
- `services.qdrant`: the service's name inside Compose, used in commands such as
  `docker compose up qdrant` and in Compose's network as a host name. Not the container name.
- `image: qdrant/qdrant:v1.20.0`: the official Qdrant image, version 1.20.0, pinned. A floating
  tag (`latest`) would upgrade Qdrant on any `pull`, and Qdrant opens storage written by an
  older version but not always by a newer one; an upgrade must be a deliberate change.
- `container_name: remix3-rag-qdrant`: a fixed name, so `docker ps`, `docker logs` and `docker
  exec` can name the container, and so it can never be confused with another Qdrant container.
  Without it Compose would name it `docker-qdrant-1`.
- `ports`: the container ports published on the host, `host:container`.
  - `"6335:6333"`: host port 6335 forwards to 6333 inside the container, Qdrant's REST API.
    The host side is this project's choice, away from Qdrant's usual 6333 and 6334; the
    container side is Qdrant's and must stay 6333. Qdrant's gRPC port, 6334, is not published:
    nothing in this project uses it. The value is quoted because unquoted YAML 1.1 reads
    `6335:6333` as a base-60 number.
- `volumes` (under the service): the storage mounted into the container, `source:container`.
  - `qdrant_data:/qdrant/storage`: Qdrant's storage folder (`/qdrant/storage`, its default) is
    the named volume `qdrant_data`, so collections survive `down`, upgrades and reboots. A
    named volume instead of a host folder means no path to choose, no drive to share with
    Docker Desktop, and no file-permission surprises on Linux.
- `restart: unless-stopped`: Docker restarts the container after a crash and when Docker
  Desktop starts, unless it was stopped by hand (`docker stop`, `docker compose stop`). The app
  can then assume Qdrant is up after a reboot.
- `volumes` (top level): declares `qdrant_data`, the named volume above. The empty entry means
  "create it with Docker's default local driver".

## Who reads it

- `docker compose` (the Compose v2 plugin of Docker Desktop, or the plugin on Linux), with the
  commands above.
- People and agents setting the machine up: the README at the repository root points here.
- Nothing in the code reads it. The app learns the port from its own configuration
  (`app/ai/config.ts`); the two must agree.

## What breaks if it is wrong

- Host port 6335 already taken: `up` fails with "port is already allocated". Change the host
  side and the app's configuration together.
- Container side changed from 6333: the port forwards to nothing; every request from the app
  gets "connection reset" or an empty reply.
- `container_name` removed or equal to another container's: Compose refuses to start, or the
  two projects fight over one container.
- Volume renamed: Qdrant starts empty; the old volume stays where it was. Volume removed
  (`down -v`): the data is gone, and `npm run ingest` rebuilds it.
- The top-level `volumes` entry removed while the service still names `qdrant_data`: Compose
  stops with "refers to undefined volume".
- Image tag raised: Qdrant migrates the storage forward; lowering it afterwards can fail to
  open the storage. Tag floating: the version changes under the project without anyone deciding.
- `restart` removed: after a reboot Qdrant stays down; `npm run ingest` and every retrieval
  fail with "connection refused" until someone runs `up`.
- Indentation wrong: Compose reports a YAML error and does nothing.

## Last reviewed

25 October 2026, with Qdrant 1.20.0.

## name

The Compose project name, `remix3-local-rag-agent`. Without it Compose names the project after the
folder that holds this file, `docker`, and a second stack kept in another folder called `docker`
would share its containers: `docker compose up` would stop and recreate them. A fixed name keeps
this stack apart.
