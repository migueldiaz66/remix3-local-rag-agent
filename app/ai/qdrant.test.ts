// qdrant.test.ts: the Qdrant REST client against a fake fetch, with no network and no Qdrant.
//
// Objective
//   Prove that each function of qdrant.ts sends the request Qdrant's REST API expects, reads its
//   answer into the shapes the rest of the app uses, and turns a missing collection, a Qdrant
//   error and a refused connection into messages that tell the user what to do (run the ingest,
//   start Qdrant). pointId is checked on its own: Qdrant only accepts integers and UUIDs as point
//   ids, so chunk ids must be mapped to UUIDs deterministically.
//
// Dependencies
//   remix/assert: equal, notEqual, deepEqual, match and rejects, the assertions.
//   remix/test: describe and it; the it callback receives t, whose after hook restores fetch.
//   ./config.ts: config.qdrantUrl and config.collection, to build the expected URLs.
//   ./qdrant.ts: count, deleteCollection, ensureCollection, pointId, search and upsert, under test.
//   ./types.ts: Chunk, the payload stored with every point.
//   No external service: Qdrant's answers are built here as JSON Responses.
//
// Consumers
//   `npm test` (package.json) runs it; nothing imports it.
//   app/ai/qdrant.ts is the module it covers: a change to a URL, a body or an error message must
//   keep these cases green. scripts/ingest.ts and app/ai/rag.ts rely on the same behavior.
//
// How it relates to them
//   The URLs and bodies pinned here are the REST API of the Qdrant on port 6335: GET and PUT on
//   the collection, PUT points?wait=true, POST points/search, POST points/count. The error texts
//   pinned here are what the chat panel and the ingest script show the user.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { config } from './config.ts'
import { count, deleteCollection, ensureCollection, pointId, search, upsert } from './qdrant.ts'
import type { Chunk } from './types.ts'

/**
 * One recorded fetch call, reduced to what the assertions compare: method, URL and parsed body.
 *
 * Called by: this file: fakeFetch and every handler it is given
 */
interface Call {
  // The HTTP method, GET when the client gave none.
  method: string
  // The full URL as a string, whatever form fetch received.
  url: string
  // The parsed JSON body, or undefined when the request had none.
  body: unknown
}

/**
 * Replaces globalThis.fetch for one test: every call is recorded and answered by the handler,
 * and the original fetch is restored when the test ends, so cases cannot leak into each other.
 *
 * Called by: this file: every case except those of qdrant.pointId
 * @param t the test context, for its after hook; only that method is required
 * @param handler answers each call with a Response, or throws to simulate a network failure
 * @returns the live list of calls, filled as the code under test makes them
 */
function fakeFetch(
  t: { after(fn: () => void): void },
  handler: (call: Call) => Response | Promise<Response>,
): Call[] {
  // The calls, in order; the caller keeps the reference and reads it after the call under test.
  let calls: Call[] = []
  // Kept to restore after the test.
  let original = globalThis.fetch
  // The replacement normalizes the input to a URL string and parses a JSON body, then delegates.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // fetch accepts a string, a URL or a Request; the assertions want one string.
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    // The client sends JSON strings; a GET or DELETE has no body.
    let body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    // A GET is the default method when none is given.
    let call = { method: init?.method ?? 'GET', url, body }
    // Record before answering, so a throwing handler still leaves the call on record.
    calls.push(call)
    // The case decides the answer.
    return handler(call)
  // The fake is narrower than fetch's overloads; the cast makes the assignment type-check.
  }) as typeof fetch
  // Restore the real fetch when the test ends, whether it passed or failed.
  t.after(() => {
    // Put the original back.
    globalThis.fetch = original
  })
  // Hand the recording to the case.
  return calls
}

/**
 * Builds a JSON Response as Qdrant sends it, with the given status.
 *
 * Called by: this file: notFound and the handlers of most cases
 * @param status the HTTP status
 * @param data the body, serialized as JSON
 * @returns the Response
 */
