// ollama.test.ts: ollama.chat against a fake fetch, with no network and no Ollama.
//
// Objective
//   Prove that chat posts the request Ollama's /api/chat expects (model, stream, messages, tools,
//   options), yields one ChatChunk per NDJSON line even when a line is cut across two reads,
//   omits tools when there are none, forwards the abort signal and surfaces the abort, and turns
//   a refused connection, an HTTP error and an error line in the stream into readable errors.
//   Every case replaces globalThis.fetch with the test runner's mock, restored after the case.
//
// Dependencies
//   remix/assert: equal, deepEqual and rejects, the assertions.
//   remix/test: describe and it; the it callback receives t, whose mock.method replaces fetch.
//   ./config.ts: config, for the URL, model and options the request must carry.
//   ./ollama.ts: chat, the generator under test, and ChatChunk, the type it yields.
//   ./types.ts: ChatMessage and ToolDefinition, the shapes of the request's inputs.
//   No external service: Ollama's answers are built here as NDJSON text.
//
// Consumers
//   `npm test` (package.json) runs it; nothing imports it.
//   app/ai/ollama.ts is the module it covers: a change to the request or to the error messages
//   must keep these cases green. embed is covered in app/ai/rag.test.ts.
//
// How it relates to them
//   The request body pinned here is what a real Ollama on port 11434 accepts; the error texts
//   pinned here are what the chat panel shows the user. The agent (app/ai/agent.ts) relies on
//   the chunk shape: content for text, toolCalls for a tool request, done at the end.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { config } from './config.ts'
import { chat, type ChatChunk } from './ollama.ts'
import type { ChatMessage, ToolDefinition } from './types.ts'

/**
 * The conversation every case sends: a system instruction and one user turn, enough to check
 * that messages pass through unchanged.
 *
 * Called by: this file: every case of ollama.chat
 */
const messages: ChatMessage[] = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'Hello' },
]

/**
 * One tool definition in Ollama's function-calling format, so a case can check that tools are
 * forwarded as given and that a tool call in the answer is parsed.
 *
 * Called by: this file: the first case of ollama.chat
 */
const searchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_docs',
    description: 'Searches the article',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for' } },
      required: ['query'],
    },
  },
}

/**
 * A Response whose body arrives in the given pieces, one per read, as Ollama's does: the reader
 * under test must buffer across reads, so the pieces may cut a line in the middle.
 *
 * Called by: this file: the fetch mocks of three cases
 * @param pieces the body's text in the order the reads deliver it
 * @param init overrides for the status or headers; the default is a 200 with the NDJSON type
 * @returns a Response with a ReadableStream body that yields to the event loop between pieces
 */
function streamed(pieces: string[], init: ResponseInit = {}): Response {
  // Bytes, not strings: a real body is a byte stream.
  let encoder = new TextEncoder()
  // The body enqueues one piece per turn of the event loop, so each piece is a separate read.
  let body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Each piece becomes one chunk of the stream.
      for (let piece of pieces) {
        // Enqueue the encoded piece.
        controller.enqueue(encoder.encode(piece))
        // Yield once, so the consumer sees this piece before the next is enqueued.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      // Ollama closes the connection after the done line; so does the fake.
      controller.close()
    },
  })
  // Ollama streams with the NDJSON content type; a case may override status or headers.
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
    ...init,
  })
}

/**
 * Serializes objects as Ollama does: one JSON object per line, every line ending in a newline.
 *
 * Called by: this file: the fetch mocks of five cases
 * @param lines the objects, in the order they are streamed
 * @returns the NDJSON text with its trailing newline
 */
function ndjson(lines: object[]): string {
  // One JSON per line, joined and terminated with a newline, as the wire format requires.
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}

/**
 * Drains the chat generator into an array, so a case can assert on all chunks at once.
 *
 * Called by: this file: four cases of ollama.chat
 * @param generator the generator chat returned
 * @returns every chunk it yielded, in order; rejects with the generator's error if it throws
 */
async function collect(generator: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  // The chunks in order.
  let chunks: ChatChunk[] = []
  // Pull until the generator finishes.
  for await (let chunk of generator) chunks.push(chunk)
  // Hand them back.
  return chunks
}

