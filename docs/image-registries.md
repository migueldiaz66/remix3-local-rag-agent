# Where the image is stored: Docker Hub and GitHub

The app image of this project is stored on two registries, or is meant to be. This document says
where, what is there, how to pull it, who can push to it and with what, and what is not finished.
The image is built by the [Dockerfile](../Dockerfile) and used by
[docker/compose.stack.yml](../docker/compose.stack.yml). What it contains is in
[Dockerfile_README.md](../Dockerfile_README.md), and its measured numbers are in
[docker-run.md](docker-run.md).

## 1. The two places at a glance

| | Docker Hub | GitHub Container Registry |
|---|---|---|
| Address | `docker.io/mdiazm01/remix3-local-rag-agent` | `ghcr.io/migueldiaz66/remix3-local-rag-agent` |
| State | **Published** on 26 October 2026, 17:13 to 17:14 UTC | **Not published**: the push was refused |
| Visibility | Public, checked through Docker Hub's API | Not applicable yet |
| Tags | `latest`, `0.1.0`, `68c77ba` | none |
| Platform | `linux/amd64` | none |
| Page | <https://hub.docker.com/r/mdiazm01/remix3-local-rag-agent> | <https://github.com/migueldiaz66?tab=packages> once it exists |

## 2. Docker Hub

**What is stored.** One image, with three tags that point at the same digest. The tag `latest`
moves with each publication, `0.1.0` is the version, and `68c77ba` is the commit the image was
built from.

| Item | Value |
|---|---|
| Index digest, the one every tag points at | `sha256:5bf7f013142ccc9e3ceb874bf11699f91517fd9939214031f47e37c776944ed1` |
| The `linux/amd64` image inside it | `sha256:5dfcc673c1a9d077c300b29e8f0038943f4c54b9d35f4b8c58ac0ac4ba0760c0` |
| A provenance attestation, listed with platform "unknown" | `sha256:99174461bc687659cf1f7a703f95b6b9afc29e37a3d4972449fcbaed737711ac` |
| Size stored, as Docker Hub reports it | 119,843,469 bytes compressed; the repository's storage is 119,860,527 bytes |
| Size on disk once pulled | 471 MB |
| Labels | `source`, `description`, `licenses`, and `revision` (the full commit hash), `version` (0.1.0) and `created` (2026-10-26T17:12:39Z) |

The compressed size is the third of the three sizes in `docker-run.md`: Docker Hub's figure
agrees with the one `docker image inspect` printed.

**What is not stored.** Ollama, Qdrant and the models. The image is only the app, so
`docker run` on it alone shows the page but cannot answer a question. Use the compose file.

**How to pull and run it.**

```sh
docker pull mdiazm01/remix3-local-rag-agent:0.1.0
docker compose -f docker/compose.stack.yml up
```

The second command starts the whole stack. It pulls the app image from Docker Hub, because the
compose file names it, and builds it from the repository only with `--build`.

**Checked from outside.** With an empty Docker configuration, which is an anonymous user,
`docker manifest inspect` listed the image, and `docker pull` downloaded it. Started alone, it
answered the home page with status 200, was healthy after 40 s, ran as the user `node`, and carried
the labels above.

**Limits.** Docker Hub counts pulls: an anonymous client may pull 100 times in 6 hours per IP
address, and a free account 200 (Docker's usage page, read for this project). A multi-architecture
image counts one pull per architecture.

## 3. GitHub Container Registry

**What happened.** The push of `ghcr.io/migueldiaz66/remix3-local-rag-agent:0.1.0` was refused:

```
error from registry: permission_denied: The token provided does not match expected scopes.
```

The token was the fine-grained personal access token used for the repository. As far as the
refusal shows, a token of that kind is not accepted for container packages. The login itself
succeeded; only the push was denied. Nothing was published there.

**How to finish it.** Two ways, and the choice is the author's.

1. **A classic token with `write:packages`**, created at <https://github.com/settings/tokens>,
   used once to push the same six tags from the local image, then revoked.
2. **A GitHub Action** that builds and pushes with the `GITHUB_TOKEN` the workflow receives, with
   `packages: write`. It needs no token to be created, and it can build `linux/amd64` and
   `linux/arm64` together. The workflow file lives in `.github/workflows/`, so pushing it needs a
   token with the Workflows permission, or the file can be added in the GitHub web page.

**After the first push.** A new package on ghcr.io starts private, to be confirmed at the first
push. Its visibility is changed in the package's settings on GitHub, not through an API, and the
`source` label already in the image links the package to this repository. Until then the compose
file does not depend on it: it names the Docker Hub address.

**Limits.** GitHub's billing page says storage and bandwidth for container images are currently
free for public packages, with at least a month's notice before that changes, and states no pull
limit.

## 4. Who can push, and how it was done

- **Docker Hub:** the account `mdiazm01`. The push used a personal access token with Read, Write
  and Delete permissions that expires on 25 November 2026. The token is not in this repository.
  A screenshot of the page that shows it is kept in `.secrets/`, a folder that git and Docker
  both ignore (`gitignore_README.md`). Revoke the token in Docker Hub's account settings when it
  is no longer needed, then delete that file.
- **No stored login.** Each push used a throwaway Docker configuration folder, created for the
  push and deleted after it, so no credential reached the machine's Docker login store.
- **GitHub:** the repository is pushed with a fine-grained token. The container registry needs
  one of the two ways above.

## 5. How it was built

The image is the one described in the Dockerfile, built from a tree whose application files equal
commit `68c77ba`, for `linux/amd64` only. The build added the labels `revision`, `version` and
`created` and six tags, three for each address:

```sh
docker build --label org.opencontainers.image.revision=<commit> \
  --label org.opencontainers.image.version=0.1.0 \
  --label org.opencontainers.image.created=<UTC time> \
  -t mdiazm01/remix3-local-rag-agent:latest -t mdiazm01/remix3-local-rag-agent:0.1.0 \
  -t mdiazm01/remix3-local-rag-agent:<short commit> \
  -t ghcr.io/migueldiaz66/remix3-local-rag-agent:latest \
  -t ghcr.io/migueldiaz66/remix3-local-rag-agent:0.1.0 \
  -t ghcr.io/migueldiaz66/remix3-local-rag-agent:<short commit> .
```

There is no `linux/arm64` image. Apple Silicon machines run the `amd64` one under emulation. A
multi-architecture build needs `docker buildx`, or the Action above.

## 6. Keeping or removing it

- **New version:** build again, tag it with the next version and the new commit, push `latest`
  with it, and change the tag in the compose file.
- **Remove from Docker Hub:** delete a tag, or the repository, in the repository's settings on
  Docker Hub. The token's Delete permission also allows it through the API.
- **Remove locally:** `docker image rm` the tags. The local tags share one image, so the layers
  go with the last one.
