# Where the image is stored: Docker Hub and GitHub

The app image of this project is stored on two registries. This document says where, what is
there, how to pull it, who can push to it and with what, and what is not finished. The image is
built by the [Dockerfile](../Dockerfile) and used by
[docker/compose.stack.yml](../docker/compose.stack.yml). What it contains is in
[Dockerfile_README.md](../Dockerfile_README.md), and its measured numbers are in
[docker-run.md](docker-run.md).

## 1. The two places at a glance

| | Docker Hub | GitHub Container Registry |
|---|---|---|
| Address | `docker.io/mdiazm01/remix3-local-rag-agent` | `ghcr.io/migueldiaz66/remix3-local-rag-agent` |
| Published | 26 October 2026: `0.1.0` at 17:13 UTC, `0.1.1` at 19:07 UTC | 26 October 2026: `0.1.0` at 17:36 UTC, `0.1.1` at 19:08 UTC |
| Visibility | Public, checked through Docker Hub's API | Public and connected to the repository, checked through GitHub's API |
| Tags `latest`, `0.1.1`, `b1eff4a` | `linux/amd64` and `linux/arm64` | `linux/amd64` and `linux/arm64` |
| Tags `0.1.0`, `68c77ba` | `linux/amd64` only | `linux/amd64` only |
| Tags `0.1.1-amd64`, `latest-amd64` | `linux/amd64` only | `linux/amd64` only |
| Tags `0.1.1-arm64`, `latest-arm64` | `linux/arm64` only | `linux/arm64` only |
| Page | <https://hub.docker.com/r/mdiazm01/remix3-local-rag-agent> | <https://github.com/users/migueldiaz66/packages/container/package/remix3-local-rag-agent> |

The digests of the two versions:

| Tags | Index on Docker Hub | Index on ghcr.io |
|---|---|---|
| `0.1.1`, `latest`, `b1eff4a` | `sha256:384279c575bd0bd1e0204c5c20a2bca3fb93c927b1d824c5134ab69c8345c529` | `sha256:9dee6b41e093baea5f0defdf04003b4e770146178c82ee2dde53adafc39294b3` |
| `0.1.0`, `68c77ba` | `sha256:5bf7f013142ccc9e3ceb874bf11699f91517fd9939214031f47e37c776944ed1` | the same |

The two indexes of `0.1.1` differ because the build ran once per registry, and each run wrote its
own provenance attestations into its index. The images inside them are the same on both:

| Inside `0.1.1` | Digest | Compressed size |
|---|---|---|
| `linux/amd64` | `sha256:122cc00ae17bc1840669264c9d9a5a56169ee58afb36d2871723c9b43b19a2db` | 119,843,736 bytes |
| `linux/arm64` | `sha256:f83a5329b6e5992271e46e9a14d10c0b8b16e7495be33a13ebe17f4f6843b085` | 117,745,660 bytes |

The raw outputs are in [docker-run/arm64-build.txt](docker-run/arm64-build.txt). The version
`0.1.0` was not touched when `0.1.1` was published, so its digest, in section 3, keeps its meaning.

**The explicit tags.** `0.1.1-amd64`, `0.1.1-arm64`, `latest-amd64` and `latest-arm64` exist on
both registries, so that a person can choose a platform by name. They were made without a
rebuild, with `docker buildx imagetools create` from the digest of each platform image above, so
each points at one platform and carries that platform's provenance attestation. Their own index
digests, which differ from the ones above, are in
[docker-run/platform-tags.txt](docker-run/platform-tags.txt). The names do not say `windows` or
`mac` on purpose: the images are Linux ones, and such names would mislead.

## 2. Version 0.1.1: amd64 and arm64

**Which image is mine?** Docker picks the platform of the computer. On both hubs the operating
system shows as `linux`, for Windows and Mac as well, because Docker Desktop runs containers in a
Linux virtual machine.

| Your computer | You get |
|---|---|
| Windows PC, Intel or AMD; Mac with an Intel chip; Linux on x86-64 | `linux/amd64` |
| Mac with Apple Silicon; Windows on Arm; Linux on Arm, Raspberry Pi | `linux/arm64` |

