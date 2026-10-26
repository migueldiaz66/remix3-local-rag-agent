// rag.test.ts: the retrieval path, ollama.embed and rag.ts, against a fake fetch.
//
// Objective
//   Prove that embed posts the texts to Ollama's /api/embed and returns one vector per text with
//   readable errors; that retrieve embeds the question (with the query prefix) and searches
//   Qdrant with the vector, best hit first, with config.ragLimit passages by default; that
//   documentInput and queryInput prefix the text as the embedding model expects; and that
//   buildRagMessages confines the LLM to the numbered passages, asks for the section of each
//   passage used, and stays short; and that cite names a passage's chapter, its sub-heading
//   when it has one, and its lines. No network: both services are answered by a fake fetch.
//
// Dependencies
//   remix/assert: equal, deepEqual, ok, match and rejects, the assertions.
//   remix/test: describe and it; the it callback receives t, whose after hook restores fetch.
//   ./config.ts: config, for the Ollama and Qdrant URLs, the embed model and ragLimit.
//   ./ollama.ts: embed, under test here rather than in ollama.test.ts.
//   ./rag.ts: RAG_SYSTEM_PROMPT, buildRagMessages, cite, documentInput, queryInput and
//     retrieve.
//   ./types.ts: Chunk and Source, the shapes of the passages before and after scoring.
//   No external service: Ollama's and Qdrant's answers are built here as JSON Responses.
//
// Consumers
//   `npm test` (package.json) runs it; nothing imports it.
//   app/ai/rag.ts and the embed function of app/ai/ollama.ts are the modules it covers: a change
//   to a prompt, a prefix, a URL or an error message must keep these cases green.
//
// How it relates to them
//   handleChat (app/ai/chat.ts) and the agent (app/ai/agent.ts) rely on retrieve returning
//   Sources best first and on buildRagMessages producing a system turn and a user turn. The
//   ingest (scripts/ingest.ts) relies on documentInput matching queryInput's convention, or the
//   vectors would not compare.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { config } from './config.ts'
import { embed } from './ollama.ts'
import {
  RAG_SYSTEM_PROMPT,
  buildRagMessages,
  cite,
  documentInput,
  queryInput,
  retrieve,
} from './rag.ts'
import type { Chunk, Source } from './types.ts'

/**
 * One recorded fetch call, reduced to what the assertions compare: method, URL and parsed body.
 *
 * Called by: this file: fakeFetch, services and the handlers of every case
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
 * Called by: this file: every case of ollama.embed and rag.retrieve
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
    // The clients send JSON strings; a GET has no body.
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
 * Builds a JSON Response as the services send it, with the given status.
 *
 * Called by: this file: services and the handlers of most cases
 * @param status the HTTP status
 * @param data the body, serialized as JSON
 * @returns the Response
 */
function json(status: number, data: unknown): Response {
  // JSON with an explicit content type; the status carries the outcome.
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * The error Node's fetch throws when nothing listens on the port: a TypeError whose cause
 * carries ECONNREFUSED. The clients must recognize it and name the service that is down.
 *
 * Called by: this file: the "not running" cases of ollama.embed and rag.retrieve
 */
const refused = () =>
  Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })

/**
 * A chunk of the "Chunking" sub-section of the chapter "Improvements", the passage the cases
 * expect to rank first for a question about chunking.
 *
 * Called by: this file: the rag.retrieve, rag.documentInput, rag.buildRagMessages and rag.cite
 *   cases
 */
const chunking: Chunk = {
  id: 'improvements-3',
  chapter: 'Improvements',
  heading: 'Chunking',
  lines: [69, 71],
  text:
    '### Chunking\n\nChunking involves various strategies for breaking up the data into vectors ' +
    'so the retriever can find details in it.',
}

/**
 * A chunk of the chapter "Process", under its sub-heading "RAG key stages", a weaker match, so
 * ordering and numbering can be checked.
 *
 * Called by: this file: the rag.retrieve and rag.buildRagMessages cases
 */
const stages: Chunk = {
  id: 'process-1',
  chapter: 'Process',
  heading: 'RAG key stages',
  lines: [21, 25],
  text:
    'Given a user query, a document retriever is first called to select the most relevant ' +
    'documents that will be used to augment the query.',
}

/**
 * A chunk directly under the heading of its chapter, with no sub-heading, so cite's short form
 * can be checked.
 *
 * Called by: this file: the rag.cite cases
 */
