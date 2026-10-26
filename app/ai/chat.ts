// chat.ts: POST /api/chat, reads a ChatRequest and answers with a stream of StreamEvent lines.
//
// Objective
//   Serve the chat endpoint. The request body names one of three modes, 'llm', 'rag' or
//   'agent', and the question; the response is NDJSON, one JSON StreamEvent per line, streamed
//   while the LLM writes. The three modes are dispatched here; each one is a module of its
//   own ('llm' is a plain call to the LLM with a short system prompt).
//
// Dependencies
//   ./agent.ts: runAgent, the 'agent' mode.
//   ./config.ts: config, for ragLimit (passages per RAG answer) and chatModel (named in 'done').
//   ./ollama.ts: chat, the streaming call to Ollama (port 11434), and the ChatChunk type.
//   ./rag.ts: retrieve (the search in Qdrant, port 6335) and buildRagMessages, the 'rag' mode.
//   ./types.ts: the ChatMessage, ChatRequest and StreamEvent types.
//   CHAT_TRACE: environment variable; '1' logs every event with its time since the request.
//
// Consumers
//   app/actions/api/controller.tsx: handleChat, for the chat action of routes.api.
//   app/ai/chat.test.ts: isChatRequest and toNdjson.
//
// How it relates to them
//   The controller passes the Request and returns the Response untouched; validation, the
//   status codes (400 for a bad body) and the NDJSON framing live here. The browser side
//   (app/actions/public/chat-panel.tsx) reads the lines with the StreamEvent type from
//   types.ts; a new event type is added there first, then here, then in the panel. Any error
//   while answering becomes an 'error' line, so a stream the client did not cancel always ends
//   with 'done' or 'error'.
import { runAgent } from './agent.ts'
import { config } from './config.ts'
import * as ollama from './ollama.ts'
import { buildRagMessages, retrieve } from './rag.ts'
import type { ChatMessage, ChatRequest, StreamEvent } from './types.ts'

/**
 * The modes a request may name; isChatRequest rejects any other.
 *
 * Called by: isChatRequest (this file)
 */
const MODES = new Set(['llm', 'rag', 'agent'])

/**
 * CHAT_TRACE=1 logs every event the stream sends, with its time since the request started.
 *
 * Called by: toNdjson (this file)
 */
const TRACE = process.env.CHAT_TRACE === '1'

/**
 * The system prompt of the 'llm' mode: who the assistant is, and how to answer. The other modes
 * have their own prompts in rag.ts and agent.ts.
 *
 * Called by: answer (this file), for mode 'llm'
 */
const SYSTEM_PROMPT =
  'You are the assistant of a UI that teaches retrieval-augmented generation (RAG). Answer ' +
  'briefly and plainly, in English.'

/**
 * The handler of POST /api/chat: validates the body, then streams the answer as NDJSON.
 *
 * Called by: app/actions/api/controller.tsx: chat
 * @param request the incoming request; its body must be JSON with mode and question, and its
 *   signal fires when the browser aborts the request
 * @returns 400 with { error } for a body that is not JSON or not a ChatRequest; otherwise 200
 *   with an application/x-ndjson stream that is never cached
 */
