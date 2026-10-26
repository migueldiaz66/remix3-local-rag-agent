// ollama.ts: Ollama over plain fetch, the chat stream and the embeddings.
//
// Objective
//   The only module that talks to Ollama. Two calls: POST {ollamaUrl}/api/chat, streamed as
//   NDJSON with optional tools, and POST {ollamaUrl}/api/embed for vectors. It turns the HTTP
//   details into two functions and turns Ollama's failures (not running, model not pulled,
//   error lines in the stream) into errors with a message a person can act on. No SDK: the API
//   is small and fetch is enough. See https://github.com/ollama/ollama/blob/main/docs/api.md
//
// Dependencies
//   ./config.ts: ollamaUrl, chatModel, chatThink, numCtx, chatTemperature, embedModel.
//   ./types.ts: ChatMessage, ToolCall, ToolDefinition, the shapes of /api/chat.
//   Ollama, an HTTP server on config.ollamaUrl, http://localhost:11434 by default.
//
// Consumers
//   app/ai/chat.ts and app/ai/agent.ts: chat, to stream the LLM's answer and tool calls.
//   app/ai/rag.ts: embed, for the question's vector.
//   scripts/ingest.ts: embed, for the passages' vectors.
//   app/ai/ollama.test.ts and app/ai/agent.test.ts: chat, ChatChunk, ChatOptions;
//     app/ai/rag.test.ts replaces embed.
//
// How it relates to them
//   chat yields what Ollama sends, one chunk per line, and nothing else: no retry, no buffering
//   of the whole answer. A caller that wants to stop passes an AbortSignal; aborting closes the
//   connection and Ollama stops generating. Every error is an Error whose message names Ollama
//   and the cause, so chat.ts can send it to the panel as is. embed returns vectors in the order
//   of the texts and throws when the count differs.
import { config } from './config.ts'
import type { ChatMessage, ToolCall, ToolDefinition } from './types.ts'

/**
 * One step of a streamed completion, as chat yields it: a line may carry a piece of text, tool
 * calls, or only the end marker.
 *
 * Called by: app/ai/agent.ts, app/ai/chat.ts, app/ai/agent.test.ts, app/ai/ollama.test.ts
 */
export interface ChatChunk {
  // The next piece of the answer; undefined when the line carried no text.
  content?: string
  // The tool calls the LLM asked for, when the line carried any.
  toolCalls?: ToolCall[]
  // True on the last line of the stream.
  done: boolean
}

/**
 * What a caller may add to a chat call beyond the messages.
 *
 * Called by: app/ai/agent.ts, app/ai/agent.test.ts
 */
export interface ChatOptions {
  // Tools the LLM may call; omitted or empty, the request carries none and the LLM answers
  // in text only.
  tools?: ToolDefinition[]
  // Aborting it closes the connection, which makes Ollama stop generating.
  signal?: AbortSignal
}

/**
 * One NDJSON line of POST /api/chat, the fields this module reads.
 *
 * Called by: chat (this file)
 */
interface ChatLine {
  // The LLM's message so far: a piece of content, or tool calls.
  message?: { role?: string; content?: string; tool_calls?: ToolCall[] }
  // True on the last line.
  done?: boolean
  // Set when Ollama reports a failure in the stream instead of a message.
  error?: string
}

/**
 * Streams a completion: one ChatChunk per NDJSON line Ollama sends. The signal goes to fetch, so
 * aborting it closes the connection and Ollama stops generating.
 *
 * Called by: app/ai/chat.ts, app/ai/agent.ts, app/ai/ollama.test.ts, app/ai/agent.test.ts
 * @param messages the conversation so far, system prompt first; never empty
 * @param options tools the LLM may call, and a signal to abort
 * @returns an async generator of chunks; it throws when Ollama is not running ("Ollama is not
 *   running at ..."), when the status is not 2xx (with Ollama's error text), or when a stream
 *   line carries an error; an abort rethrows fetch's own AbortError
 */
