# .devcontainer/devcontainer.json, explained

`devcontainer.json` carries a comment above every setting, and `codespace.sh` carries one above
every line. This file gives them the room a one-line comment does not have. Whoever changes a
setting or a step changes its comment and this file in the same edit (CONTRIBUTING.md).

## Purpose

Lets anyone with a GitHub account run this project in the browser, with nothing installed on their
own machine. GitHub Codespaces reads this folder, builds a cloud machine from it, installs the
whole stack there, and opens the page. The README's badge "Open in GitHub Codespaces" is the entry
point.

It is a way to try the project, not a hosted demo. Each visitor gets a separate, private copy that
runs on their own GitHub account and counts against their own free hours. Nothing runs for the
author, so there is no shared machine to overload and nothing to protect with a login or a rate
limit.

## What happens, in order

1. **Image.** Codespaces pulls `mcr.microsoft.com/devcontainers/base:ubuntu-24.04` and adds two
   features: Node.js 24 and a Docker daemon inside the container (docker-in-docker).
2. **`codespace.sh create`, once.** Installs `zstd` and `curl`, installs Ollama with its official
   script, runs `npm ci`, pulls the Qdrant image, starts a throwaway Ollama server and pulls
   `qwen3:1.7b` (1.4 GB) and `nomic-embed-text` (274 MB), then stops that server.
3. **`codespace.sh start`, on every start.** Starts Qdrant with `docker/compose.yml`, starts Ollama
   if nothing answers on port 11434, waits for both, runs `npm run ingest`, and starts the app with
   `npm run start` unless something already answers on port 44100.
4. **The page.** Port 44100 is forwarded and `onAutoForward: openBrowser` opens it when the app
   answers. The forwarded port is private by default: only the owner of the codespace can open it,
   which is exactly the visitor who started it.

## Settings, one by one

| Setting | Value | Why |
|---|---|---|
| `name` | `remix3-local-rag-agent` | What the Codespaces list shows. |
| `image` | the Ubuntu 24.04 base image | Has git, curl, sudo and a non-root user, and nothing else to maintain. |
| `features` | Node 24, docker-in-docker | The app needs Node 24.3 or later; Qdrant runs from the same compose file as on a laptop. |
| `hostRequirements` | 8 GB memory, 32 GB disk | The default 2-core machine meets it. The two models take 1.7 GB on disk and a few GB in memory. |
| `postCreateCommand` | `codespace.sh create` | The slow, one-time work, shown in the creation log. |
| `postStartCommand` | `codespace.sh start` | The work every session needs, because the processes do not survive a stop. |
| `forwardPorts`, `portsAttributes` | 44100, labelled, opens the browser | The page appears without the visitor hunting for a port. |
| `customizations.codespaces.openFiles` | `README.md` | The visitor lands on the guide while the machine finishes. |

## Cost, and what the visitor needs

- A GitHub account. Codespaces bills the person who creates the codespace.
- A free personal account includes 120 core-hours a month. The 2-core machine uses 2 hours of the
  allowance for every hour it runs, so 60 hours; a 4-core machine uses 4, so 30 hours. These are
  the figures on GitHub's billing page for Codespaces on the day this was written.
- Storage counts too: a stopped codespace keeps its disk, which counts against the storage
  allowance, so delete a codespace you no longer need.

## What was measured, and what was not

Measured on 26 October 2026 in a local dev container, from a copy of the repository, on Docker
Desktop for Windows with a Docker VM of 4 vCPUs and 15.6 GB:

- Both lifecycle commands succeed. Ollama and the app keep running after the commands end.
- From nothing to a working page: about 22 minutes on a slow connection. The image build took 8
  minutes, `create` 14 (6 for Ollama's download, the rest for the packages and the two models),
  `start` 24 seconds, of which the ingest took 15.
- A RAG question streamed with its sources after 0.1 s. The first question took 48 s, while the
  model loaded; the second took 8 s.
- After restarting the container, `start` finished in 24 s and the app listened about 45 s after
  it was launched. The models and the Qdrant data were still there.

Measured in a real codespace on 26 October 2026, on the default machine, 2 cores and 7.8 GiB of
memory, with screenshots in [docs/codespaces-run.md](../docs/codespaces-run.md):

- The page opened by itself through the forwarded port, over HTTPS, with the nine stages drawn.
- The chat streamed word by word, so the Codespaces port proxy does not buffer the response.
- A RAG question returned an answer and four sources. It took 26.2 s the first time, while the
  chat model loaded, and 12.2 s the second time.
- With both models loaded, 3.9 GiB of the 7.8 GiB were in use.

Not measured:

- **The time a codespace takes to be created.** It was not recorded; the local figure above is
  from a slow home connection.
- **Answer speed on a 4-core machine.** It should be faster and uses free hours twice as fast.
- **The idle timeout and the retention period** of a codespace: the pages read for this file do not
  state them.

## If something fails

- The creation log (command palette: "Codespaces: View Creation Log") shows `create`.
- `/tmp/ollama.log` and `/tmp/app.log` hold the output of the two servers started by `start`.
- To run a step again by hand, from the repository root: `bash .devcontainer/codespace.sh start`.
  It skips what already runs.
- Rebuilding the container (command palette: "Codespaces: Rebuild Container") runs `create` again.

## Trying it without GitHub

The same files work in a local dev container, with Docker and the `@devcontainers/cli` package.
Work on a copy of the repository, never the folder you develop in: `npm ci` inside the container
deletes and rebuilds `node_modules` on the mounted folder.

```sh
npx -y @devcontainers/cli up --workspace-folder ../copy-of-the-repo
npx -y @devcontainers/cli exec --workspace-folder ../copy-of-the-repo curl -s localhost:44100
```