function json(status: number, data: unknown): Response {
  // Qdrant answers JSON with an explicit content type; the status carries the outcome.
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Qdrant's answer for a collection that does not exist: a 404 with its own error shape.
 *
 * Called by: this file: the cases that start without a collection
 */
const notFound = () =>
  json(404, { status: { error: 'Not found: Collection does not exist' }, time: 0 })

/**
 * The error Node's fetch throws when nothing listens on the port: a TypeError whose cause
 * carries ECONNREFUSED. The client must recognize it and say Qdrant is not running.
 *
 * Called by: this file: the two "Qdrant is not running" cases
 */
const refused = () =>
  Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })

/**
 * The URL of the configured collection, the base of every endpoint the client calls. The name
 * is URL-encoded, as the client must do it.
 *
 * Called by: this file: the URL assertions of every group but qdrant.pointId
 */
const base = `${config.qdrantUrl}/collections/${encodeURIComponent(config.collection)}`

/**
 * One chunk of the article, with the id, chapter, heading, lines and text the ingest
 * stores as the payload of a point.
 *
 * Called by: this file: the upsert and search cases
 */
const chunk: Chunk = {
  id: 'improvements-3',
  chapter: 'Improvements',
  heading: 'Chunking',
  lines: [69, 71],
  text: 'Chunking involves various strategies for breaking up the data into vectors',
}

