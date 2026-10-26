// ingest.ts: loads the corpus into Qdrant: chunk, embed, upsert.
//
// Objective
//   Build the RAG's index from the corpus on disk (data/rag-wikipedia.md by default).
//   Idempotent: every run drops the collection and fills it again, so the collection always
//   mirrors the corpus. It reads the file, cuts it into chunks of about config.chunkMaxChars
//   characters, embeds them in batches, writes the points, and verifies the count. Run from the
//   repository root with Node 24: npm run ingest. Progress goes to stdout; a failure goes to
//   stderr and exits with 1.
//
// Dependencies
//   node:fs/promises: readFile, for the corpus. node:path: resolve, for its path.
//   ../app/ai/chunk.ts: chunkMarkdown. ../app/ai/config.ts: corpusPath, chunkMaxChars,
//     embedModel, ollamaUrl, collection, qdrantUrl. ../app/ai/ollama.ts: embed.
//     ../app/ai/qdrant.ts: count, deleteCollection, ensureCollection, upsert.
//     ../app/ai/rag.ts: documentInput.
//   Ollama (http://localhost:11434 by default, with the embedding model pulled) and Qdrant
//     (http://localhost:6335 by default), both running.
//
// Consumers
//   `npm run ingest` (package.json), run by a person before the first chat in RAG or agent mode
//   and after every change to the corpus, the chunking or the embedding model. Nothing
//   imports this file.
//
// How it relates to them
//   The server never writes to Qdrant; this script is the only writer, and the server's errors
//   ("run npm run ingest") point here. Passages are embedded through rag.ts: documentInput, the
//   same function that defines what retrieve looks for, so the two cannot disagree.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { chunkMarkdown } from '../app/ai/chunk.ts'
import { config } from '../app/ai/config.ts'
import { embed } from '../app/ai/ollama.ts'
import { count, deleteCollection, ensureCollection, upsert } from '../app/ai/qdrant.ts'
import { documentInput } from '../app/ai/rag.ts'

/**
 * How many chunks go to Ollama in one embed call and to Qdrant in one upsert. Small enough that
 * a progress line appears every few seconds on this CPU.
 *
 * Called by: main (this file)
 */
const BATCH = 16

/**
 * The whole ingest, start to end; throws on the first failure, which the top level reports.
 *
 * Called by: the script's own top level
 * @returns nothing; throws when the corpus cannot be read or yields no chunks, when Ollama or
 *   Qdrant fail (their own messages), and when the stored count differs from the chunk count
 */
async function main(): Promise<void> {
  // When the run began, for the progress lines.
  let started = Date.now()
  // Seconds since the start, with one decimal, as "12.3s".
  let elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`

  // The corpus's absolute path: config.corpusPath is relative to the working directory, which
  // npm sets to the repository root.
  let path = resolve(process.cwd(), config.corpusPath)
  // Declared outside the try so the rest of the function can use it.
  let markdown: string
  // Read the whole corpus as text.
  try {
    // UTF-8, as the corpus is written.
    markdown = await readFile(path, 'utf-8')
    // A missing or unreadable file: name the path and the variable that changes it.
  } catch (error) {
    // The message says where it looked and why it failed.
    throw new Error(`Cannot read the corpus at ${path} (CORPUS_PATH): ${reason(error)}`)
  }

  // Cut the corpus into passages of about config.chunkMaxChars characters.
  let chunks = chunkMarkdown(markdown, { maxChars: config.chunkMaxChars })
  // An empty result means the wrong file or an empty one; stop before touching Qdrant.
  if (chunks.length === 0) throw new Error(`No chunks came out of ${path}`)
  // How many distinct chapters, for the summary line.
  let chapters = new Set(chunks.map((chunk) => chunk.chapter)).size
  // The longest chunk in characters, to spot a table or paragraph far over the target size.
  let longest = Math.max(...chunks.map((chunk) => chunk.text.length))
  // The summary of the cut, before any network call.
  console.log(
    `${chunks.length} chunks in ${chapters} chapters from ${path} (longest ${longest} chars)`,
  )

  // The first embedding tells the vector size and proves Ollama and the embedding model are there.
  console.log(`embedding with ${config.embedModel} at ${config.ollamaUrl}`)
  // Embed the first chunk alone; a failure here is Ollama's, before the collection is dropped.
  let [probe] = await embed([documentInput(chunks[0]!)])
  // The vector size the collection must be created with.
  let dimensions = probe!.length

  // Say what is about to be rebuilt and where.
  console.log(
    `recreating collection "${config.collection}" at ${config.qdrantUrl} ` +
      `(${dimensions} dimensions)`,
  )
  // Drop the old collection, whatever it held; nothing happens if it does not exist.
  await deleteCollection()
  // Create it fresh with the right vector size.
  await ensureCollection(dimensions)

  // Embed and write the chunks BATCH at a time, in corpus order.
  for (let i = 0; i < chunks.length; i += BATCH) {
    // The chunks of this batch; the last batch may be shorter.
    let batch = chunks.slice(i, i + BATCH)
    // One vector per chunk, in order, embedded exactly as retrieve embeds a question's match.
    let vectors = await embed(batch.map(documentInput))
    // One point per chunk: the chunk id, its vector, the chunk as payload.
    await upsert(batch.map((payload, j) => ({ id: payload.id, vector: vectors[j]!, payload })))
    // Progress: how many chunks are stored so far, and the time spent.
    console.log(`${Math.min(i + BATCH, chunks.length)}/${chunks.length} (${elapsed()})`)
  }

  // Ask Qdrant how many points it holds now.
  let stored = await count()
  // Every chunk must be a point; a smaller count means two chunks shared an id or a write was
  // lost.
  if (stored !== chunks.length) {
    // Say both numbers.
    throw new Error(`Qdrant holds ${stored} points but ${chunks.length} chunks were sent`)
  }
  // The final line: what is in the collection and how long it took.
  console.log(
    `done: ${stored} points in "${config.collection}" at ${config.qdrantUrl} in ${elapsed()}`,
  )
}

/**
 * The text of an error, whatever was thrown.
 *
 * Called by: main, the script's own top level (this file)
 * @param error anything thrown
 * @returns the message of an Error, or the value as a string
 */
function reason(error: unknown): string {
  // Errors have a message; anything else is shown as text.
  return error instanceof Error ? error.message : String(error)
}

// Run, and turn any failure into one line on stderr and a non-zero exit, so npm reports it.
main().catch((error: unknown) => {
  // The failure, prefixed so it is clear which script failed.
  console.error(`ingest failed: ${reason(error)}`)
  // A non-zero exit so a shell or CI step notices.
  process.exit(1)
})