const applications: Chunk = {
  id: 'applications-1',
  chapter: 'Applications',
  heading: 'Applications',
  lines: [33, 35],
  text:
    'Retrieval-augmented generation is used in applications where generated responses need to ' +
    'be grounded in external or frequently updated information.',
}

/**
 * A handler that answers Ollama's embed with one fixed vector and Qdrant's search with the
 * given hits; anything else is a test error, so an unexpected request is caught, not ignored.
 *
 * Called by: this file: the first three cases of rag.retrieve
 * @param hits Qdrant's result list, in the order Qdrant would send it
 * @returns a fakeFetch handler
 */
function services(hits: { score: number; payload: Chunk }[]) {
  // The handler routes on the URL.
  return (call: Call) => {
    // The embedding of the question: one three-dimensional vector.
    if (call.url === `${config.ollamaUrl}/api/embed`) {
      // The vector, in the shape Ollama's embed endpoint answers.
      return json(200, { embeddings: [[0.1, 0.2, 0.3]] })
    }
    // The search answer.
    if (call.url.endsWith('/points/search')) return json(200, { result: hits })
    // Any other request means retrieve called something it should not.
    throw new Error(`unexpected request ${call.method} ${call.url}`)
  }
}

// The embedding call, the first half of every retrieval and of the ingest.
describe('ollama.embed', () => {
  // Proves that the texts are posted in one request with the configured model and that the
  // vectors come back in order. Covers: app/ai/ollama.ts: embed.
  it('posts the texts to /api/embed and returns one vector per text', async (t) => {
    // Ollama answers two vectors for two texts.
    let calls = fakeFetch(t, () => json(200, { embeddings: [[0.1, 0.2], [0.3, 0.4]] }))

    // Embed two texts.
    let vectors = await embed(['one', 'two'])

    // One vector per text, in the same order.
    assert.deepEqual(vectors, [
      [0.1, 0.2],
      [0.3, 0.4],
    ])
    // A single batched request, not one per text.
    assert.equal(calls.length, 1)
    // As a POST.
    assert.equal(calls[0]!.method, 'POST')
    // To the embed endpoint of the configured Ollama.
    assert.equal(calls[0]!.url, `${config.ollamaUrl}/api/embed`)
    // With the embedding model and the texts as the input array.
    assert.deepEqual(calls[0]!.body, { model: config.embedModel, input: ['one', 'two'] })
  })

  // Proves that an empty input short-circuits: no request, an empty result.
  // Covers: app/ai/ollama.ts: embed.
  it('returns nothing for no texts without calling Ollama', async (t) => {
    // A handler that must not be reached.
    let calls = fakeFetch(t, () => json(200, { embeddings: [] }))
    // Nothing to embed gives nothing back.
    assert.deepEqual(await embed([]), [])
    // And Ollama was not asked.
    assert.equal(calls.length, 0)
  })

  // Proves that a refused connection is reported as "Ollama is not running at <url>".
  // Covers: app/ai/ollama.ts: embed.
  it('says plainly when Ollama is not running', async (t) => {
    // Every call fails as it does when Ollama is down.
    fakeFetch(t, () => {
      // The ECONNREFUSED error.
      throw refused()
    })

    // The message names the service and the URL to check.
    await assert.rejects(embed(['one']), new RegExp(`Ollama is not running at ${config.ollamaUrl}`))
  })

  // Proves that a missing embedding model is reported with the pull command, so the fix is in
  // the message. Covers: app/ai/ollama.ts: embed.
  it('tells the user to pull the embedding model when it is missing', async (t) => {
    // Ollama's 404 for a model that was never pulled.
    fakeFetch(t, () =>
      json(404, { error: `model "${config.embedModel}" not found, try pulling it first` }),
    )

    // The message keeps Ollama's text and adds the exact command.
    await assert.rejects(embed(['one']), new RegExp(`not found.*ollama pull ${config.embedModel}`))
  })

  // Proves that a mismatch between texts and vectors is an error, never a silent misalignment
  // of chunks and vectors in the ingest. Covers: app/ai/ollama.ts: embed.
  it('refuses an answer with the wrong number of vectors', async (t) => {
    // One vector for two texts.
    fakeFetch(t, () => json(200, { embeddings: [[0.1, 0.2]] }))

    // The message states both counts.
    await assert.rejects(embed(['one', 'two']), /1 embeddings for 2 texts/)
  })
})