There is no Windows or macOS container image: the official Qdrant and Ollama images, which the
stack needs, are `linux/amd64` and `linux/arm64` only. The Docker Hub page carries this table, as
its README, and a short description. Their source is
[dockerhub-overview.md](dockerhub-overview.md), set through Docker Hub's API.

**How to pull it.** Docker picks the platform of the machine:

```sh
docker pull mdiazm01/remix3-local-rag-agent:0.1.1
docker compose -f docker/compose.stack.yml up
```

The second command starts the whole stack. It pulls the app image from Docker Hub, because the
compose file names it, and builds it from the repository only with `--build`. To force a platform,
add `--platform linux/arm64` to `docker pull`.

**What is stored.** Each index lists the two images and one provenance attestation for each. The
image is only the app: Ollama, Qdrant and the models are not in it, so `docker run` on it alone
shows the page but cannot answer a question. Use the compose file. The labels are `source`,
`description`, `licenses`, and `revision` (the commit `b1eff4aa226a6070ec4f3ca732fe1564c0dc35cb`),
`version` (0.1.1) and `created` (2026-10-26T19:04:28Z).

**How it was built.** One `docker buildx build --platform linux/amd64,linux/arm64`, with the
`arm64` half under QEMU emulation on an amd64 laptop, once for Docker Hub (196 s) and once for
ghcr.io (30 s, from the cache). The first `FROM` of the Dockerfile runs on the builder, so esbuild
made the bundle natively and only `npm ci --omit=dev` ran under emulation. The commit
`b1eff4a` is the one that added that line.

**Checked from outside**, with an empty Docker configuration, which is an anonymous user, in
[docker-run/arm64-smoke-test.txt](docker-run/arm64-smoke-test.txt):

- The `linux/arm64` image was pulled from both registries.
- Started alone under emulation, it reported `aarch64` and Node 24.22.1, ran as the user `node`,
  logged `Server listening`, and answered the home page with status 200 after 42 s.
- The island's stylesheet and a Remix runtime file were served with status 200, so esbuild,
  which Remix's asset server runs at request time, works in the `arm64` image.
- **The healthcheck reported `unhealthy`**, after 144 s, while the page answered. The check starts
  a Node process with a 5 second timeout, and under emulation that start takes longer. On Arm
  hardware it should not happen, but it was not run there.

**Not checked.** A run on real Arm hardware: only the emulated start is evidence. Neither speed
nor the chat was tried on `arm64`.

## 3. Version 0.1.0, the first publication

Published on Docker Hub at 17:13 to 17:14 UTC and on ghcr.io at 17:36 to 17:37 UTC, for
`linux/amd64` only. Its tags `0.1.0` and `68c77ba` still point at it.

| Item | Value |
|---|---|
| Index digest, on both registries | `sha256:5bf7f013142ccc9e3ceb874bf11699f91517fd9939214031f47e37c776944ed1` |
| The `linux/amd64` image inside it | `sha256:5dfcc673c1a9d077c300b29e8f0038943f4c54b9d35f4b8c58ac0ac4ba0760c0` |
| A provenance attestation, listed with platform "unknown" | `sha256:99174461bc687659cf1f7a703f95b6b9afc29e37a3d4972449fcbaed737711ac` |
| Size stored, as Docker Hub reports it | 119,843,469 bytes compressed; the repository's storage was 119,860,527 bytes |
| Size on disk once pulled | 471 MB |
| Labels | `source`, `description`, `licenses`, and `revision` (commit `68c77bae53b61a4e5965203ac16fd7cfc0a49f61`), `version` (0.1.0) and `created` (2026-10-26T17:12:39Z) |

The compressed size is the third of the three sizes in `docker-run.md`: Docker Hub's figure agrees
with the one `docker image inspect` printed. Docker Hub's API reported the repository as public;
with an empty Docker configuration, and after the local tags of that name were removed,
`docker pull` downloaded the image. Started alone, it answered the home page with status 200, was
healthy after 40 s, ran as the user `node`, and carried the labels above.

## 4. How the registries got there: Docker Hub and GitHub

**Docker Hub** took the push at once and made the repository public.

**GitHub's container registry** took two attempts for `0.1.0`.