export async function* chat(
  messages: ChatMessage[],
  options: ChatOptions = {},
): AsyncGenerator<ChatChunk> {
  // The two optional inputs.
  let { tools, signal } = options
  // The endpoint.
  let url = `${config.ollamaUrl}/api/chat`
  // The request as Ollama's API takes it: the LLM, the conversation, streaming on, and the
  // sampling options that keep this CPU fast (small context, low temperature).
  let body: Record<string, unknown> = {
    model: config.chatModel,
    messages,
    stream: true,
    options: { num_ctx: config.numCtx, temperature: config.chatTemperature },
  }
  // Tools go only when there are some, so a plain request looks like one without tool support.
  if (tools && tools.length > 0) body.tools = tools
  // The thinking switch goes only to models that understand it (see config.chatThink).
  if (config.chatThink !== undefined) body.think = config.chatThink

  // Declared outside the try so the rest of the function can use it.
  let response: Response
  // Send the request; a rejection here is a connection failure, not an HTTP error.
  try {
    // POST with the JSON body; the signal lets the caller close the connection.
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    // The caller's abort is theirs to handle; anything else is explained in Ollama's terms.
  } catch (error) {
    // An abort is not a failure of Ollama: rethrow it unchanged so callers recognise it.
    if (signal?.aborted) throw error
    // "fetch failed" becomes "Ollama is not running at ..." or the socket error code.
    throw describeNetworkError(error)
  }
  // A 4xx or 5xx carries Ollama's error text, for example a model that is not pulled.
  if (!response.ok) throw await describeHttpError(response)
  // The body is the stream; a response without one has nothing to read.
  if (!response.body) throw new Error(`Ollama answered ${response.status} without a body`)

  // How many lines arrived, for the abort log.
  let chunks = 0
  // When the stream began, for the abort log.
  let started = Date.now()
  // Read lines until the stream ends or the caller aborts.
  try {
    // Each line is a JSON object; blank lines are skipped by lines().
    for await (let text of lines(response.body)) {
      // The fields this module reads; the rest of the object is ignored.
      let line = JSON.parse(text) as ChatLine
      // Ollama can fail after answering 200; the error then comes as a line.
      if (line.error) throw new Error(`Ollama: ${line.error}`)
      // One more line received.
      chunks++
      // Hand the piece to the caller: text (empty becomes undefined), tool calls, the end mark.
      yield {
        content: line.message?.content || undefined,
        toolCalls: line.message?.tool_calls,
        done: line.done === true,
      }
    }
    // Runs however the loop ends: stream over, error thrown, or the caller stopped consuming.
  } finally {
    // An abort is the one exit worth a line in the server log: it says how far the LLM got.
    if (signal?.aborted) {
      // The log line, prefixed so it is found among the server's output.
      console.log(`[ollama] chat aborted after ${chunks} chunks, ${Date.now() - started} ms`)
    }
  }
}

/**
 * Splits a byte stream into lines as they arrive; the last one may come without a newline.
 * Blank lines are dropped. The reader's lock is released however the loop ends.
 *
 * Called by: chat (this file)
 * @param body the response body, a stream of UTF-8 bytes
 * @returns an async generator of complete lines, without their newline
 */
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  // Exclusive access to the stream.
  let reader = body.getReader()
  // Stateful: a multi-byte character split across two reads is decoded correctly.
  let decoder = new TextDecoder()
  // Text received but not yet terminated by a newline.
  let buffer = ''
  // Read until the stream closes; release the reader whatever happens.
  try {
    // One iteration per network read.
    while (true) {
      // The next bytes, or done when the stream has closed.
      let { value, done } = await reader.read()
      // The stream is over; the buffer may still hold an unterminated last line.
      if (done) break
      // Append the decoded text; stream: true keeps a partial character for the next read.
      buffer += decoder.decode(value, { stream: true })
      // Everything before a newline is a complete line.
      let parts = buffer.split('\n')
      // The last part has no newline yet: keep it for the next read.
      buffer = parts.pop() ?? ''
      // Yield the complete lines, skipping blank ones.
      for (let part of parts) if (part.trim()) yield part
    }
    // Flush any partial character the decoder still holds.
    buffer += decoder.decode()
    // The last line, when the stream did not end with a newline.
    if (buffer.trim()) yield buffer
    // Always release the stream, whether the loop finished, threw or was abandoned.
  } finally {
    // Let the body be cancelled or read by someone else.
    reader.releaseLock()
  }
}

/**
 * Explains a rejected fetch. fetch rejects with "fetch failed" and the socket error as its
 * cause; a refused connection means Ollama is not running, anything else is reported by code.
 *
 * Called by: chat, embed (this file)
 * @param error whatever fetch rejected with
 * @returns an Error naming config.ollamaUrl: "Ollama is not running at ..." for ECONNREFUSED,
 *   "Ollama is not reachable at ...: <code or message>" otherwise
 */