// The retrieval: embed the question, search Qdrant, return Sources.
describe('rag.retrieve', () => {
  // Proves the two-step sequence, the prefixed query, the search body and the ordering by
  // score. Covers: app/ai/rag.ts: retrieve, queryInput.
  it('embeds the question and searches with it, best first', async (t) => {
    // Both services answer; Qdrant sends the weaker hit first on purpose.
    let calls = fakeFetch(
      t,
      services([
        { score: 0.52, payload: stages },
        { score: 0.81, payload: chunking },
      ]),
    )

    // Retrieve two passages for a question.
    let sources = await retrieve('What is chunking?', 2)

    // First the embedding, then the search, nothing else.
    assert.deepEqual(
      calls.map((c) => [c.method, c.url]),
      [
        ['POST', `${config.ollamaUrl}/api/embed`],
        [
          'POST',
          `${config.qdrantUrl}/collections/${encodeURIComponent(config.collection)}/points/search`,
        ],
      ],
    )
    // The embed request, typed for the assertions below.
    let embedBody = calls[0]!.body as { model: string; input: string[] }
    // With the configured embedding model.
    assert.equal(embedBody.model, config.embedModel)
    // The question is embedded through queryInput, which adds the embedding model's prefix.
    assert.deepEqual(embedBody.input, [queryInput('What is chunking?')])
    // The prefix goes before the question, which stays whole at the end.
    assert.ok(embedBody.input[0]!.endsWith('What is chunking?'))
    // The search uses the vector Ollama returned, the requested limit, and asks for payloads.
    assert.deepEqual(calls[1]!.body, { vector: [0.1, 0.2, 0.3], limit: 2, with_payload: true })
    // Sources are chunks plus scores, best first, whatever order Qdrant used.
    assert.deepEqual(sources, [
      { ...chunking, score: 0.81 },
      { ...stages, score: 0.52 },
    ])
  })

  // Proves that the limit comes from the configuration when the caller gives none.
  // Covers: app/ai/rag.ts: retrieve.
  it('asks for config.ragLimit passages by default', async (t) => {
    // Both services answer; the search finds nothing.
    let calls = fakeFetch(t, services([]))

    // No limit given.
    let sources = await retrieve('What is chunking?')

    // No hits, no sources.
    assert.deepEqual(sources, [])
    // The search asked for the configured number of passages.
    assert.equal((calls[1]!.body as { limit: number }).limit, config.ragLimit)
  })

  // Proves that a failure in the embedding step surfaces as Ollama's message, so the user
  // learns which service is down. Covers: app/ai/rag.ts: retrieve.
  it('fails with the Ollama message when the embedding is not available', async (t) => {
    // Every call fails as it does when Ollama is down.
    fakeFetch(t, () => {
      // The ECONNREFUSED error.
      throw refused()
    })

    // The message is the embed client's, not a generic one.
    await assert.rejects(retrieve('What is chunking?'), /Ollama is not running at/)
  })
})

// The texts handed to the embedding model, for a passage and for a question.
describe('rag.documentInput', () => {
  // Proves that a passage is embedded with its chapter in front and that a query keeps the
  // question at the end, both after their prefixes. Covers: app/ai/rag.ts: documentInput,
  // queryInput.
  it('puts the chapter before the text', () => {
    // The embedding input of one chunk.
    let input = documentInput(chunking)
    // The chapter title precedes the text, so the vector carries where the passage is from.
    assert.ok(input.endsWith(`Improvements\n${chunking.text}`), input)
    // The query form ends with the question itself.
    assert.ok(queryInput('q').endsWith('q'))
  })
})

