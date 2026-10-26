// qdrant.ts: Qdrant over plain fetch, the collection, the points and the search.
//
// Objective
//   The only module that talks to Qdrant, through its REST API on {qdrantUrl}: create or drop
//   the collection, upsert points, search by vector, count. It maps chunk ids to the point ids
//   Qdrant accepts, and turns a Qdrant that is not running or a collection that does not exist
//   into errors that say what to do. No client library: five calls over fetch are enough.
//   See https://api.qdrant.tech/api-reference
//
// Dependencies
//   node:crypto: createHash, for the SHA-1 behind the UUID v5 point ids.
//   ./config.ts: qdrantUrl, collection.
//   ./types.ts: Chunk (the payload stored with each point) and Source (a chunk with a score).
//   Qdrant, an HTTP server on config.qdrantUrl, http://localhost:6335 by default.
//
// Consumers
//   app/ai/rag.ts: search, for the passages closest to a question.
//   scripts/ingest.ts: deleteCollection, ensureCollection, upsert, count, to rebuild the
//     collection from the corpus.
//   app/ai/qdrant.test.ts: everything exported, against a fake fetch; app/ai/rag.test.ts
//     replaces search.
//
// How it relates to them
//   The collection is config.collection, always; callers never name it. The ingest owns its life
//   cycle (drop, create, fill); the server only reads it, and a search or upsert on a missing
//   collection fails with a message that says to run `npm run ingest`. Payloads are stored and
//   returned as Chunk, untouched, so what the panel shows is what the ingest wrote.
import { createHash } from 'node:crypto'

import { config } from './config.ts'
import type { Chunk, Source } from './types.ts'

/**
 * A point to upsert: the chunk's id (mapped to a Qdrant id by pointId), its embedding and the
 * chunk itself as payload.
 *
 * Called by: upsert (this file); no other file names it
 */
export interface Point {
  // The chunk id, such as "improvements-2", or an id Qdrant already accepts.
  id: string | number
  // The embedding, of the collection's dimension.
  vector: number[]
  // Stored with the point and returned whole by search.
  payload: Chunk
}

/**
 * The namespace for UUID v5 point ids. Qdrant point ids are unsigned integers or UUIDs. A chunk
 * id such as "improvements-2" becomes a UUID v5 (SHA-1 of this namespace and the id), so the same
 * chunk always lands on the same point and a re-ingest replaces it; the chunk id itself travels
 * in the payload. Changing this value changes every point id, which only matters across an
 * ingest, since each ingest drops the collection first.
 *
 * Called by: pointId (this file)
 */
const NAMESPACE = '5c8e3a6e-0b1d-4a0b-9d6a-2f3f1e7c9b11'
/**
 * The shape of a UUID, in any case: an id that already is one is used as it is.
 *
 * Called by: pointId (this file)
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Maps a chunk id to an id Qdrant accepts: numbers and UUIDs pass through, any other string
 * becomes its UUID v5 under NAMESPACE. Deterministic: the same input always gives the same id.
 *
 * Called by: upsert (this file), app/ai/qdrant.test.ts
 * @param id a number, a UUID in any case, or any other string
 * @returns the number unchanged, the UUID in lower case, or a new lower-case UUID v5
 */
export function pointId(id: string | number): string | number {
  // Unsigned integers are valid Qdrant ids as they are.
  if (typeof id === 'number') return id
  // A UUID is valid too; lower case so the same id never appears in two spellings.
  if (UUID.test(id)) return id.toLowerCase()
  // Anything else is hashed into a UUID.
  return uuidV5(NAMESPACE, id)
}

/**
 * A UUID version 5 (RFC 4122): the SHA-1 of the namespace's bytes and the name, with the
 * version and variant bits set, formatted as 8-4-4-4-12 hex digits.
 *
 * Called by: pointId (this file)
 * @param namespace a UUID in hyphenated form
 * @param name any string, hashed as UTF-8
 * @returns a lower-case UUID string
 */
function uuidV5(namespace: string, name: string): string {
  // SHA-1 over the namespace's 16 raw bytes then the name; a UUID keeps the first 16 bytes.
  let bytes = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16)
  // Version 5 in the high nibble of byte 6.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  // The RFC 4122 variant (binary 10) in the two high bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  // The 32 hex digits.
  let hex = bytes.toString('hex')
  // Hyphenated in the 8-4-4-4-12 groups.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

/**
 * Creates the collection if it does not exist, with cosine distance. An existing collection with
 * vectors of another size is an error: the ingest recreates it.
 *
 * Called by: scripts/ingest.ts: main, app/ai/qdrant.test.ts
 * @param dimensions the vector size, the length of an embedding from the current model
 * @returns nothing; throws when Qdrant is not running, when the existing collection has another
 *   vector size, or when Qdrant refuses the creation
 */