// The streaming chat call, from the request it builds to the errors it reports.
describe('ollama.chat', () => {
  // Proves that the request carries what Ollama needs and that each NDJSON line becomes one
  // chunk, even when a line is split across two reads. Covers: app/ai/ollama.ts: chat.
  it('posts the request Ollama expects and yields one chunk per line', async (t) => {
    // Every fetch call, with its URL and init, for the request assertions.
    let calls: { url: string; init: RequestInit }[] = []
    // Ollama's answer: two text pieces, a tool call, then the done line.
    let text = ndjson([
      { model: 'm', message: { role: 'assistant', content: 'Hel' }, done: false },
      { model: 'm', message: { role: 'assistant', content: 'lo' }, done: false },
      {
        model: 'm',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'search_docs', arguments: { query: 'chunking' } } }],
        },
        done: false,
      },
      { model: 'm', message: { role: 'assistant', content: '' }, done_reason: 'stop', done: true },
    ])
    // Split in the middle of a line, so the reader has to buffer across reads.
    let cut = text.indexOf('lo') + 1
    // The fake fetch records the call and streams the answer in two reads.
    t.mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
      // Record what chat sent.
      calls.push({ url: String(url), init })
      // Answer with the two halves.
      return streamed([text.slice(0, cut), text.slice(cut)])
    })

    // Run the call under test with one tool.
    let chunks = await collect(chat(messages, { tools: [searchTool] }))

    // One request for the whole stream.
    assert.equal(calls.length, 1)
    // To the chat endpoint of the configured Ollama.
    assert.equal(calls[0].url, `${config.ollamaUrl}/api/chat`)
    // As a POST.
    assert.equal(calls[0].init.method, 'POST')
    // The body is JSON; the assertions below read its fields.
    let body = JSON.parse(String(calls[0].init.body))
    // The configured chat model.
    assert.equal(body.model, config.chatModel)
    // Streaming on, so tokens arrive as they are generated.
    assert.equal(body.stream, true)
    // The messages pass through unchanged.
    assert.deepEqual(body.messages, messages)
    // The tools are forwarded as given.
    assert.deepEqual(body.tools, [searchTool])
    // The context size and the temperature come from the configuration, not Ollama's defaults.
    assert.deepEqual(body.options, { num_ctx: config.numCtx, temperature: config.chatTemperature })

    // One chunk per line: text has content, a tool call has toolCalls, the last has done.
    assert.deepEqual(
      chunks.map((chunk) => [chunk.content, chunk.toolCalls?.length, chunk.done]),
      [
        ['Hel', undefined, false],
        ['lo', undefined, false],
        [undefined, 1, false],
        [undefined, undefined, true],
      ],
    )
    // The tool call is parsed with its name and arguments, as the agent expects it.
    assert.deepEqual(chunks[2].toolCalls, [
      { function: { name: 'search_docs', arguments: { query: 'chunking' } } },
    ])
  })

  // Proves that a request without tools has no tools field at all, since some models refuse an
  // empty list. Covers: app/ai/ollama.ts: chat.
  it('omits tools from the request when there are none', async (t) => {
    // The request bodies seen by the fake fetch.
    let bodies: string[] = []
    // The fake fetch records the body and answers with a done line.
    t.mock.method(globalThis, 'fetch', async (_url: string | URL, init: RequestInit) => {
      // Record the body.
      bodies.push(String(init.body))
      // The shortest valid answer.
      return streamed([ndjson([{ message: { role: 'assistant', content: '' }, done: true }])])
    })

    // Call without options.
    await collect(chat(messages))

    // The field is absent, not an empty array.
    assert.equal('tools' in JSON.parse(bodies[0]), false)
  })

  // Proves that the caller's AbortSignal reaches fetch and that aborting mid-stream rejects the
  // next read with an AbortError. Covers: app/ai/ollama.ts: chat.
  it('passes the signal to fetch and surfaces the abort', async (t) => {
    // The signal fetch received, to compare with the one given.
    let seen: AbortSignal | null | undefined
    // The controller the case aborts with.
    let controller = new AbortController()
    // The fake fetch keeps the signal and streams one line, then hangs until the abort.
    t.mock.method(globalThis, 'fetch', async (_url: string | URL, init: RequestInit) => {
      // Record the signal.
      seen = init.signal
      // The signal drives the fake body below; chat must have passed one.
      let signal = init.signal!
      // Bytes for the body.
      let encoder = new TextEncoder()
      // A body with one line and a second read that never arrives on its own.
      let body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          // The first line, delivered at once.
          ctrl.enqueue(encoder.encode(ndjson([{ message: { content: 'first' }, done: false }])))
        },
        // The second read hangs until the abort, as a real connection would.
        pull(ctrl) {
          // Settle only when the signal fires, failing the stream with the abort reason.
          return new Promise<void>((_resolve, reject) => {
            // On abort, error the stream and reject the pending read.
            signal.addEventListener('abort', () => {
              // Fail the stream, so the reader under test sees the abort.
              ctrl.error(signal.reason)
              // Fail this pull as well.
              reject(signal.reason)
            })
          })
        },
      })
      // A plain 200 is enough; the content type is not checked by the reader.
      return new Response(body, { status: 200 })
    })

    // Start the call with the signal.
    let generator = chat(messages, { signal: controller.signal })
    // Pull the first chunk, so the request has been made.
    let first = await generator.next()
    // fetch received the very signal the caller passed.
    assert.equal(seen, controller.signal)
    // The first line arrived as a chunk.
    assert.equal(first.value?.content, 'first')

    // Abort while the second read is pending.
    controller.abort()
    // The next pull rejects with an AbortError, not a generic failure.
    await assert.rejects(
      () => generator.next(),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
  })

  // Proves that a refused connection is reported as "Ollama is not running at <url>", the
  // message the user can act on. Covers: app/ai/ollama.ts: chat.
  it('says Ollama is not running when the connection is refused', async (t) => {
    // The fake fetch fails as Node's fetch does when nothing listens on the port.
    t.mock.method(globalThis, 'fetch', async () => {
      // Node reports the refusal in the cause, with the ECONNREFUSED code.
      let cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        code: 'ECONNREFUSED',
      })
      // fetch wraps it in a TypeError with the generic "fetch failed" text.
      throw new TypeError('fetch failed', { cause })
    })

    // The generator rejects with the readable message, including the configured URL.
    await assert.rejects(
      () => collect(chat(messages)),
      (error: unknown) =>
        error instanceof Error && error.message === `Ollama is not running at ${config.ollamaUrl}`,
    )
  })

  // Proves that an HTTP error carries both the status and Ollama's own error text, so a
  // missing model is diagnosed from the message. Covers: app/ai/ollama.ts: chat.
  it('reports the status and the error text of an HTTP error', async (t) => {
    // The fake fetch answers as Ollama does for a model that was never pulled.
    t.mock.method(globalThis, 'fetch', async () => {
      // A 404 with Ollama's error field.
      return Response.json(
        { error: "model 'nope:1b' not found, try pulling it first" },
        { status: 404 },
      )
    })

    // The message names the status and quotes Ollama's text.
    await assert.rejects(
      () => collect(chat(messages)),
      (error: unknown) =>
        error instanceof Error &&
        /404/.test(error.message) &&
        /model 'nope:1b' not found/.test(error.message),
    )
  })

  // Proves that an error object inside the stream rejects the generator after the chunks that
  // came before it. Covers: app/ai/ollama.ts: chat.
  it('turns an error line in the stream into a rejection', async (t) => {
    // The fake fetch streams one good line and then an error line, as Ollama does when its
    // runner crashes mid-answer.
    t.mock.method(globalThis, 'fetch', async () => {
      // Both lines in one read.
      return streamed([
        ndjson([{ message: { content: 'a' }, done: false }, { error: 'runner crashed' }]),
      ])
    })

    // Start the call.
    let generator = chat(messages)
    // The good line arrives first.
    let first = await generator.next()
    // As a chunk with its content.
    assert.equal(first.value?.content, 'a')
    // The error line becomes a rejection prefixed with the service's name.
    await assert.rejects(
      () => generator.next(),
      (error: unknown) => error instanceof Error && error.message === 'Ollama: runner crashed',
    )
  })
})
