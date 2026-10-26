# remix3-local-rag-agent

A Remix 3.1.0 page with a React Flow canvas and a local AI chat (LLM, RAG, agent) over a
Wikipedia article about retrieval-augmented generation. Everything runs on one machine: Ollama for
the models, Qdrant in Docker for the vectors. No cloud service and no key.

Read first: `README.md`, then `docs/architecture.md` (its part 0 says which parts to read for
which purpose), then `AGENTS.md` and `.agents/skills/remix/SKILL.md`. Before replacing anything
hand-made (the chunking, the prompts, the agent loop, the chat panel) with a framework, read
`docs/notes-rag-and-frameworks.md`: it records the options already weighed.

@AGENTS.md

## Rules

- Remix 3.1.0: work from `node_modules/remix/INDEX.md` and its guides, never from memory. No Remix 2
  or React Router patterns. React is used only inside the React Flow island.
- Node 24 (`.nvmrc`).
- Everything local: Ollama on port 11434, Qdrant on port 6335. No cloud service and no key.
- Before reporting work done: `npm run typecheck`, `npm test`, `npx remix doctor` and
  `npm run check:comments`, all green. The documentation rules are in `CONTRIBUTING.md`.
- Docs in English, LF line endings, lines of 100 characters or fewer.
