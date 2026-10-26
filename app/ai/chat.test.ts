// chat.test.ts: the dispatcher's pure parts, the request guard and the NDJSON event stream.
//
// Objective
//   Prove that isChatRequest accepts exactly the bodies the chat panel sends and rejects the
//   rest, and that toNdjson writes one JSON line per event, closes with a done line carrying the
//   model and the elapsed time, turns a thrown error into an error line, and returns the
//   generator when the reader cancels. handleChat itself needs Ollama and is not run here.
//
// Dependencies
//   remix/assert: ok, equal and deepEqual, the assertions.
//   remix/test: describe and it, the runner's grouping and cases.
//   ./chat.ts: isChatRequest and toNdjson, the functions under test.
//   ./config.ts: config.chatModel, the LLM name the done line must report.
//   ./types.ts: StreamEvent, the type of the events written and read back.
//   No external service.
//
// Consumers
//   `npm test` (package.json) runs it; nothing imports it.
//   app/ai/chat.ts is the module it covers: a change there must keep these cases green.
//
// How it relates to them
//   The chat panel (app/actions/public/chat-panel.tsx) reads the stream these cases describe:
//   one JSON object per line, every line ending in a newline, an error line instead of a broken
//   connection, and a done line last. These tests are that contract written down.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { isChatRequest, toNdjson } from './chat.ts'
import { config } from './config.ts'
import type { StreamEvent } from './types.ts'

/**
 * Reads the whole stream and parses it line by line, failing if the last line has no newline:
 * a client that splits on newlines would otherwise hold an incomplete last event.
 *
 * Called by: this file: the first two toNdjson cases
 * @param stream the byte stream toNdjson returned
 * @returns the events, one per line, in order; throws if a line is not JSON
 */
async function readLines(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
  // Drain the stream to text through Response, which handles the decoding.
  let text = await new Response(stream).text()
  // The newline is part of the format: without it the last event is not delimited.
  assert.ok(text.endsWith('\n'), 'every line ends with a newline')
  // Drop the trailing newline, split on the rest, and parse each line as one event.
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as StreamEvent)
}

// The guard that decides whether a body is a ChatRequest.
describe('isChatRequest', () => {
  // Proves that each of the three modes passes, with and without the selected-node context.
  // Covers: app/ai/chat.ts: isChatRequest.
  it('accepts the three modes, with or without context', () => {
    // The plain LLM mode.
    assert.ok(isChatRequest({ mode: 'llm', question: 'What is retrieval-augmented generation?' }))
    // The retrieval mode.
    assert.ok(isChatRequest({ mode: 'rag', question: 'How does chunking work?' }))
    // The agent mode, carrying the node the user selected on the canvas.
    assert.ok(
      isChatRequest({
        mode: 'agent',
        question: 'Highlight it',
        context: { selectedNode: { id: 'retrieval', label: 'Retrieval', description: '...' } },
      }),
    )
  })

  // Proves that non-objects, unknown modes, missing, blank or non-string questions are all
  // refused. Covers: app/ai/chat.ts: isChatRequest.
  it('rejects anything else', () => {
    // null is an object to typeof, so it must be checked apart.
    assert.equal(isChatRequest(null), false)
    // A bare string is not a request.
    assert.equal(isChatRequest('llm'), false)
    // An empty object has no mode.
    assert.equal(isChatRequest({}), false)
    // A mode outside the three.
    assert.equal(isChatRequest({ mode: 'nope', question: 'x' }), false)
    // A missing question.
    assert.equal(isChatRequest({ mode: 'llm' }), false)
    // A question made only of whitespace: nothing to ask.
    assert.equal(isChatRequest({ mode: 'llm', question: '   ' }), false)
    // A question of the wrong type.
    assert.equal(isChatRequest({ mode: 'llm', question: 42 }), false)
  })
})

// The encoder from an event generator to a byte stream of NDJSON lines.
describe('toNdjson', () => {
  // Proves that each event becomes one line and that a done line with the LLM and the
  // elapsed milliseconds closes the stream. Covers: app/ai/chat.ts: toNdjson.
  it('writes one line per event and closes with a done line', async () => {
    /**
     * A generator of two token events and nothing else: the smallest complete stream.
     *
     * Called by: toNdjson, in this case
     * @returns two token events, then it finishes
     */
    async function* two(): AsyncGenerator<StreamEvent> {
      // The first piece of an answer.
      yield { type: 'token', text: 'Hello' }
      // The second piece.
      yield { type: 'token', text: ', world' }
    }

    // Encode and read back.
    let lines = await readLines(toNdjson(two()))

    // Two events plus the done line.
    assert.equal(lines.length, 3)
    // Events pass through unchanged.
    assert.deepEqual(lines[0], { type: 'token', text: 'Hello' })
    // In order.
    assert.deepEqual(lines[1], { type: 'token', text: ', world' })
    // The last line is the done marker.
    let done = lines[2]
    // Its type tells the client the stream is complete.
    assert.equal(done.type, 'done')
    // The narrowing lets the fields of the done variant be read with their types.
    if (done.type === 'done') {
      // The done line names the LLM that answered, so the panel can show it.
      assert.equal(done.model, config.chatModel)
      // And how long the whole exchange took.
      assert.equal(typeof done.ms, 'number')
      // A duration cannot be negative.
      assert.ok(done.ms >= 0)
    }
  })

  // Proves that an error thrown mid-stream becomes an error line after the events already sent,
  // and that the stream ends there with no done line. Covers: app/ai/chat.ts: toNdjson.
  it('turns a thrown error into an error line and ends the stream', async () => {
    /**
     * A generator that yields one token and then fails as Ollama's client would when the
     * server is down.
     *
     * Called by: toNdjson, in this case
     * @returns one token event, then it throws
     */
    async function* failing(): AsyncGenerator<StreamEvent> {
      // Some output arrives before the failure.
      yield { type: 'token', text: 'partial' }
      // The failure, with the message the client should see.
      throw new Error('Ollama is not running at http://localhost:11434')
    }

    // Encode and read back; readLines also proves the error line ends with a newline.
    let lines = await readLines(toNdjson(failing()))

    // The partial output is kept, the error follows it, and nothing comes after.
    assert.deepEqual(lines, [
      { type: 'token', text: 'partial' },
      { type: 'error', message: 'Ollama is not running at http://localhost:11434' },
    ])
  })

  // Proves that cancelling the byte stream returns the generator, so an aborted request does
  // not leave a model call running. Covers: app/ai/chat.ts: toNdjson.
  it('returns the generator when the reader cancels', async () => {
    // Set by the generator's finally block: the proof that it was returned.
    let finished = false
    /**
     * A generator that never ends on its own and records when it is closed from outside.
     *
     * Called by: toNdjson, in this case
     * @returns token events forever, until the consumer returns it
     */
    async function* endless(): AsyncGenerator<StreamEvent> {
      // The finally block runs whether the loop ends or the generator is returned.
      try {
        // A counter, so every token is different.
        let n = 0
        // Yield forever; only a return from outside stops it.
        while (true) yield { type: 'token', text: String(n++) }
      // Record the close, however it happened.
      } finally {
        // The flag the assertion below reads.
        finished = true
      }
    }

    // Take a reader on the byte stream, as fetch's consumer would.
    let reader = toNdjson(endless()).getReader()
    // Pull one chunk, so the generator is running.
    let first = await reader.read()
    // The stream is live, not already closed.
    assert.equal(first.done, false)
    // Cancel, as the browser does when the user aborts the request.
    await reader.cancel()

    // The cancel reached the generator and ran its finally block.
    assert.equal(finished, true)
  })
})
