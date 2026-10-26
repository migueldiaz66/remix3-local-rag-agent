#!/usr/bin/env bash
# codespace.sh: sets up ("create") and starts ("start") the whole stack inside a codespace.
#
# Objective
#   Turn a fresh codespace of this repository into a running copy of the project with no manual
#   step. "create" runs once: it installs Ollama and the npm packages, then pulls the Qdrant image
#   and the two models. "start" runs on every start of the codespace: it starts Qdrant (Docker)
#   and Ollama, ingests the article, and starts the app on port 44100.
#
# Dependencies
#   bash, sudo, apt-get and curl: the base image of devcontainer.json has them.
#   https://ollama.com/install.sh: the official Ollama installer; it needs zstd to unpack.
#   Docker and docker/compose.yml: Qdrant, published on port 6335 (docker-in-docker feature).
#   npm and Node 24: npm ci, npm run ingest and npm run start (the node feature).
#   The models qwen3:1.7b and nomic-embed-text: the defaults of app/ai/config.ts. Change them
#   in both places.
#
# Consumers
#   devcontainer.json: postCreateCommand runs "create", postStartCommand runs "start".
#
# How it relates to them
#   Both modes are safe to run again: "start" skips what already runs. Output goes to the
#   creation log for "create", and to /tmp/ollama.log and /tmp/app.log for the two servers.

# Stop at the first failing command, on an unset variable and on a failure inside a pipe, so a
# broken step fails visibly instead of leaving a half-built codespace.
set -euo pipefail

# Work from the repository root, wherever the script was called from; this file is in .devcontainer.
cd "$(dirname "$0")/.."

# wait_until: runs a command once a second, up to 120 times, until it succeeds.
# Called by: create and start, for Docker, Ollama and Qdrant.
# $1 is a label for the failure message; the other arguments are the command to run.
wait_until() {
  # The label, kept before the arguments are shifted.
  local label="$1"
  # Drop the label: what remains is the command.
  shift
  # One try per second, 120 times.
  for _ in $(seq 1 120); do
    # Success: the command exited with status 0, so the service is ready.
    if "$@" > /dev/null 2>&1; then return 0; fi # ready: stop waiting
    # Not ready yet: wait one second.
    sleep 1
  done # all the tries are used
  # Say what never became ready.
  echo "Timed out waiting for $label" >&2
  # A non-zero status stops the script, because of set -e.
  return 1
}

# create: the one-time setup of a new codespace.
# Called by: the case statement below, for "create".
create() {
  # Refresh the package index so the installs below find current versions.
  sudo apt-get update
  # zstd unpacks the Ollama archive; curl fetches the installer; the certificates make HTTPS work.
  sudo apt-get install -y --no-install-recommends zstd curl ca-certificates
  # The official Ollama installer. Without systemd in the container it warns that it cannot
  # register a service; that is expected, "start" runs the server itself.
  curl -fsSL https://ollama.com/install.sh | sh
  # The app packages, exactly as package-lock.json pins them.
  npm ci
  # The Docker daemon starts with the container, a moment after it: wait for it.
  wait_until "Docker" docker info
  # Pull the Qdrant image now, so the first start does not wait for it.
  docker compose -f docker/compose.yml pull
  # A throwaway Ollama server, only to pull the models; "start" runs the real one.
  ollama serve > /tmp/ollama-create.log 2>&1 &
  # Its process id, to stop it when the models are in.
  local pid=$!
  # Wait for the server to answer on its port.
  wait_until "Ollama" curl -fs http://localhost:11434/api/tags
  # The chat model, 1.4 GB: the longest step of the creation.
  ollama pull qwen3:1.7b
  # The embedding model, 274 MB.
  ollama pull nomic-embed-text
  # Stop the throwaway server; the models stay on disk for the real one.
  kill "$pid" || true
}

# start: brings the stack up and leaves the app listening.
# Called by: the case statement below, for "start".
start() {
  # Docker may still be starting when the codespace resumes: wait for it.
  wait_until "Docker" docker info
  # Qdrant, from the same compose file as on a laptop; its volume keeps the collection.
  docker compose -f docker/compose.yml up -d
  # Start Ollama only if nothing answers on its port yet.
  if ! curl -fs http://localhost:11434/api/tags > /dev/null 2>&1; then
    # Detached from this script (setsid, nohup), so it outlives it; the models stay loaded for
    # 30 minutes between questions.
    OLLAMA_KEEP_ALIVE=30m setsid nohup ollama serve > /tmp/ollama.log 2>&1 < /dev/null &
  fi # Ollama is running
  # Wait for Ollama to answer.
  wait_until "Ollama" curl -fs http://localhost:11434/api/tags
  # Wait for Qdrant to report healthy.
  wait_until "Qdrant" curl -fs http://localhost:6335/healthz
  # Cut, embed and store the article; it replaces the collection, so it is safe to repeat.
  npm run ingest
  # Start the app only if nothing answers on its port yet.
  if ! curl -fs http://localhost:44100/ > /dev/null 2>&1; then
    # Detached like Ollama; npm start rebuilds the island bundle first, then serves on 44100.
    setsid nohup npm run start > /tmp/app.log 2>&1 < /dev/null &
  fi # the app is running
}

# The mode is the first argument: "create" or "start".
case "${1:-}" in
  # The one-time setup.
  create) create ;; # run the setup
  # The start of every session.
  start) start ;; # run the start
  # Anything else is a mistake: say how to call the script and fail.
  *) echo "usage: codespace.sh create|start" >&2; exit 2 ;; # unknown mode
esac # end of the mode switch
