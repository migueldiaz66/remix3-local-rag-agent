# Dockerfile: the app image of the Remix 3 local RAG agent: the page, the chat endpoint, the ingest.
# Two stages: "build" installs everything and builds the React Flow island bundle, "runtime" keeps
# only what runs. Ollama and Qdrant are NOT in this image: docker/compose.stack.yml starts them
# from their official images. Explained in Dockerfile_README.md beside this file.

# Stage 1, "build": a Node image with the exact version the project is developed with (.nvmrc).
FROM node:24.22.1-bookworm-slim AS build
# The folder everything happens in, inside the image.
WORKDIR /app
# Only the manifests first, so the install layer is reused until a dependency changes.
COPY package.json package-lock.json ./
# Install exactly what package-lock.json pins, dev dependencies included: esbuild needs them.
RUN npm ci
# The rest of the source: whatever .dockerignore lets through.
COPY . .
# Build the React Flow island, the bundle and the stylesheet the page loads in the browser.
RUN npm run build:flow

# Stage 2, "runtime": a fresh image of the same Node version, so nothing from stage 1 leaks in.
FROM node:24.22.1-bookworm-slim AS runtime
# The repository this image is built from; GitHub uses it to link the package to the repository.
LABEL org.opencontainers.image.source="https://github.com/migueldiaz66/remix3-local-rag-agent"
# One line that says what the image is.
LABEL org.opencontainers.image.description="Remix 3 page with a React Flow canvas and a local RAG chat. Needs Ollama and Qdrant: see docker/compose.stack.yml."
# The code is MIT and the corpus is the CC BY-SA 4.0 Wikipedia article in data/.
LABEL org.opencontainers.image.licenses="MIT AND CC-BY-SA-4.0"
# Production mode: the server serves the built bundle and the app skips its development helpers.
ENV NODE_ENV=production
# The port the server listens on; the app reads PORT, and 44100 is its default.
ENV PORT=44100
# The folder everything runs in, inside the image.
WORKDIR /app
# The user "node" (id 1000) of the base image owns the folder, so the server needs no root rights.
RUN chown node:node /app
# From here on, commands and the server run as that user.
USER node
# Only the manifests first, again for the layer cache.
COPY --chown=node:node package.json package-lock.json ./
# Install only the runtime dependencies: no TypeScript, no esbuild, no type packages.
RUN npm ci --omit=dev
# The app source, with the island bundle built in stage 1.
COPY --chown=node:node --from=build /app/app ./app
# Static files served as they are, such as the favicon.
COPY --chown=node:node --from=build /app/public ./public
# The corpus and its license notice: the ingest reads data/rag-wikipedia.md.
COPY --chown=node:node --from=build /app/data ./data
# The ingest script, run once to fill Qdrant: node --import remix/node-tsx scripts/ingest.ts.
COPY --chown=node:node --from=build /app/scripts ./scripts
# The server entry point, the TypeScript settings its loader reads, and the code license.
COPY --chown=node:node --from=build /app/server.ts /app/tsconfig.json /app/LICENSE ./
# Documentation only: the port the server listens on.
EXPOSE 44100
# Healthy when the home page answers; node is already here, so no curl is needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://localhost:'+process.env.PORT+'/').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Start the server: the Remix loader runs the TypeScript source directly.
CMD ["node", "--import", "remix/node-tsx", "server.ts"]