export async function handleChat(request: Request): Promise<Response> {
  // The parsed body, unknown until isChatRequest has checked it.
  let body: unknown
  // The body may not be JSON at all.
  try {
    // Read and parse the JSON body.
    body = await request.json()
    // Unparseable: a 400 that says so, instead of a crash.
  } catch {
    // Reject the request.
    return Response.json({ error: 'The body must be JSON' }, { status: 400 })
  }
  // JSON, but not a valid ChatRequest: a 400 that spells out the expected shape.
  if (!isChatRequest(body)) {
    // Reject the request.
    return Response.json(
      { error: 'Expected { mode: "llm" | "rag" | "agent", question: string }' },
      { status: 400 },
    )
  }

  // When the request started, to log how long the client waited before aborting.
  let started = Date.now()
  // Log an abort by the client (a closed tab, a new question) with the time it took.
  request.signal.addEventListener(
    'abort',
    () =>
      console.log(
        `[chat] ${body.mode} request aborted by the client after ${Date.now() - started} ms`,
      ),
    { once: true },
  )

  // The answer as a stream of events for the mode the body names; aborts follow the signal.
  let events = answer(body, request.signal)
  // The NDJSON response; no-store so no proxy or browser caches an answer.
  return new Response(toNdjson(events), {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Type guard for the request body: an object with a known mode and a non-blank question.
 *
 * Called by: handleChat (this file), app/ai/chat.test.ts
 * @param value the parsed JSON body, of any shape
 * @returns true when value is a ChatRequest; the optional context is not checked here
 */
export function isChatRequest(value: unknown): value is ChatRequest {
  // Only an object can be a request.
  if (typeof value !== 'object' || value === null) return false
  // The two required fields, read loosely before they are checked.
  let { mode, question } = value as Record<string, unknown>
  // A known mode and a question with some text in it.
  return (
    typeof mode === 'string' &&
    MODES.has(mode) &&
    typeof question === 'string' &&
    question.trim() !== ''
  )
}

/**
 * The dispatch on the mode: one branch per mode, each yielding the StreamEvents of its answer.
 *
 * Called by: handleChat (this file)
 * @param body the validated request
 * @param signal the request's signal; passed to Ollama so an abort stops the LLM
 * @returns the events of the answer: 'sources' then 'token's for 'rag', what runAgent yields
 *   for 'agent', 'token's only for 'llm'; no 'done', which toNdjson adds
 */
async function* answer(body: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  // The question with the selected step written into it, for every mode alike.
  let question = withContext(body)
  // One branch per mode; each returns when its answer is complete.
  switch (body.mode) {
    // 'llm': the LLM alone, with the short system prompt and no passages.
    case 'llm': {
      // The two-message conversation: who the assistant is, and the question.
      let messages: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question },
      ]
      // Stream the LLM's text as tokens.
      yield* tokens(ollama.chat(messages, { signal }))
      // Done.
      return
    }
    // 'rag': the closest passages first, then the LLM answering from them.
    case 'rag': {
      // Search Qdrant for the passages closest to the question.
      let sources = await retrieve(question, config.ragLimit)
      // The panel lists the sources before the answer starts.
      yield { type: 'sources', sources }
      // The LLM answers from the passages, with rag.ts's prompt; its text streams as tokens.
      yield* tokens(ollama.chat(buildRagMessages(question, sources), { signal }))
      // Done.
      return
    }
    // 'agent': retrieval plus the tool loop of agent.ts.
    case 'agent': {
      // Everything the loop yields goes out as is.
      yield* runAgent(question, body.context, signal)
      // Done.
      return
    }
  }
}

/**
 * The question, with what the UI knows added as plain text: the step selected in the canvas.
 *
 * Called by: answer (this file)
 * @param body the validated request, with an optional context.selectedNode
 * @returns the question alone, or the question followed by a sentence naming the selected step
 *   and its description
 */
function withContext(body: ChatRequest): string {
  // The selected step, if the panel sent one.
  let node = body.context?.selectedNode
  // Nothing selected: the question as typed.
  if (!node) return body.question
  // The selection as a sentence after the question, so every mode sees it without a schema.
  return (
    `${body.question}\n\n` +
    `(The user has selected the step "${node.label}" in the canvas: ${node.description})`
  )
}

/**
 * Turns Ollama's chunks into 'token' events, dropping chunks without text.
 *
 * Called by: answer (this file)
 * @param chunks the LLM's stream from ollama.chat
 * @returns one 'token' event per chunk with content; stream errors propagate
 */
async function* tokens(chunks: AsyncGenerator<ollama.ChatChunk>): AsyncGenerator<StreamEvent> {
  // Read the stream as the LLM writes.
  for await (let chunk of chunks) {
    // Only chunks with text become tokens.
    if (chunk.content) yield { type: 'token', text: chunk.content }
  }
}

/**
 * Frames the events as NDJSON. Each event becomes one JSON line. An error becomes an 'error'
 * event, never a broken stream, and a 'done' event closes every successful answer. Pull-based,
 * so a slow reader slows the LLM.
 *
 * Called by: handleChat (this file), app/ai/chat.test.ts
 * @param events the answer's events; the generator is closed when the reader cancels
 * @returns a byte stream of UTF-8 JSON lines ending with 'done' (model and elapsed ms) or
 *   'error' (message); after a cancel, nothing more is written
 */
export function toNdjson(events: AsyncGenerator<StreamEvent>): ReadableStream<Uint8Array> {
  // Text to bytes, once for the whole stream.
  let encoder = new TextEncoder()
  // When the stream started, for the elapsed time in 'done' and in the trace.
  let started = Date.now()
  // One event as one line of bytes.
  let line = (event: StreamEvent) => encoder.encode(JSON.stringify(event) + '\n')

  // Set when the reader went away (the browser aborted the request); the generator's own
  // rejection, from the aborted upstream fetch, is then expected and not an error line.
  let cancelled = false

  // The stream the Response sends; the reader pulls one event at a time.
  return new ReadableStream<Uint8Array>({
    /**
     * Writes one event, or ends the stream, each time the reader wants more.
     *
     * Called by: the ReadableStream, on demand
     * @param controller the stream's controller, to enqueue bytes and close
     */
    async pull(controller) {
      // The generator may reject: an Ollama error, an aborted fetch.
      try {
        // The next event, or done when the generator returned.
        let { value, done } = await events.next()
        // The reader is gone: write nothing, the stream is already closed on its side.
        if (cancelled) return
        // The answer is complete: the 'done' line, then close.
        if (done) {
          // Which model answered, and how long the whole answer took.
          controller.enqueue(
            line({ type: 'done', model: config.chatModel, ms: Date.now() - started }),
          )
          // No more lines.
          controller.close()
          // Nothing else to do for this pull.
          return
        }
        // With CHAT_TRACE=1, the event's type and its time since the start, on the server log.
        if (TRACE) console.log(`[chat] +${Date.now() - started} ms ${value.type}`)
        // The event as one line.
        controller.enqueue(line(value))
        // The generator failed: the error becomes the last line, unless nobody is reading.
      } catch (error) {
        // An aborted request fails on purpose; the reader is gone, so say nothing.
        if (cancelled) return
        // The message of an Error, or the text of anything else thrown.
        let message = error instanceof Error ? error.message : String(error)
        // The 'error' line, so the panel can show what went wrong.
        controller.enqueue(line({ type: 'error', message }))
        // The stream ends with the error.
        controller.close()
      }
    },
    /**
     * Stops the generator when the reader cancels (the browser aborted the request).
     *
     * Called by: the ReadableStream, once, on cancel
     */
    cancel() {
      // From now on pull() writes nothing.
      cancelled = true
      // Close the generator, which releases the LLM call; its result is not awaited.
      void events.return(undefined)
    },
  })
}