1. The first push used the fine-grained token of the repository and was refused:

   ```
   error from registry: permission_denied: The token provided does not match expected scopes.
   ```

   A token of that kind is not accepted for container packages. The login succeeded; only the
   push was denied.
2. The author then created a classic personal access token with the `write:packages` scope, among
   many others (section 5). The first push with it, of all three tags at once, created the package
   and uploaded the layers and the provenance record, and then ended with `error from registry:
   denied`. Pushing the tags one at a time succeeded, with the same digest as on Docker Hub. The
   cause of the first denial was not investigated. The `0.1.1` push, one build for several tags,
   had no such denial.

After the push the package was private and not connected to the repository, so the repository's
Packages box said "No packages published". The author changed both in GitHub's web pages, because
the API offers neither. The API now reports the package as public and connected to
`migueldiaz66/remix3-local-rag-agent`. The `source` label is in the image's configuration, and the
link was not made automatically; the cause was not investigated.

**Limits.** Docker Hub counts pulls: an anonymous client may pull 100 times in 6 hours per IP
address, and a free account 200 (Docker's usage page, read for this project). A multi-architecture
image counts one pull per architecture. GitHub's billing page says storage and bandwidth for
container images are currently free for public packages, with at least a month's notice before
that changes, and states no pull limit.

## 5. Who can push, and how it was done

- **Docker Hub:** the account `mdiazm01`. The pushes, the explicit tags and the page text used a
  personal access token with Read, Write and Delete permissions that expires on 25 November 2026.
  The token is not in this repository.
  A screenshot of the page that shows it is kept in `.secrets/`, a folder that git and Docker
  both ignore (`gitignore_README.md`). Revoke the token in Docker Hub's account settings when it
  is no longer needed, then delete that file.
- **GitHub, the container registry:** the account `migueldiaz66`. The pushes used a classic personal
  access token that expires on 25 November 2026. The only scope they needed is `write:packages`.
  The token has far more, among them `repo`, `workflow`, `delete_repo`, `delete:packages` and
  `admin:org`, so it can do much more than push an image. It should be revoked once the images are
  pushed. A screenshot of the page that showed it is in `.secrets/` too, ignored in the same way.
- **GitHub, the repository:** pushed with a fine-grained token, which cannot write packages.
- **No stored login.** Each push used a throwaway Docker configuration folder, created for the
  push and deleted after it, so no credential reached the machine's Docker login store. A
  multi-platform push through such a folder needs two extra settings, because the folder hides what
  the default one holds: `BUILDX_CONFIG` pointing at the default buildx folder, so the builder is
  found, and a copy of the default `contexts` folder, so the builder's Docker endpoint resolves.

## 6. How it was built

The setup, once per machine, and the build of `0.1.1`, with the labels `revision`, `version` and
`created` and three tags per registry:

```sh
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker buildx create --name multiarch --driver docker-container --bootstrap
docker buildx build --builder multiarch --platform linux/amd64,linux/arm64 --push \
  --label org.opencontainers.image.revision=<commit> \
  --label org.opencontainers.image.version=0.1.1 \
  --label org.opencontainers.image.created=<UTC time> \
  -t mdiazm01/remix3-local-rag-agent:0.1.1 -t mdiazm01/remix3-local-rag-agent:latest \
  -t mdiazm01/remix3-local-rag-agent:<short commit> .
```

The same command with `ghcr.io/migueldiaz66/remix3-local-rag-agent` as the name pushed to GitHub.
Docker Desktop on this laptop had no `linux/arm64` emulation registered, which the first command
fixed until Docker restarts. `0.1.0` was built the plain way, for `linux/amd64` only, from a tree
whose application files equal commit `68c77ba`.

## 7. Keeping or removing it

- **New version:** build again, tag it with the next version and the new commit, push `latest`
  with it, and change the tag in the compose file. Old versions stay as they are.
- **Remove from Docker Hub:** delete a tag, or the repository, in the repository's settings on
  Docker Hub. The token's Delete permission also allows it through the API.
- **Remove locally:** `docker image rm` the tags. A multi-platform image is stored per platform,
  and the `multiarch` builder is a container: `docker buildx rm multiarch` removes it.