function describeNetworkError(error: unknown): Error {
  // The shape of Node's socket errors: a code, or a list of errors with codes when several
  // addresses were tried (localhost resolving to both ::1 and 127.0.0.1).
  type SocketError = { code?: string; errors?: { code?: string }[] }
  // The cause, when the rejection is an Error; fetch puts the socket error there.
  let cause = error instanceof Error ? (error.cause as SocketError | undefined) : undefined
  // The error code, from the cause itself or from the first of its inner errors.
  let code = cause?.code ?? cause?.errors?.[0]?.code
  // Nothing listens on the port: the usual case, said plainly.
  if (code === 'ECONNREFUSED') {
    // The message the panel shows.
    return new Error(`Ollama is not running at ${config.ollamaUrl}`)
  }
  // Any other failure: the code when there is one, else the message.
  let detail = code ?? (error instanceof Error ? error.message : String(error))
  // The message the panel shows.
  return new Error(`Ollama is not reachable at ${config.ollamaUrl}: ${detail}`)
}

/**
 * Explains a non-2xx response. Ollama answers errors as { "error": "..." }, for example a model
 * that is not pulled; the body is used as it is when it is not JSON.
 *
 * Called by: chat, embed (this file)
 * @param response the failed response; its body is consumed here
 * @returns an Error "Ollama answered <status>: <detail>"; never throws
 */
async function describeHttpError(response: Response): Promise<Error> {
  // The body, or an empty string when even reading it fails.
  let text = await response.text().catch(() => '')
  // The detail starts as the raw text and is refined when the body is Ollama's JSON.
  let detail = text
  // Prefer Ollama's error field over the raw JSON.
  try {
    // The body as JSON; throws when it is not.
    let parsed = JSON.parse(text) as { error?: unknown }
    // Ollama's message, when the field is there and is a string.
    if (typeof parsed.error === 'string') detail = parsed.error
    // The body was not JSON, for example an HTML error page from a proxy.
  } catch {
    // Not JSON: keep the raw text.
  }
  // Status plus detail, the detail omitted when there is none.
  return new Error(`Ollama answered ${response.status}${detail ? `: ${detail}` : ''}`)
}

/**
 * Embeds texts in one call; returns one vector per text, in order. The signal goes to fetch.
 *
 * Called by: app/ai/rag.ts: retrieve, scripts/ingest.ts: main; app/ai/rag.test.ts replaces it
 * @param texts the texts to embed, already prefixed by rag.ts when the embedding model wants a
 *   prefix; an empty list makes no request
 * @param options a signal to abort the request
 * @returns one vector per text, in the same order, all of the embedding model's dimension;
 *   throws when Ollama is not running, when the embedding model is not pulled (404, with the
 *   pull command to run), on any other non-2xx status, and when the count of vectors differs
 *   from the count of texts
 */
export async function embed(
  texts: string[],
  options: { signal?: AbortSignal } = {},
): Promise<number[][]> {
  // Nothing to embed: no request, no vectors.
  if (texts.length === 0) return []
  // The optional abort signal.
  let { signal } = options

  // Declared outside the try so the rest of the function can use it.
  let response: Response
  // Send the request; a rejection here is a connection failure, not an HTTP error.
  try {
    // POST the embedding model and all the texts at once, as /api/embed accepts a list.
    response = await fetch(`${config.ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.embedModel, input: texts }),
      signal,
    })
    // The caller's abort is theirs to handle; anything else is explained in Ollama's terms.
  } catch (error) {
    // An abort is not a failure of Ollama: rethrow it unchanged.
    if (signal?.aborted) throw error
    // "fetch failed" becomes "Ollama is not running at ..." or the socket error code.
    throw describeNetworkError(error)
  }
  // Ollama answers 404 for a model it does not have.
  if (response.status === 404) {
    // The embedding model is not pulled.
    let error = await describeHttpError(response)
    // Add the command that fixes it.
    throw new Error(`${error.message}. Run: ollama pull ${config.embedModel}`)
  }
  // Any other failure, with Ollama's text.
  if (!response.ok) throw await describeHttpError(response)

  // The body; only the embeddings field matters.
  let data = (await response.json()) as { embeddings?: unknown }
  // The vectors, checked below before they are trusted.
  let embeddings = data.embeddings
  // One vector per text or the answer is unusable: the caller pairs them by position.
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    // "no" when the field is missing or not a list, else the count received.
    let got = Array.isArray(embeddings) ? String(embeddings.length) : 'no'
    // Say what came back against what was asked.
    throw new Error(`Ollama returned ${got} embeddings for ${texts.length} texts`)
  }
  // The vectors, in the order of the texts.
  return embeddings as number[][]
}
