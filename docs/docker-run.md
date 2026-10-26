# The Docker stack run, with the raw numbers

This document records how the Docker stack behaved on 26 October 2026, with every raw output
saved in [docker-run/](docker-run/). The stack is
[docker/compose.stack.yml](../docker/compose.stack.yml) and the image is built by the
[Dockerfile](../Dockerfile); they are explained in
[Dockerfile_README.md](../Dockerfile_README.md) and
[docker/compose.stack.yml_README.md](../docker/compose.stack.yml_README.md). Nothing here was
published to a registry.

## 1. Conditions

- **Docker:** Docker Desktop for Windows, server 29.1.3, with a Docker VM of 4 CPUs and
  15.57 GiB of memory.
- **Host:** the author's laptop, Windows 11, Intel i7-6600U with 2 cores and 4 threads, 32 GB.
  No GPU is configured.
- **Port:** the app was published on 44101, because port 44100 was in use.
- **A shared machine.** The laptop was also running the author's other work: a browser, an editor
  and other programs. Its CPU load, measured with `typeperf` before and after some runs, was
  between 40% and 100% of all four threads. That matters for every time below.

## 2. What was saved

| File in `docker-run/` | What it is | How it was made |
|---|---|---|
| `first-start.txt` | The first full start: image pulls, the two jobs, the first questions, a restart | Copied by hand from the terminal. It cannot be captured again |
| `conditions.txt` | Date, Docker version, VM size, host | `docker-capture.sh` |
| `image.txt` | `docker image ls`, selected `docker image inspect` fields, `docker history` | `docker-capture.sh` |
| `start-log.txt`, `start.txt` | The `up -d` output and duration, `ps -a`, the start and finish of each container | `docker-capture.sh` |
| `job-logs.txt` | The `models` and `ingest` jobs and the app's start line | `docker-capture.sh` |
| `timings.txt` | First byte and total time of four questions | `docker-capture.sh` |
| `rag-cold.ndjson`, `rag-warm.ndjson`, `llm.ndjson`, `agent-vector-store.ndjson` | The four streams, as they arrived | `docker-capture.sh` |
| `stats-during-questions.txt` | CPU and memory of every container, sampled while the questions ran | `docker-capture.sh` |
| `stats-summary.txt` | Peaks and means of those samples | Derived by a script from the line above |
| `resources.txt` | `docker stats` after the questions, `docker system df`, the volumes | `docker-capture.sh` |
| `timings-without-sampler.txt` | The same questions, without the stats sampler, and the host load | A second script |
| `timings-without-sampler-failed-attempt.txt` | A first try of that second run that failed: it asked before the app listened | The same script, before it waited |

The two scripts are `docker-capture.sh` and `docker-rerun.sh`. They are not in the repository.
The streams are the same kind of file as `docs/transcripts/`. In `resources.txt`, the section
"volumes of the stack" starts with five container rows, because the filter matched them, and ends
with the two volumes.

## 3. The image

Three commands give three sizes for the same image.

| Command | Size | What it counts |
|---|---|---|
| `docker image ls` | 471 MB | What the image takes on disk |
| `docker history`, the layers added up | about 352 MB | The sum of the layer sizes |
| `docker image inspect`, field `Size` | 119,858,320 bytes | Probably the compressed content in the image store |

Which of the three is the "real" size depends on the question, and the last row is a guess: it was
not checked.

The image has 14 layers and is built for `linux/amd64`. The big ones are the Node binary (157 MB),
the production dependencies (101 MB) and the Debian base (85 MB). The app itself, source, bundle
and data, is under 1 MB. It runs as the user `node`, listens on 44100, and its healthcheck calls
the home page every 30 seconds with a 5 second timeout, a 30 second grace period and 3 retries.

The other images are Qdrant 281 MB and Ollama 8.43 GB. The two volumes are 1.634 GB for the
models and 205.6 MB for Qdrant. 205.6 MB is far more than 25 vectors need; it was not
investigated.

## 4. Starting

