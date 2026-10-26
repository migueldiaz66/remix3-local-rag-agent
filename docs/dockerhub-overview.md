# remix3-local-rag-agent

The app image of a small proof of concept of retrieval-augmented generation (RAG), all of it local:
a Remix 3 page with a React Flow diagram of the RAG pipeline, next to a chat with three modes
(LLM alone, RAG over a Wikipedia article, and an agent). No cloud service and no API key.

Source, documents and the full story: https://github.com/migueldiaz66/remix3-local-rag-agent

This file is the text of the Docker Hub page. It is kept in the repository as
`docs/dockerhub-overview.md` and pasted to Docker Hub through its API.

## Which image is mine?

You do not have to choose: `docker pull` picks the right one for your computer.

| Your computer | Docker Desktop runs | You get |
|---|---|---|
| Windows PC, Intel or AMD | Linux containers | `linux/amd64` |
| Mac with an Intel chip | Linux containers | `linux/amd64` |
| Mac with Apple Silicon (M1, M2, M3 and later) | Linux containers | `linux/arm64` |
| Windows on Arm | Linux containers | `linux/arm64` |
| Linux, x86-64 | Linux | `linux/amd64` |
| Linux on Arm, Raspberry Pi | Linux | `linux/arm64` |

The OS column of Docker Hub says `linux` for every row, Windows and Mac included, because Docker
Desktop runs containers in a Linux virtual machine. There is no Windows or macOS container image of
this project, and the stack could not use one: Qdrant and Ollama, which it needs, publish Linux
images only.

To pick by hand, for example to force one platform, use an explicit tag: `0.1.1-amd64` or
`0.1.1-arm64`, and `latest-amd64` or `latest-arm64`.

## Quick start

This image is only the app. Run it with Ollama and Qdrant through the compose file of the
repository:

```sh
git clone https://github.com/migueldiaz66/remix3-local-rag-agent
cd remix3-local-rag-agent
docker compose -f docker/compose.stack.yml up
```

Then open http://localhost:44100. The first start downloads the Ollama and Qdrant images and 1.7 GB
of models: it took 18 minutes on a slow connection. A start with everything downloaded took 39
seconds. Answers run on the CPU.

## Tags

| Tag | Platforms |
|---|---|
| `latest`, `0.1.1`, `b1eff4a` | `linux/amd64` and `linux/arm64` |
| `latest-amd64`, `0.1.1-amd64` | `linux/amd64` only |
| `latest-arm64`, `0.1.1-arm64` | `linux/arm64` only |
| `0.1.0`, `68c77ba` | `linux/amd64` only, the first release |

The `arm64` image was built under emulation and started under emulation; it has not been run on
Arm hardware. The same image is on GitHub's registry as
`ghcr.io/migueldiaz66/remix3-local-rag-agent`. Where each copy is stored, with the digests and how
it was built: https://github.com/migueldiaz66/remix3-local-rag-agent/blob/main/docs/image-registries.md

## License

The code is MIT. The article in the image, `data/rag-wikipedia.md`, is the Wikipedia article
"Retrieval-augmented generation" under CC BY-SA 4.0; its authors and changes are in
`data/NOTICE.md` inside the image and in the repository.
