# Remix 3 Local RAG Agent Guide

This app was scaffolded with `remix new`. Use these conventions when continuing to build it out.

## Commands

```sh
npm i
npm run dev
npm run hmr
npm run start
npm test
npm run typecheck
```

Use `npm run hmr` for live server and browser updates; `npm run dev` only watches and restarts
the server. `npm run start` runs in production mode without a separate build step. Two more
commands belong to the AI side: `npm run ingest` loads `data/rag-wikipedia.md` into Qdrant
(Ollama and Qdrant must be running), and `npm run check:comments` verifies the documentation
rules of `CONTRIBUTING.md`.

## Building Features

Refer to ./.agents/skills/remix/SKILL.md for the Remix mental model and how to find guides and
API READMEs through `node_modules/remix/INDEX.md`.

The project's own documents sit at the repository root and in `docs/`: `README.md` (setup,
decisions, results), `docs/architecture.md` (the architecture design document: concepts, use
cases, every component, protocol, test and decision, in layers) and
`docs/notes-rag-and-frameworks.md` (what is hand-made in `app/ai/` and the chat panel, and which
open-source RAG and chat UI frameworks could replace it; read it before proposing such a
replacement). The corpus the RAG answers from is `data/rag-wikipedia.md`, with its license in
`data/NOTICE.md`. How the code is documented, and the rule that keeps the comments true, is in
`CONTRIBUTING.md` here; run `npm run check:comments` before every commit.

## Starter Layout

- `app/routes.ts` defines the shared route contract used by server and browser modules for
  type-safe hrefs
- `app/router.ts` wires routes to controllers and installs the standard Remix component renderer
  used by actions
- Put top-level route actions in `app/actions/controller.tsx`; add
  `app/actions/<route-key>/controller.tsx` for nested route maps. `app/actions/controller.test.ts`
  is the root controller's router smoke test
- `app/actions/page.tsx` and `app/actions/document.tsx` render the route-owned UI
- `app/actions/public/` contains the browser runtime entry, the chat panel and the React Flow
  island
- `app/ai/` is the server side of the AI: chunking, embeddings, Qdrant, RAG, the agent and the
  chat endpoint; `app/fixtures/rag-pipeline.ts` is the graph the canvas draws
- `app/assets.ts` owns the server-side asset pipeline used by the asset route and render
  middleware
- Root `public/` contains static files served unchanged from the app root

This starter intentionally begins small; add directories like `app/data/`, `app/middleware/`,
`app/ui/`, and `test/` only when you need them.