export async function ensureCollection(dimensions: number): Promise<void> {
  // Ask for the collection; ok is false when it does not exist (404).
  let existing = await request<CollectionInfo>('GET', collectionPath())
  // It exists: check that its vectors match the embeddings before anyone writes into it.
  if (existing.ok) {
    // The configured vector size, undefined when the reply lacks it.
    let size = existing.result?.config?.params?.vectors?.size
    // A different size means another embedding model made it; searching it would be nonsense.
    if (typeof size === 'number' && size !== dimensions) {
      // Say both sizes and the fix.
      throw new Error(
        `Collection "${config.collection}" holds vectors of ${size} dimensions but the ` +
          `embeddings have ${dimensions}; run "npm run ingest" to recreate it`,
      )
    }
    // Same size: nothing to do.
    return
  }
  // Create it: vectors of the given size compared by cosine similarity, which suits text
  // embeddings.
  await request('PUT', collectionPath(), { vectors: { size: dimensions, distance: 'Cosine' } })
}

/**
 * Removes the collection; nothing happens when it does not exist. The ingest calls it first so
 * every run starts from an empty collection.
 *
 * Called by: scripts/ingest.ts: main, app/ai/qdrant.test.ts
 * @returns nothing; throws only when Qdrant is not running or answers an unexpected status
 */
export async function deleteCollection(): Promise<void> {
  // A 404 comes back as ok: false and is ignored: there was nothing to delete.
  await request('DELETE', collectionPath())
}

/**
 * Writes points into the collection, replacing those with the same id. The call waits until
 * Qdrant has applied the write, so a count right after sees the points.
 *
 * Called by: scripts/ingest.ts: main, app/ai/qdrant.test.ts
 * @param points the points to write; an empty list makes no request
 * @returns nothing; throws when the collection does not exist (with "run npm run ingest"),
 *   when Qdrant is not running, or when it refuses the write
 */
export async function upsert(points: Point[]): Promise<void> {
  // Nothing to write: no request.
  if (points.length === 0) return
  // The body Qdrant takes: a list of points with ids it accepts.
  let body = {
    points: points.map((point) => ({
      id: pointId(point.id),
      vector: point.vector,
      payload: point.payload,
    })),
  }
  // wait=true: Qdrant answers after the write is applied, not after it is queued.
  let reply = await request('PUT', `${collectionPath()}/points?wait=true`, body)
  // A 404 here means the collection is missing: ensureCollection was not run.
  if (!reply.ok) throw missingCollection()
}

/**
 * The closest chunks to a vector, best first.
 *
 * Called by: app/ai/rag.ts: retrieve, app/ai/qdrant.test.ts; app/ai/rag.test.ts replaces it
 * @param vector the question's embedding, of the collection's dimension
 * @param limit how many hits at most
 * @returns up to `limit` sources, each a stored Chunk with its cosine score, sorted by score
 *   descending; hits without a payload are dropped; throws when the collection does not exist
 *   or Qdrant is not running
 */
export async function search(vector: number[], limit: number): Promise<Source[]> {
  // Ask for the nearest points with their payloads; without with_payload Qdrant sends ids only.
  let reply = await request<Hit[]>('POST', `${collectionPath()}/points/search`, {
    vector,
    limit,
    with_payload: true,
  })
  // A 404 here means the collection is missing: the ingest was never run.
  if (!reply.ok) throw missingCollection()
  // Keep the hits that carry a chunk, attach the score, and make the order explicit rather
  // than trusting Qdrant's.
  return (reply.result ?? [])
    .filter((hit) => hit.payload !== undefined && hit.payload !== null)
    .map((hit) => ({ ...hit.payload!, score: hit.score }))
    .sort((a, b) => b.score - a.score)
}

/**
 * How many points the collection holds; 0 when it does not exist. The ingest uses it to verify
 * that every chunk was stored; the README's check uses it to see that the collection is filled.
 *
 * Called by: scripts/ingest.ts: main, app/ai/qdrant.test.ts
 * @returns the exact count, or 0 for a missing collection; throws when Qdrant is not running
 */
export async function count(): Promise<number> {
  // exact: true makes Qdrant count rather than estimate.
  let reply = await request<{ count: number }>('POST', `${collectionPath()}/points/count`, {
    exact: true,
  })
  // A missing collection is reported as empty, not as an error.
  return reply.ok ? (reply.result?.count ?? 0) : 0
}

/**
 * The part of GET /collections/{name} this module reads: the vector size.
 *
 * Called by: ensureCollection (this file)
 */
interface CollectionInfo {
  // Nested as Qdrant nests it; every level optional so an unexpected reply reads as undefined.
  config?: { params?: { vectors?: { size?: number } } }
}