// The mapping from chunk ids to the point ids Qdrant accepts.
describe('qdrant.pointId', () => {
  // Proves that a chunk id becomes a version 5 UUID, the same one on every call, and a different
  // one for a different id. Covers: app/ai/qdrant.ts: pointId.
  it('turns a chunk id into the same UUID every time', () => {
    // The mapped id of one chunk.
    let id = pointId('improvements-3')
    // A UUID, not an integer.
    assert.equal(typeof id, 'string')
    // In the canonical form of a name-based (version 5) UUID, lowercase.
    assert.match(
      id as string,
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    // Deterministic: re-ingesting the same chunk overwrites its point instead of adding one.
    assert.equal(pointId('improvements-3'), id)
    // Distinct chunks get distinct points.
    assert.notEqual(pointId('improvements-4'), id)
  })

  // Proves that an id Qdrant already accepts is not hashed: integers stay, UUIDs are only
  // lowercased. Covers: app/ai/qdrant.ts: pointId.
  it('passes integers and UUIDs through', () => {
    // An integer is a valid point id as is.
    assert.equal(pointId(42), 42)
    // A UUID is kept, normalized to lowercase.
    assert.equal(
      pointId('6BA7B811-9DAD-11D1-80B4-00C04FD430C8'),
      '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
    )
  })
})

// Creating the collection, or checking that the existing one fits the embedding size.
describe('qdrant.ensureCollection', () => {
  // Proves that a missing collection is created with the given vector size and cosine distance.
  // Covers: app/ai/qdrant.ts: ensureCollection.
  it('creates the collection with cosine distance when it is missing', async (t) => {
    // The GET says the collection does not exist; the PUT that follows succeeds.
    let calls = fakeFetch(t, (call) =>
      call.method === 'GET' ? notFound() : json(200, { result: true }),
    )

    // Ensure a collection for 768-dimensional vectors, the size of nomic-embed-text.
    await ensureCollection(768)

    // First a look, then the creation, both on the collection URL.
    assert.deepEqual(
      calls.map((c) => [c.method, c.url]),
      [
        ['GET', base],
        ['PUT', base],
      ],
    )
    // Cosine distance suits normalized text embeddings; the size must match the embedding model.
    assert.deepEqual(calls[1]!.body, { vectors: { size: 768, distance: 'Cosine' } })
  })

  // Proves that an existing collection of the right size is kept, with no write at all.
  // Covers: app/ai/qdrant.ts: ensureCollection.
  it('leaves an existing collection of the same size alone', async (t) => {
    // The GET describes a collection whose vectors already have the requested size.
    let calls = fakeFetch(t, () =>
      json(200, { result: { config: { params: { vectors: { size: 768 } } } } }),
    )

    // Ensure with the same size.
    await ensureCollection(768)

    // Only the look; nothing was created or deleted.
    assert.equal(calls.length, 1)
    // And it was a read.
    assert.equal(calls[0]!.method, 'GET')
  })

  // Proves that a collection built for another embedding size is refused with a message that
  // names both sizes and the fix, so stale vectors are never mixed with new ones.
  // Covers: app/ai/qdrant.ts: ensureCollection.
  it('refuses an existing collection of another size', async (t) => {
    // The GET describes a collection of 384 dimensions, from another embedding model.
    fakeFetch(t, () => json(200, { result: { config: { params: { vectors: { size: 384 } } } } }))

    // The message gives the existing size, the requested one, and tells the user to re-ingest.
    await assert.rejects(ensureCollection(768), /384 dimensions.*768.*npm run ingest/)
  })

  // Proves that a refused connection is reported as "Qdrant is not running at <url>" rather than
  // as "fetch failed". Covers: app/ai/qdrant.ts: ensureCollection.
  it('says plainly when Qdrant is not running', async (t) => {
    // Every call fails as it does when the container is down.
    fakeFetch(t, () => {
      // The ECONNREFUSED error.
      throw refused()
    })

    // The message names the service and the URL the user should check.
    await assert.rejects(
      ensureCollection(768),
      new RegExp(`Qdrant is not running at ${config.qdrantUrl}`),
    )
  })
})

// Dropping the collection before a fresh ingest.
describe('qdrant.deleteCollection', () => {
  // Proves that the collection is deleted with one DELETE and that a 404 is not an error: a
  // fresh ingest has nothing to drop. Covers: app/ai/qdrant.ts: deleteCollection.
  it('deletes, and accepts that the collection was not there', async (t) => {
    // Qdrant says there was no collection.
    let calls = fakeFetch(t, () => notFound())

    // Must resolve, not reject.
    await deleteCollection()

    // One DELETE on the collection URL.
    assert.deepEqual(
      calls.map((c) => [c.method, c.url]),
      [['DELETE', base]],
    )
  })
})

// Writing points, as the ingest does.
describe('qdrant.upsert', () => {
  // Proves that points are written in one PUT that waits for indexing, with the chunk id mapped
  // to a UUID and kept whole in the payload. Covers: app/ai/qdrant.ts: upsert.
  it('sends UUID point ids, keeps the chunk id in the payload, and waits', async (t) => {
    // Qdrant acknowledges the write.
    let calls = fakeFetch(t, () => json(200, { result: { status: 'completed' } }))

    // One point: the chunk's id, a short vector, the chunk as payload.
    await upsert([{ id: chunk.id, vector: [0.1, 0.2], payload: chunk }])

    // A single request for the batch.
    assert.equal(calls.length, 1)
    // Qdrant upserts with PUT.
    assert.equal(calls[0]!.method, 'PUT')
    // wait=true makes the call return only once the points are searchable, so the ingest's
    // final count is right.
    assert.equal(calls[0]!.url, `${base}/points?wait=true`)
    // The body's points, typed for the assertions below.
    let { points } = calls[0]!.body as {
      points: { id: unknown; vector: number[]; payload: Chunk }[]
    }
    // One point in, one point out.
    assert.equal(points.length, 1)
    // The point id is the UUID of the chunk id, as Qdrant requires.
    assert.equal(points[0]!.id, pointId(chunk.id))
    // The vector passes through.
    assert.deepEqual(points[0]!.vector, [0.1, 0.2])
    // The payload is the whole chunk, chunk id included, so search can cite it.
    assert.deepEqual(points[0]!.payload, chunk)
  })

  // Proves that an empty batch makes no request, so an empty ingest does not fail on Qdrant.
  // Covers: app/ai/qdrant.ts: upsert.
  it('sends nothing for no points', async (t) => {
    // A handler that would succeed, but must not be reached.
    let calls = fakeFetch(t, () => json(200, {}))
    // Nothing to write.
    await upsert([])
    // No request was made.
    assert.equal(calls.length, 0)
  })

  // Proves that a Qdrant error is reported with its status and its own message, so a vector of
  // the wrong size is diagnosed from the error. Covers: app/ai/qdrant.ts: upsert.
  it('reports a Qdrant error with its message', async (t) => {
    // Qdrant refuses a vector whose size does not match the collection.
    fakeFetch(t, () => json(400, { status: { error: 'Wrong input: vector size 2, expected 768' } }))

    // The message carries the status and Qdrant's text.
    await assert.rejects(
      upsert([{ id: chunk.id, vector: [0.1, 0.2], payload: chunk }]),
      /400.*vector size 2, expected 768/,
    )
  })
})

// The similarity search the RAG and the agent use.
describe('qdrant.search', () => {
  // Proves that the search asks for the payload and returns Sources ordered by score, best
  // first, whatever order Qdrant used. Covers: app/ai/qdrant.ts: search.
  it('asks for the payload and returns sources best first', async (t) => {
    // A second chunk, from another chapter, to check the ordering.
    let other: Chunk = {
      ...chunk,
      id: 'process-1',
      chapter: 'Process',
      heading: 'RAG key stages',
      lines: [21, 25],
      text: 'a document retriever is first called',
    }
    // Qdrant answers two hits, the weaker one first on purpose.
    let calls = fakeFetch(t, () =>
      json(200, {
        result: [
          { id: 'b', version: 1, score: 0.41, payload: other },
          { id: 'a', version: 1, score: 0.83, payload: chunk },
        ],
      }),
    )

    // Search with a query vector and a limit of three.
    let sources = await search([0.1, 0.2], 3)

    // Qdrant searches with POST.
    assert.equal(calls[0]!.method, 'POST')
    // On the points/search endpoint of the collection.
    assert.equal(calls[0]!.url, `${base}/points/search`)
    // The vector, the limit, and with_payload so the chunks come back with the scores.
    assert.deepEqual(calls[0]!.body, { vector: [0.1, 0.2], limit: 3, with_payload: true })
    // Each Source is its chunk plus the score, sorted best first.
    assert.deepEqual(sources, [
      { ...chunk, score: 0.83 },
      { ...other, score: 0.41 },
    ])
  })

  // Proves that searching before any ingest fails with the instruction to run it, instead of
  // a bare 404. Covers: app/ai/qdrant.ts: search.
  it('tells the user to ingest when the collection does not exist', async (t) => {
    // No collection yet.
    fakeFetch(t, () => notFound())

    // The message explains the cause and the command.
    await assert.rejects(search([0.1, 0.2], 3), /does not exist.*npm run ingest/)
  })

  // Proves that a refused connection on search is reported as Qdrant not running, with the
  // code kept for diagnosis. Covers: app/ai/qdrant.ts: search.
  it('says plainly when Qdrant is not running', async (t) => {
    // Every call fails as it does when the container is down.
    fakeFetch(t, () => {
      // The ECONNREFUSED error.
      throw refused()
    })

    // The message names the service, the URL and the code.
    await assert.rejects(search([0.1, 0.2], 3), /Qdrant is not running at .*ECONNREFUSED/)
  })
})

// The point count the ingest prints and the agent's get_flow reports.
describe('qdrant.count', () => {
  // Proves that the count is requested exactly, not estimated, and returned as a number.
  // Covers: app/ai/qdrant.ts: count.
  it('returns the exact count', async (t) => {
    // Qdrant answers a count.
    let calls = fakeFetch(t, () => json(200, { result: { count: 289 } }))

    // The number comes back unwrapped.
    assert.equal(await count(), 289)
    // From the points/count endpoint.
    assert.equal(calls[0]!.url, `${base}/points/count`)
    // Exact, because the ingest compares it with the number of chunks it wrote.
    assert.deepEqual(calls[0]!.body, { exact: true })
  })

  // Proves that a missing collection counts as zero points rather than an error, so a status
  // check before the first ingest works. Covers: app/ai/qdrant.ts: count.
  it('returns 0 when the collection does not exist', async (t) => {
    // No collection yet.
    fakeFetch(t, () => notFound())

    // Zero, not a rejection.
    assert.equal(await count(), 0)
  })
})