// The prompt the RAG mode sends to the LLM: a system turn and a user turn with the passages.
describe('rag.buildRagMessages', () => {
  /**
   * The two chunks as retrieve would return them, scored and best first.
   *
   * Called by: this file: three of the rag.buildRagMessages cases
   */
  const sources: Source[] = [
    { ...chunking, score: 0.81 },
    { ...stages, score: 0.52 },
  ]

  // Proves that the system turn is RAG_SYSTEM_PROMPT and that the prompt confines the answer to
  // the passages, asks for the section of each passage used, allows "not covered", and asks for
  // brevity.
  // Covers: app/ai/rag.ts: buildRagMessages, RAG_SYSTEM_PROMPT.
  it('confines the answer to the passages and asks for section citations', () => {
    // The first message is the system turn.
    let [system] = buildRagMessages('What is chunking?', sources)

    // Its role.
    assert.equal(system!.role, 'system')
    // It is the exported prompt, so the agent and other tests can refer to the same text.
    assert.equal(system!.content, RAG_SYSTEM_PROMPT)
    // The LLM must not answer from its own knowledge.
    assert.match(system!.content, /only from those passages/)
    // The citation: the section in parentheses, taken from the passage's label.
    assert.match(system!.content, /in parentheses by the section in its label/)
    // No example name from the article: a small LLM would copy it instead of the real label.
    assert.ok(!/Improvements|Process|Chunking|Applications/.test(system!.content))
    // The article's subject is named, so the LLM knows what the passages are.
    assert.match(system!.content, /retrieval-augmented generation/)
    // The LLM may say the passages do not cover the question.
    assert.match(system!.content, /do not cover it/)
    // Short answers, since the small model is slow on this CPU.
    assert.match(system!.content, /brief/)
  })

  // Proves the user turn's layout: numbered passages with section and lines, in order, and the
  // question last. Covers: app/ai/rag.ts: buildRagMessages.
  it('numbers the passages with their section and lines, then asks the question', () => {
    // Both turns.
    let messages = buildRagMessages('What is chunking?', sources)

    // A system turn and a user turn, nothing else.
    assert.equal(messages.length, 2)
    // The user turn carries the passages and the question.
    let user = messages[1]!
    // Its role.
    assert.equal(user.role, 'user')
    // Passage one: number, chapter, sub-heading, line range, then the text on the next line.
    const first = `[1] Improvements, Chunking, lines 69-71:\n${chunking.text}`
    // It is in the turn as written.
    assert.ok(user.content.includes(first), user.content)
    // Passage two, in the same layout, with its own sub-heading.
    const second = `[2] Process, RAG key stages, lines 21-25:\n${stages.text}`
    // It is in the turn as written.
    assert.ok(user.content.includes(second), user.content)
    // The order of the sources is kept, so [1] is the best match.
    assert.ok(user.content.indexOf('[1]') < user.content.indexOf('[2]'))
    // The question closes the turn, where the LLM attends to it last.
    assert.ok(user.content.endsWith('Question: What is chunking?'), user.content)
  })

  // Proves that an empty retrieval is stated in the prompt instead of leaving a blank, so the
  // LLM says the passages do not cover it. Covers: app/ai/rag.ts: buildRagMessages.
  it('says so when there are no passages', () => {
    // Only the user turn matters here.
    let [, user] = buildRagMessages('What is chunking?', [])

    // The explicit statement.
    assert.match(user!.content, /No passages were found\./)
    // The question still closes the turn.
    assert.ok(user!.content.endsWith('Question: What is chunking?'))
  })

  // Proves that the fixed text around the passages stays under 800 characters: prompt
  // processing is the slow part on this CPU. Covers: app/ai/rag.ts: buildRagMessages.
  it('keeps the prompt short', () => {
    // Both turns.
    let messages = buildRagMessages('What is chunking?', sources)
    // The length of everything the model receives.
    let total = messages.map((m) => m.content).join('').length
    // The passages' own text, which is not fixed.
    let passages = sources.reduce((n, s) => n + s.text.length, 0)
    // What is left is the prompt, the numbering, the labels and the question.
    let fixed = total - passages
    // The budget, with the measured size in the failure message.
    assert.ok(fixed < 800, `${fixed} characters besides the passages`)
  })
})

// The label of a passage, as the prompt, the agent's search tool and the panel name it.
describe('rag.cite', () => {
  // Proves that a passage directly under its chapter heading is named by the chapter and its
  // lines alone. Covers: app/ai/rag.ts: cite.
  it('names the chapter and the lines when there is no sub-heading', () => {
    // The chapter, a comma, and the inclusive range.
    assert.equal(cite(applications), 'Applications, lines 33-35')
  })

  // Proves that a sub-heading different from the chapter is added between the chapter and the
  // lines. Covers: app/ai/rag.ts: cite.
  it('adds the sub-heading when it differs from the chapter', () => {
    // Chapter, sub-heading, then the lines.
    assert.equal(cite(chunking), 'Improvements, Chunking, lines 69-71')
    // The same shape for a passage of another chapter.
    assert.equal(cite(stages), 'Process, RAG key stages, lines 21-25')
  })
})