/**
 * One result of POST .../points/search.
 *
 * Called by: search (this file)
 */
interface Hit {
  // The point id, as stored: a UUID or an integer.
  id: string | number
  // The similarity to the query vector; cosine here, higher is closer.
  score: number
  // The stored chunk; absent or null when the point was written without one.
  payload?: Chunk | null
}

/**
 * What request returns: whether the call succeeded, the status, and Qdrant's result field.
 *
 * Called by: request, ensureCollection, upsert, search, count (this file)
 */
interface Reply<T> {
  // True for a 2xx; false for a 404, the one failure that is not thrown.
  ok: boolean
  // The HTTP status, for callers that need more than ok.
  status: number
  // Qdrant's result field, undefined when the reply had none.
  result: T | undefined
}

/**
 * One call to the REST API. A connection failure and any status other than success or 404 are
 * errors with the reason in the message; a 404 comes back as `ok: false` so each operation can
 * decide what a missing collection means.
 *
 * Called by: ensureCollection, deleteCollection, upsert, search, count (this file)
 * @param method the HTTP method
 * @param path the path under config.qdrantUrl, starting with "/"
 * @param body the JSON body, or undefined for no body
 * @returns the reply with Qdrant's result parsed; throws "Qdrant is not running at ..." when the
 *   connection fails and "Qdrant <method> <path> answered <status>: <detail>" on other errors
 */
async function request<T = unknown>(
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Reply<T>> {
  // Declared outside the try so the rest of the function can use it.
  let response: Response
  // Send the request; a rejection here is a connection failure, not an HTTP error.
  try {
    // The headers and body go only when there is a body; a GET or DELETE sends none.
    response = await fetch(`${config.qdrantUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    // fetch rejected: Qdrant is not reachable.
  } catch (error) {
    // Name the URL and the socket error code; keep the original as the cause for debugging.
    throw new Error(`Qdrant is not running at ${config.qdrantUrl} (${describe(error)})`, {
      cause: error,
    })
  }

  // The body as text first, so a non-JSON error page can still be reported.
  let text = await response.text()
  // Qdrant's envelope: result on success, status.error on failure. Empty until parsed.
  let data: { result?: T; status?: unknown } = {}
  // Parse when there is something to parse; a body that is not JSON is kept as text below.
  try {
    // The envelope.
    if (text) data = JSON.parse(text) as typeof data
    // The body was not JSON, for example an HTML error page: data stays empty.
  } catch {
    // Not JSON: the raw text is the detail.
  }

  // Any failure but 404 is thrown with Qdrant's explanation.
  if (!response.ok && response.status !== 404) {
    // Qdrant puts the reason in status.error.
    let status = data.status as { error?: unknown } | undefined
    // The reason as Qdrant wrote it, or the raw body when there is no such field.
    let detail = typeof status?.error === 'string' ? status.error : text
    // Method and path, so the message says which operation failed.
    throw new Error(
      `Qdrant ${method} ${path} answered ${response.status}${detail ? `: ${detail}` : ''}`,
    )
  }
  // Success, or a 404 the caller interprets.
  return { ok: response.ok, status: response.status, result: data.result }
}

/**
 * The REST path of the configured collection, with its name URL-encoded.
 *
 * Called by: ensureCollection, deleteCollection, upsert, search, count (this file)
 * @returns "/collections/<name>"
 */
function collectionPath(): string {
  // One place for the path, so the collection name is never spelled twice.
  return `/collections/${encodeURIComponent(config.collection)}`
}

/**
 * The error for a 404 on a points operation: the collection was never created, or was dropped.
 *
 * Called by: upsert, search (this file)
 * @returns an Error that names the collection, the server and the fix
 */
function missingCollection(): Error {
  // The fix is always the same: run the ingest.
  return new Error(
    `Collection "${config.collection}" does not exist at ${config.qdrantUrl}; ` +
      'run "npm run ingest"',
  )
}

/**
 * The short reason of a rejected fetch. fetch rejects with "fetch failed" and the socket error
 * as its cause; the code there (ECONNREFUSED, for one) says more than the message.
 *
 * Called by: request (this file)
 * @param error whatever fetch rejected with
 * @returns the socket error code when there is one, else the error's message
 */
function describe(error: unknown): string {
  // The cause, when the rejection is an Error: a socket error with a code, or a list of them
  // when several addresses were tried.
  let cause =
    error instanceof Error
      ? (error.cause as { code?: string; errors?: { code?: string }[] } | undefined)
      : undefined
  // The code from the cause itself or from its first inner error.
  let code = cause?.code ?? cause?.errors?.[0]?.code
  // The code says it best.
  if (code) return code
  // No code: the message, or the value as text when it is not an Error.
  return error instanceof Error ? error.message : String(error)
}