| Start | Duration | Detail |
|---|---|---|
| First start, nothing downloaded | 18 min 33 s | Pulling the images 14 min 12 s, the `models` job 3 min 55 s, the `ingest` job 18 s |
| Restart, first run | `up -d` returned after 39 s | Volumes kept |
| Restart, capture with the sampler | `up -d` returned after 57 s | The `ingest` job took 38.9 s |
| Restart, second run | `up -d` returned after 37 s | The `ingest` job took 19.5 s; the home page answered 6 s later |

Two things to know. `up -d` returns when the app container has started, not when it listens: in
the second run the home page answered 6 s later, and a first try that did not wait got
connection refused on every question. And the `ingest` job took between 16 and 39 s in four
runs: the same work, a busy host.

## 5. The questions

Three of the questions are "What is chunking in RAG?", asked in RAG mode twice and in LLM mode
once. The fourth is "Where does the vector store fit in the pipeline?" in agent mode. Times are
the whole stream.

| Question | First start run | Capture, with the sampler | Second run, without it |
|---|---|---|---|
| RAG, the first after a start | 53.3 s | 102.9 s | 61.4 s |
| RAG, again | 9.8 s | 22.2 s | 11.8 s, then 30.9 s |
| LLM | not asked | 16.7 s | 12.0 s |
| Agent | not asked | 128.3 s | not asked |
| Host CPU load before | not measured | not measured | 100%, 100%, 100% |

The first question after a start is slow because the chat model loads into memory. The first
byte of a RAG answer is the sources, and arrives in 0.1 to 2 s. The first byte of an LLM answer is
the first token, which took 5.1 and 5.8 s.

**How to read the spread.** The same warm RAG question took 9.8, 11.8, 22.2 and 30.9 s. The last
two were measured back to back in one run, 11.8 s and then 30.9 s, with nothing changed. The
second run, without the sampler, was not uniformly faster than the one with it. So the load of the
host explains the spread better than the sampler does, and the sampler's own cost, if there is
one, is lost in that noise. Use these as a range: a warm RAG answer took 10 to 31 s here, and the
README's 16.3 s, measured with the app running natively, sits inside it.

The agent took 128.3 s for the vector store question, against 18.7 s for the same question on 25
October with the app running natively (`docs/transcripts/timings.txt`). LLM mode took 12.0 and
16.7 s here against 4.2 s natively. The agent ran only once in Docker, the host was busy, and the
cost of the container is not separated from the cost of the load, so these two gaps are not a
finding about Docker.

## 6. The streams

The saved streams are complete and end with a `done` event.

- **RAG:** one `sources` event with the passages, then 41 tokens (cold) or 40 (warm).
- **LLM:** 40 tokens, no sources.
- **Agent:** a `sources` event, two `tool` events, `search_docs` and then `highlight_node` with
  `vector-store`, a `ui` event that highlights that stage, and 23 tokens. The agent chose the
  right stage.

## 7. CPU and memory while the questions ran

From `stats-summary.txt`: 62 samples, one every 4 to 5 s. CPU is a percentage of one core, so the
VM tops out at 400.

| Service | Peak CPU | Mean CPU | Peak memory |
|---|---|---|---|
| Ollama | 302% | 231% | 2.17 GiB |
| App | 132% | 3.4% | 131 MiB |
| Qdrant | 19% | 2.1% | 29 MiB |

Ollama was above 150% in 59 of the 62 samples, so generation uses about three of the four VM CPUs
while the app and Qdrant use almost nothing. The app's 132% is a single spike.

The memory of Ollama is the one figure that does not agree: 3.709 GiB in the first run, measured
after two questions, and 2.17 GiB here. Both were read from `docker stats`. The difference was not
investigated.

## 8. What was not measured

- A build or run for `linux/arm64`.
- A GPU.
- Pulling the image from a registry, because it is not published.
- The same questions with Ollama running natively on the same host under the same load, so the
  cost of the container itself is not separated from the cost of a busy laptop.
- The cost of the stats sampler, beyond the comparison above.

## 9. To repeat it

```sh
docker compose -f docker/compose.stack.yml up --build
docker stats --no-stream
curl -N -X POST http://localhost:44100/api/chat -H 'content-type: application/json' \
  -d '{"mode":"rag","question":"What is chunking in RAG?"}'
```
