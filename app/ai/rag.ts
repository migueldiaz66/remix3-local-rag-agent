// rag.ts: retrieval over the article, and the prompt built from it.
//
// Objective
//   The retrieval-augmented path in four steps that other modules compose: how a question and a
//   passage are turned into embedding inputs (queryInput, documentInput), how a question finds
//   its passages (retrieve), and how the passages and the question become the messages the
//   LLM answers from (buildRagMessages, RAG_SYSTEM_PROMPT). cite formats one passage's place
//   the way the prompt and the panel show it.
//
// Dependencies
//   ./config.ts: embedModel, to know whether the embedding model wants nomic's task prefixes;
//     ragLimit, the default number of passages.
//   ./ollama.ts: embed, for the question's vector.
//   ./qdrant.ts: search, for the closest passages.
//   ./types.ts: ChatMessage, Chunk, Source.
//   Ollama and Qdrant, indirectly, through those two modules.
//
// Consumers
//   app/ai/chat.ts: retrieve and buildRagMessages, the RAG mode of POST /api/chat.
//   app/ai/agent.ts: retrieve and cite, for the agent's retrieval.
//   scripts/ingest.ts: documentInput, so passages are embedded exactly as retrieve expects.
//   app/ai/rag.test.ts: everything exported; app/ai/agent.test.ts: retrieve, cite.
//
// How it relates to them
//   documentInput and queryInput are two halves of one contract: a passage stored under one
//   prefix is found by a question embedded under the matching one. Changing either, or the
//   embedding model, needs a new `npm run ingest`. retrieve returns Sources best first; finding
//   nothing gives an empty list, not an error, and buildRagMessages tells the LLM so.
import { config } from './config.ts'
import { embed } from './ollama.ts'
import { search } from './qdrant.ts'
import type { ChatMessage, Chunk, Source } from './types.ts'

/**
 * Matches the models that want task prefixes. nomic-embed-text was trained with a task prefix on
 * every text, one for the documents and another for the queries; other models take the text as
 * is.
 *
 * Called by: queryInput, documentInput (this file)
 */
const NOMIC = /^nomic-embed-text/

/**
 * What a question is embedded as: the question itself, prefixed with "search_query: " for nomic.
 *
 * Called by: retrieve (this file), app/ai/rag.test.ts
 * @param question the user's text
 * @returns the text to pass to embed
 */
export function queryInput(question: string): string {
  // The prefix depends on the embedding model in use, read at call time so tests can switch it.
  return NOMIC.test(config.embedModel) ? `search_query: ${question}` : question
}

/**
 * What a chunk is embedded as: its chapter heading then its text, so the passage carries its
 * context; prefixed with "search_document: " for nomic.
 *
 * Called by: scripts/ingest.ts: main, app/ai/rag.test.ts
 * @param chunk the passage, with chapter and text
 * @returns the text to pass to embed
 */
export function documentInput(chunk: Chunk): string {
  // Chapter on the first line, then the passage: the heading gives the passage its context.
  let text = `${chunk.chapter}\n${chunk.text}`
  // The prefix depends on the embedding model in use.
  return NOMIC.test(config.embedModel) ? `search_document: ${text}` : text
}

/**
 * Embeds the question and returns the closest passages, best first.
 *
 * Called by: app/ai/chat.ts, app/ai/agent.ts, app/ai/rag.test.ts, app/ai/agent.test.ts
 * @param question the user's text, as typed
 * @param limit how many passages at most; config.ragLimit by default
 * @returns up to `limit` sources sorted by score, possibly none; throws when Ollama returns no
 *   vector, and with the errors of embed and search when they fail
 */
export async function retrieve(
  question: string,
  limit: number = config.ragLimit,
): Promise<Source[]> {
  // One text in, one vector out; destructured because embed works on lists.
  let [vector] = await embed([queryInput(question)])
  // embed checks the count, but the type still allows undefined; say so plainly if it happens.
  if (!vector) throw new Error('Ollama returned no embedding for the question')
  // The nearest passages from Qdrant.
  return search(vector, limit)
}

/**
 * The instructions the LLM gets in RAG mode. Short on purpose: prompt processing is the slow
 * part on this CPU. It says the passages come from an article about retrieval-augmented
 * generation, confines the LLM to them, asks for the section of each passage used, in
 * parentheses, by the name in the passage label, and for an honest "the passages do not cover
 * it". It gives no example name: a small LLM copies an example instead of reading the label.
 *
 * Called by: buildRagMessages (this file), app/ai/rag.test.ts
 */
export const RAG_SYSTEM_PROMPT =
  'You answer questions about retrieval-augmented generation (RAG). The user gives you ' +
  'numbered passages from an article about it. ' +
  'Answer only from those passages; do not add outside knowledge. ' +
  'After each statement that uses a passage, name that passage in parentheses by the section ' +
  'in its label, copied exactly and without the line numbers. ' +
  'If the passages do not contain the answer, say plainly that the passages do not cover it. ' +
  'Be brief: a few sentences, in English.'

/**
 * The messages for the LLM: the system prompt, then one user message with the passages as
 * "[1] Improvements, Chunking, lines 69-71:" followed by the text, then the question.
 *
 * Called by: app/ai/chat.ts, app/ai/rag.test.ts
 * @param question the user's text
 * @param sources the passages from retrieve, in the order to number them; may be empty
 * @returns two messages, system then user, ready for chat
 */
export function buildRagMessages(question: string, sources: Source[]): ChatMessage[] {
  // The numbered passages, or a sentence that tells the LLM there are none, so it does not
  // invent some.
  let passages =
    sources.length === 0
      ? 'No passages were found.'
      : sources.map((source, i) => `[${i + 1}] ${cite(source)}:\n${source.text}`).join('\n\n')
  // Instructions first, then passages and question in one user turn.
  return [
    { role: 'system', content: RAG_SYSTEM_PROMPT },
    { role: 'user', content: `Passages:\n\n${passages}\n\nQuestion: ${question}` },
  ]
}

/**
 * Where a passage is, in the words the prompt and the panel use: "Process, lines 17-29" for a
 * passage directly under a chapter heading, "Improvements, Chunking, lines 69-71" for one under
 * a sub-heading, so the label names the section the whole passage belongs to.
 *
 * Called by: buildRagMessages (this file), app/ai/agent.ts, app/ai/agent.test.ts,
 *   app/ai/rag.test.ts
 * @param source anything with a chapter, a heading and a line range, a Chunk or a Source
 * @returns the chapter, then the sub-heading when it differs from the chapter, then the
 *   inclusive line range, all separated by commas
 */
export function cite(source: Pick<Source, 'chapter' | 'heading' | 'lines'>): string {
  // The chapter as written in its "## " heading; a sub-heading adds the narrower section.
  let place =
    source.heading === source.chapter ? source.chapter : `${source.chapter}, ${source.heading}`
  // The place, then the 1-based inclusive lines.
  return `${place}, lines ${source.lines[0]}-${source.lines[1]}`
}
