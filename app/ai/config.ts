// config.ts: every tunable of the AI side, read once from the environment with local defaults.
//
// Objective
//   Gather in one object what the other app/ai modules and the ingest need to know about the
//   machine: where Ollama and Qdrant listen, which models to use, how big the context window is,
//   which text the RAG answers from and how it is cut, how many passages a prompt gets. Each
//   value has a default that works on a plain local setup and an environment variable that
//   overrides it, so nothing is edited in code to try another model or port. Everything runs on
//   this machine: no cloud service and no key, ever.
//
// Dependencies
//   process.env only; no import. The values point at Ollama (default http://localhost:11434) and
//   Qdrant (default http://localhost:6335), but this file talks to neither.
//
// Consumers
//   app/ai/ollama.ts: ollamaUrl, chatModel, chatThink, numCtx, chatTemperature, embedModel.
//   app/ai/qdrant.ts: qdrantUrl, collection.
//   app/ai/rag.ts: embedModel, ragLimit.
//   scripts/ingest.ts: corpusPath, chunkMaxChars, embedModel, ollamaUrl, collection, qdrantUrl.
//   app/ai/chat.ts, and the tests app/ai/chat.test.ts, ollama.test.ts, qdrant.test.ts and
//     rag.test.ts, read it directly.
//
// How it relates to them
//   The object is built once when the module loads, so an environment variable must be set
//   before the process starts; changing process.env later changes nothing. Consumers read the
//   fields and never write them. A number field is already a number: callers do not parse it.

/**
 * The chat model's name as Ollama knows it; a variable of its own because `config.chatThink`
 * below depends on which family it belongs to. qwen3:1.7b is the default: measured on this CPU
 * (24 October 2026), with thinking off it generates 1.7 times faster than qwen2.5:3b, processes
 * prompts 1.9 times faster, and made cleaner tool calls.
 *
 * Called by: config (this file)
 */
const chatModel = process.env.CHAT_MODEL ?? 'qwen3:1.7b'

/**
 * The settings of the AI side, read once at load time. Every field has an environment variable:
 * OLLAMA_URL, CHAT_MODEL, CHAT_THINK, EMBED_MODEL, NUM_CTX, CHAT_TEMPERATURE, QDRANT_URL,
 * QDRANT_COLLECTION, CORPUS_PATH, CHUNK_MAX_CHARS, RAG_LIMIT.
 *
 * Called by: app/ai/chat.ts, app/ai/ollama.ts, app/ai/qdrant.ts, app/ai/rag.ts,
 *   scripts/ingest.ts, app/ai/chat.test.ts, app/ai/ollama.test.ts, app/ai/qdrant.test.ts,
 *   app/ai/rag.test.ts
 */
export const config = {
  // Where Ollama listens; 11434 is its default port.
  ollamaUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
  // The chat model, chosen above; see the measurements there.
  chatModel,
  // Thinking models (Qwen 3) spend three times the tokens on a short answer; keep it off unless
  // CHAT_THINK=1. Models without the capability must not receive the field, so it stays
  // undefined for them and ollama.ts leaves it out of the request.
  chatThink: chatModel.startsWith('qwen3') ? process.env.CHAT_THINK === '1' : undefined,
  // The embedding model for passages and questions; rag.ts adds nomic's task prefixes for it.
  embedModel: process.env.EMBED_MODEL ?? 'nomic-embed-text',
  // A context window kept small on purpose: prompt processing is the slow part on this CPU.
  numCtx: Number(process.env.NUM_CTX ?? 4096),
  // Low on purpose: at Ollama's default the small model called highlight_node in 2 runs of 6.
  chatTemperature: Number(process.env.CHAT_TEMPERATURE ?? 0),
  // Where Qdrant's REST API listens; this project uses 6335 rather than Qdrant's usual 6333.
  qdrantUrl: process.env.QDRANT_URL ?? 'http://localhost:6335',
  // The collection the ingest fills and the RAG searches.
  collection: process.env.QDRANT_COLLECTION ?? 'rag-article',
  // The text the RAG answers from, relative to the repository root, where npm runs the ingest.
  corpusPath: process.env.CORPUS_PATH ?? 'data/rag-wikipedia.md',
  // The size, in characters, a passage aims for when the ingest cuts the corpus; about 500 keeps
  // four passages well inside the context window together with the question and the answer.
  chunkMaxChars: Number(process.env.CHUNK_MAX_CHARS ?? 500),
  // How many passages a RAG prompt gets. Few, so the prompt stays short.
  ragLimit: Number(process.env.RAG_LIMIT ?? 4),
}
