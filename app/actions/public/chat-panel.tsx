// chat-panel.tsx: the chat panel; three modes behind one input, answers streamed line by line.
//
// Objective
//   The right-hand side of the page. The user picks a mode (LLM alone, RAG over the article,
//   or the agent with tools), types a question and gets the answer as it streams from
//   the server. Each answer keeps the events it received; the render derives the tool lines, the
//   sources and the footer from them. One AbortController per request: the Stop button aborts
//   it, and so does the component's own signal when it disconnects. A 'ui' event from the agent
//   is forwarded to the canvas, and a click on the canvas becomes a chip above the input that
//   gives the next question its context.
//
// Dependencies
//   remix/component: clientEntry (hydration in the browser), css (scoped styles), on (event
//     handlers), ref (element access) and the Handle type.
//   ../../ai/types.ts: ChatMode, ChatRequest, Source and StreamEvent, the contract with the
//     server's chat endpoint; the panel never invents an event shape of its own.
//   ./events.ts: onNodeSelected to hear the canvas, emitHighlightNode to point at a node.
//   The app's own server: POST handle.props.chatHref with a ChatRequest as JSON; the answer is a
//     stream of NDJSON lines, one StreamEvent each (app/ai/chat.ts: handleChat). The server, not
//     the panel, talks to Ollama (port 11434) and Qdrant (port 6335).
//
// Consumers
//   app/actions/page.tsx: Page renders ChatPanel, with chatHref, in the aside.
//   app/actions/public/entry.ts: the browser runtime loads this module through clientEntry.
//
// How it relates to them
//   The page gives the endpoint's href and a column with a height; the panel fills it and
//   scrolls its own list. Everything the panel shows comes from StreamEvents, so a new event type
//   on the server needs a branch in renderAssistant, or it is kept and never shown. The canvas is
//   reached only through events.ts. The module-level helpers below the component are pure, so
//   they could be tested without a browser.
import { clientEntry, css, on, ref, type Handle } from 'remix/component'

import type { ChatMode, ChatRequest, Source, StreamEvent } from '../../ai/types.ts'
import { emitHighlightNode, type NodeSelectedDetail, onNodeSelected } from './events.ts'

/**
 * One entry of the conversation, the user's question or the assistant's answer. An answer is
 * built up while it streams: the text grows token by token and the events accumulate; the
 * render reads both.
 *
 * Called by: ChatPanel and its inner functions ask, receive and renderAssistant (this file)
 */
interface Message {
  /** Unique within the panel's life; the key of the list item, so its DOM is reused. */
  id: number
  /** Who wrote it: decides the bubble's side and style, and how the text is rendered. */
  role: 'user' | 'assistant'
  /** The question, or the answer's text so far (the 'token' events, concatenated). */
  text: string
  /** Every StreamEvent received for an answer, in order; empty for a question. */
  events: StreamEvent[]
  // The user pressed Stop, or the panel went away, before the answer ended.
  stopped?: boolean
}

/**
 * The three modes, in the order of the buttons. The id is what the server receives; the hint is
 * the button's tooltip.
 *
 * Called by: ChatPanel's render (this file), to draw the mode buttons
 */
const MODES: { id: ChatMode; hint: string }[] = [
  { id: 'llm', hint: 'The LLM alone' },
  { id: 'rag', hint: 'The LLM over passages of the article' },
  { id: 'agent', hint: 'The LLM with tools over the article and the canvas' },
]

/**
 * How many characters of a source passage are shown under an answer before it is cut with an
 * ellipsis: enough to recognise the passage, short enough for the 400px column.
 *
 * Called by: snippet (this file)
 */
const SNIPPET_LENGTH = 120

/**
 * The panel component, registered as a client entry so the browser hydrates it by its module
 * URL and export name. Props: chatHref, the chat endpoint to POST to.
 *
 * Called by: app/actions/page.tsx: Page
 */
export const ChatPanel = clientEntry(
  import.meta.url,
  /**
   * Sets up the panel's state and returns its render function. The state lives in closures, as
   * Remix components do: a change is followed by handle.update() to re-render.
   *
   * Called by: the Remix component runtime, on the server and in the browser
   * @param handle the component handle: props, update(), queueTask() and the teardown signal
   * @returns the render function
   */
  function ChatPanel(handle: Handle<{ chatHref: string }>) {
    // The mode of the next question; LLM alone until the user picks another.
    let mode: ChatMode = 'llm'
    // The conversation, oldest first; rendered as the list.
    let messages: Message[] = []
    // The next Message id; incremented for each question and each answer.
    let nextId = 1
    // True while an answer streams: disables the input and shows Stop instead of Send.
    let busy = false
    // The canvas node the user clicked, if any; shown as a chip and sent with the next question.
    let selected: NodeSelectedDetail | undefined
    // The controller of the request in flight, so Stop can abort it; undefined when idle.
    let controller: AbortController | undefined
    // The question field, captured by ref, to give it focus after an answer or a click.
    let input: HTMLInputElement | undefined
    // The message list, captured by ref, to scroll it to the end.
    let list: HTMLOListElement | undefined

    // Browser-only setup, after the client commit: the canvas tells us which step was clicked.
    handle.queueTask(() => {
      // Subscribe once, for the component's life.
      onNodeSelected((detail) => {
        // Remember the click as the context of the next question...
        selected = detail
        // ...show the chip...
        void handle.update()
        // ...and bring the cursor to the input, so the user can type right away.
        input?.focus()
        // The subscription ends with the component: handle.signal aborts on teardown.
      }, handle.signal)
    })

    /**
     * Scrolls the message list to its end, so the newest text is in view.
     *
     * Called by: refresh, ask (this file)
     */
    function scrollToEnd() {
      // The list exists only after the first browser render; scrollHeight is its end.
      if (list) list.scrollTop = list.scrollHeight
    }

    /**
     * Re-renders and keeps the last message in view: the scroll runs after the update commits,
     * when the list has its new height.
     *
     * Called by: ask (this file)
     */
    function refresh() {
      // Re-render now; the promise is not awaited, since the scroll is queued separately.
      void handle.update()
      // After the commit, scroll to the new end.
      handle.queueTask(scrollToEnd)
    }

    /**
     * The Stop button: aborts the request in flight. ask's catch then marks the answer stopped.
     *
     * Called by: ChatPanel's render (this file), the Stop button
     */
    function stop() {
      // No request in flight means nothing to abort.
      controller?.abort()
    }

    /**
     * The chip's close button: forgets the clicked node, so the next question has no context.
     *
     * Called by: ChatPanel's render (this file), the chip's clear button
     */
    function clearSelection() {
      // Forget the node...
      selected = undefined
      // ...and re-render without the chip.
      void handle.update()
    }

    /**
     * Applies one stream event to the answer being built: every event is kept for the render,
     * a token extends the text, and a 'ui' highlight request is forwarded to the canvas at once.
     *
     * Called by: ask (this file)
     * @param reply the assistant message being filled; mutated in place
     * @param event the StreamEvent just read, or an error the panel made itself
     * @returns nothing
     */
    function receive(reply: Message, event: StreamEvent) {
      // Keep everything: tools, sources, errors and done are read by renderAssistant.
      reply.events.push(event)
      // A token is a piece of the answer's text.
      if (event.type === 'token') reply.text += event.text
      // The agent asked for a node to be highlighted; the canvas listens through events.ts.
      if (event.type === 'ui' && event.action === 'highlight-node') {
        emitHighlightNode({ nodeId: event.nodeId })
      }
    }

    /**
     * Sends a question and streams the answer into a new assistant message. The user's message
     * and the empty answer are added first, so the list shows both at once; then the request is
     * made with the mode and, when a node was clicked, that node as context. Stop or the panel's
     * teardown abort the request; any other failure becomes an 'error' event in the answer.
     *
     * Called by: ChatPanel's render (this file), the form's submit handler
     * @param question the trimmed, non-empty question
     * @returns settles when the answer ended, was stopped or failed; never rejects
     */
    async function ask(question: string) {
      // The server's contract: mode, question, and the clicked node when there is one.
      let request: ChatRequest = {
        mode,
        question,
        context: selected ? { selectedNode: selected } : undefined,
      }
      // The answer, empty for now; receive fills it as the events arrive.
      let reply: Message = { id: nextId++, role: 'assistant', text: '', events: [] }
      // The question and the answer enter the list together.
      messages.push({ id: nextId++, role: 'user', text: question, events: [] }, reply)
      // The context was used; the chip goes away with the next render.
      selected = undefined
      // Lock the input and show Stop.
      busy = true
      // Stop aborts this controller...
      controller = new AbortController()
      // ...and the panel's teardown aborts the request too, through the combined signal.
      let signal = AbortSignal.any([controller.signal, handle.signal])
      // Show the question and the waiting answer.
      refresh()

      // The request and the stream; the catch and the finally below settle the answer.
      try {
        // POST the JSON request; the response body is NDJSON that streams.
        let response = await fetch(handle.props.chatHref, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal,
        })
        // A status outside 2xx, or no body: show the server's reason and stop here.
        if (!response.ok || !response.body) {
          // The error becomes part of the answer, like a server-sent one.
          receive(reply, { type: 'error', message: await describeFailure(response) })
          // Nothing to stream.
          return
        }
        // Apply each event as it arrives and re-render, so the text grows word by word.
        for await (let event of readEvents(response.body)) {
          // The event updates the answer...
          receive(reply, event)
          // ...and the screen follows.
          refresh()
        }
        // Aborted or failed: which one decides what the answer shows.
      } catch (error) {
        // An abort is not an error: the user pressed Stop or the panel left the page.
        if (signal.aborted) {
          // The footer will say "Stopped".
          reply.stopped = true
          // Anything else (network, bad JSON) is shown as an error in the answer.
        } else {
          // Error objects have a message; anything else thrown is shown as text.
          let message = error instanceof Error ? error.message : String(error)
          // The error becomes part of the answer.
          receive(reply, { type: 'error', message })
        }
        // Whatever happened, the panel is idle again.
      } finally {
        // Unlock the input and show Send.
        busy = false
        // No request in flight.
        controller = undefined
        // After teardown there is nothing to update; otherwise render, scroll and refocus.
        if (!handle.signal.aborted) {
          // Awaited this time, so the scroll sees the final height.
          await handle.update()
          // The whole answer in view...
          scrollToEnd()
          // ...and the cursor back in the field for the next question.
          input?.focus()
        }
      }
    }

    /**
     * Renders the inside of an assistant bubble from the message's events: the tool calls made,
     * the text (or an ellipsis while the first token is awaited), the sources of a RAG answer,
     * the errors, and a footer with "Stopped" or with the LLM and the time taken.
     *
     * Called by: ChatPanel's render (this file), for each assistant message
     * @param message the assistant message; its events decide what is shown
     * @param isLast true for the newest message, the only one that can be waiting
     * @returns the bubble's children
     */
    function renderAssistant(message: Message, isLast: boolean) {
      // The agent's tool calls, in order; each becomes a monospace line above the text.
      let tools = message.events.filter((event) => event.type === 'tool')
      // The passages a RAG or agent answer cited; at most one 'sources' event per answer.
      let sources = message.events.find((event) => event.type === 'sources')?.sources ?? []
      // Server-side failures and the panel's own, shown after the text.
      let errors = message.events.filter((event) => event.type === 'error')
      // The 'done' event, with the LLM's name and the time taken, when the answer ended well.
      let done = message.events.find((event) => event.type === 'done')
      // Nothing to show yet: the newest answer, still streaming, without a token or an error.
      let waiting = busy && isLast && !message.text && errors.length === 0

      // The bubble's parts, in reading order.
      return (
        // A fragment: the <li> of the render is the bubble; these are its children.
        <>
          {/* One line per tool call: the tool's name and its arguments' values. */}
          {tools.map((tool, index) => (
            // The index is a fine key: tool lines are only ever appended.
            <p key={index} mix={toolStyle}>
              {/* The verb and the tool's name. */}
              called {tool.name}
              {/* ": value, value", or nothing when the call had no arguments. */}
              {describeArgs(tool.args)}
            </p>
          ))}
          {/* The answer's text, whitespace kept; an ellipsis until the first token. */}
          <div mix={textStyle}>{message.text || (waiting ? '…' : '')}</div>
          {/* The sources block, only when the answer cited passages. */}
          {sources.length > 0 && (
            // Separated from the text by a rule.
            <div mix={sourcesStyle}>
              {/* The block's small uppercase title. */}
              <span mix={sourcesTitleStyle}>Sources</span>
              {/* The passages, numbered in the server's order. */}
              <ol mix={sourcesListStyle}>
                {/* One item per passage: where it comes from, then a snippet of it. */}
                {sources.map((source, index) => (
                  // The index guards the key against a passage cited twice.
                  <li key={`${index}:${source.id}`} mix={sourceStyle}>
                    {/* Section, line range and score, in grey. */}
                    <span mix={sourceMetaStyle}>{describeSource(source)}</span>
                    {/* The passage's first SNIPPET_LENGTH characters, on one line. */}
                    <span mix={sourceTextStyle}>{snippet(source.text)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {/* Each error in its own red box; role="alert" has screen readers announce it. */}
          {errors.map((error, index) => (
            // Errors are only ever appended, so the index is a stable key.
            <p key={index} role="alert" mix={errorStyle}>
              {/* The message as the server or the panel wrote it. */}
              Error: {error.message}
            </p>
          ))}
          {/* The footer of an answer cut short by Stop or by the panel's teardown. */}
          {message.stopped && <footer mix={footerStyle}>Stopped</footer>}
          {/* The footer of a finished answer: the LLM's name and the seconds it took. */}
          {done && (
            // Shown only once the 'done' event arrived, so a streaming answer has no footer.
            <footer mix={footerStyle}>
              {/* The LLM and the time, milliseconds turned into seconds with one decimal. */}
              {done.model} · {(done.ms / 1000).toFixed(1)} s
            </footer>
          )}
        </>
      )
    }

    // The render function: the panel's whole tree, rebuilt from the state on every update.
    return () => (
      // The panel: a column that fills the aside; aria-label names it for assistive technology.
      <section mix={panelStyle} aria-label="Assistant">
        {/* The title row with the mode buttons. */}
        <header mix={headerStyle}>
          {/* The panel's title. */}
          <strong>Assistant</strong>
          {/* The mode buttons, grouped so assistive technology reads them as one control. */}
          <div role="group" aria-label="Mode">
            {/* One toggle button per mode; aria-pressed marks the current one and styles it. */}
            {MODES.map((m) => (
              // The mode id is the key and the label; the hint is the tooltip.
              <button
                // One stable element per mode.
                key={m.id}
                // Not a submit button: it must not send the form.
                type="button"
                // The tooltip explains the mode in a few words.
                title={m.hint}
                // True on the current mode; the style reads it to fill the button.
                aria-pressed={mode === m.id}
                // The style, and the click that switches the mode for the next question.
                mix={[
                  modeButtonStyle,
                  on('click', () => {
                    // The next question goes to this mode; past answers keep theirs.
                    mode = m.id
                    // Re-render: the pressed button and the input's placeholder change.
                    void handle.update()
                  }),
                ]}
              >
                {/* The label: LLM, RAG or AGENT. */}
                {m.id.toUpperCase()}
              </button>
            ))}
          </div>
        </header>

        {/* The conversation; aria-live has screen readers read new content as it arrives. */}
        <ol mix={[listStyle, ref((node) => (list = node))]} aria-live="polite">
          {/* One item per message, keyed by id so a bubble keeps its DOM as the list grows. */}
          {messages.map((message, index) => (
            // The bubble: blue on the right for the user, grey on the left for the assistant.
            <li key={message.id} mix={message.role === 'user' ? userStyle : assistantStyle}>
              {/* The user's text as typed; the assistant's parts from its events. */}
              {message.role === 'user'
                ? message.text
                : renderAssistant(message, index === messages.length - 1)}
            </li>
          ))}
        </ol>

        {/* The context chip, only while a clicked node waits for its question. */}
        {selected && (
          // A row with the panel's horizontal padding.
          <div mix={chipRowStyle}>
            {/* The chip: the node's label and a button to forget it. */}
            <span mix={chipStyle}>
              {/* "About:" and the clicked step's label. */}
              About: {selected.label}
              {/* The close button, labelled for assistive technology since × says nothing. */}
              <button
                // Not a submit button: it must not send the form.
                type="button"
                // The accessible name.
                aria-label="Clear the selected step"
                // The same words as the tooltip.
                title="Clear the selected step"
                // The round style, and the click that forgets the node.
                mix={[chipClearStyle, on('click', clearSelection)]}
              >
                {/* A multiplication sign as the close glyph. */}
                ×
              </button>
            </span>
          </div>
        )}

        {/* The question form: the input, and Send or Stop while an answer streams. */}
        <form
          // The style, and the submit handler that sends the question.
          mix={[
            formStyle,
            on('submit', (event) => {
              // No navigation: the panel sends the question itself.
              event.preventDefault()
              // The form element, to read its field and reset it.
              let form = event.currentTarget
              // The question field's value, trimmed; a missing field reads as empty.
              let question = String(new FormData(form).get('question') ?? '').trim()
              // Nothing to ask, or an answer still streaming: ignore the submit.
              if (!question || busy) return
              // Clear the field before the request, so the user can type the next question.
              form.reset()
              // Fire and forget: ask never rejects and renders its own progress.
              void ask(question)
            }),
          ]}
        >
          {/* The question field, disabled while an answer streams. */}
          <input
            // The name the submit handler reads from the FormData.
            name="question"
            // Browser suggestions would cover the answers.
            autocomplete="off"
            // No typing while busy; the submit handler guards the Enter key too.
            disabled={busy}
            // "Ask the LLM…", "Ask the RAG…" or "Ask the AGENT…".
            placeholder={`Ask the ${mode.toUpperCase()}…`}
            // The style, and the ref that lets ask and the click listener focus the field.
            mix={[inputStyle, ref((node) => (input = node))]}
          />
          {/* Stop while busy, Send otherwise; the keys make them two elements, not one reused. */}
          {busy ? (
            // Stop aborts the request in flight; type="button" keeps it from submitting.
            <button key="stop" type="button" mix={[stopStyle, on('click', stop)]}>
              {/* The label. */}
              Stop
            </button>
          ) : (
            // Send submits the form; Enter in the field does the same.
            <button key="send" type="submit" mix={sendStyle}>
              {/* The label. */}
              Send
            </button>
          )}
        </form>
      </section>
    )
  },
)

/**
 * Splits the NDJSON body into StreamEvent objects as they arrive. Bytes are decoded in streaming
 * mode so a multi-byte character cut by a chunk boundary survives; a line is parsed only once
 * its newline has arrived, and the last line is parsed when the body ends.
 *
 * Called by: ChatPanel: ask (this file)
 * @param body the response body; one JSON object per line, as app/ai/chat.ts writes it
 * @returns the events in order; the generator throws on malformed JSON or a failed read, and
 *   releases the reader either way
 */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  // The reader locks the stream to this generator.
  let reader = body.getReader()
  // One decoder for the whole body, so its state carries split characters over.
  let decoder = new TextDecoder()
  // Text received but not yet ended by a newline.
  let buffer = ''
  // Whatever happens, the lock is released at the end.
  try {
    // Read until the stream ends.
    while (true) {
      // The next chunk of bytes, or done when the server closed the body.
      let { value, done } = await reader.read()
      // The body ended; the buffer may still hold the last line.
      if (done) break
      // Decode and append; stream: true keeps a partial character for the next chunk.
      buffer += decoder.decode(value, { stream: true })
      // The complete lines, and in the last position whatever follows the final newline.
      let lines = buffer.split('\n')
      // Keep the incomplete tail for the next chunk.
      buffer = lines.pop() ?? ''
      // Each complete line is one event.
      for (let line of lines) {
        // Blank lines are not events.
        if (line.trim()) yield JSON.parse(line) as StreamEvent
      }
    }
    // A last line without a newline is still an event.
    if (buffer.trim()) yield JSON.parse(buffer) as StreamEvent
    // Release the lock, so the stream can be cancelled or collected.
  } finally {
    reader.releaseLock()
  }
}

/**
 * Describes the server's non-OK answer: its JSON error when it has one, the status otherwise.
 *
 * Called by: ChatPanel: ask (this file)
 * @param response a response with a status outside 2xx, or without a body
 * @returns a sentence for the error line; never throws, a non-JSON body gives the status alone
 */
async function describeFailure(response: Response): Promise<string> {
  // The server's error bodies are JSON with an "error" string; anything else is not JSON.
  try {
    // Read the body as JSON; the shape is checked below, not assumed.
    let body = (await response.json()) as { error?: unknown }
    // The server's own words, with the status.
    if (typeof body.error === 'string') {
      // Status, a colon, and what the server said.
      return `The server answered ${response.status}: ${body.error}`
    }
    // Not JSON (a proxy's HTML page, an empty body): fall through to the status alone.
  } catch {
    // Not JSON.
  }
  // The status alone.
  return `The server answered ${response.status}`
}

/**
 * Describes a tool call's arguments for its line: ": value, value", strings as they are, other
 * values as JSON; the keys are left out because the tool's name already says what they are.
 * For instance "called search_docs: how does chunking work".
 *
 * Called by: ChatPanel: renderAssistant (this file)
 * @param args the arguments object of a 'tool' event; may be empty
 * @returns the suffix for the tool line, or an empty string when there are no arguments
 */
function describeArgs(args: Record<string, unknown>): string {
  // The values only, each as text.
  let values = Object.values(args).map((value) =>
    typeof value === 'string' ? value : JSON.stringify(value),
  )
  // A colon and the values, or nothing.
  return values.length > 0 ? `: ${values.join(', ')}` : ''
}

/**
 * Describes where a source passage comes from: chapter, sub-heading when it differs from the
 * chapter, line range and similarity score. The same place cite() in app/ai/rag.ts names in the
 * prompt, with the score added and middle dots instead of commas.
 *
 * Called by: ChatPanel: renderAssistant (this file)
 * @param source a Source from a 'sources' event; lines is a [from, to] pair
 * @returns "chapter · lines from–to · 0.83", with ", sub-heading" after the chapter when the
 *   passage sits under one
 */
function describeSource(source: Source): string {
  // The passage's first and last line in the article's file.
  let [from, to] = source.lines
  // The chapter, with the sub-heading after it when the passage sits under one.
  let place =
    source.heading === source.chapter ? source.chapter : `${source.chapter}, ${source.heading}`
  // Middle dots separate the three parts; the score shows two decimals.
  return `${place} · lines ${from}–${to} · ${source.score.toFixed(2)}`
}

/**
 * Cuts a passage down to one line of at most SNIPPET_LENGTH characters for the sources list.
 *
 * Called by: ChatPanel: renderAssistant (this file)
 * @param text the passage; may contain newlines and runs of spaces
 * @returns the passage on one line, cut with an ellipsis when it is longer than the limit
 */
function snippet(text: string): string {
  // Newlines and runs of whitespace become single spaces; the ends are trimmed.
  let oneLine = text.replace(/\s+/g, ' ').trim()
  // Cut and mark with an ellipsis, or return whole.
  return oneLine.length > SNIPPET_LENGTH ? `${oneLine.slice(0, SNIPPET_LENGTH)}…` : oneLine
}

/**
 * The panel: a column as tall as its aside, so the list can scroll inside it (minHeight 0 lets
 * a flex child shrink below its content). The font is the page's.
 *
 * Called by: ChatPanel's render (this file), the <section>
 */
const panelStyle = css({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  fontFamily: 'system-ui, sans-serif',
  fontSize: '14px',
})

/**
 * The header row: the title at the left, the mode buttons at the right, a rule below.
 *
 * Called by: ChatPanel's render (this file), the <header>
 */
const headerStyle = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '8px',
  padding: '12px',
  borderBottom: '1px solid #d0d4d8',
})

/**
 * A mode button: a small outlined pill; the pressed one is filled with the page's blue, through
 * the aria-pressed selector.
 *
 * Called by: ChatPanel's render (this file), each mode <button>
 */
const modeButtonStyle = css({
  font: 'inherit',
  marginLeft: '4px',
  padding: '4px 8px',
  border: '1px solid #b0b4b8',
  borderRadius: '6px',
  background: 'transparent',
  cursor: 'pointer',
  '&[aria-pressed="true"]': { background: '#2dacf9', color: 'white', borderColor: '#2dacf9' },
})

/**
 * The message list: takes the remaining height and scrolls; bullets removed; a column of
 * bubbles with a gap.
 *
 * Called by: ChatPanel's render (this file), the <ol>
 */
const listStyle = css({
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  margin: 0,
  padding: '12px',
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
})

/**
 * What the two bubbles share: padding, rounded corners and a width that leaves the other side
 * free, so a bubble reads as a bubble. Spread into userStyle and assistantStyle.
 *
 * Called by: userStyle, assistantStyle (this file)
 */
const bubble = {
  padding: '8px 10px',
  borderRadius: '10px',
  maxWidth: '92%',
}

/**
 * The user's bubble: at the right, blue with white text; pre-wrap keeps the question's line
 * breaks.
 *
 * Called by: ChatPanel's render (this file), the <li> of a user message
 */
const userStyle = css({
  ...bubble,
  alignSelf: 'flex-end',
  background: '#2dacf9',
  color: 'white',
  whiteSpace: 'pre-wrap',
})
/**
 * The assistant's bubble: at the left, light grey; its text is styled by textStyle.
 *
 * Called by: ChatPanel's render (this file), the <li> of an assistant message
 */
const assistantStyle = css({ ...bubble, alignSelf: 'flex-start', background: '#eef1f4' })

/**
 * The answer's text: line breaks kept, and long tokens (URLs, identifiers) wrapped anywhere so
 * they cannot widen the bubble.
 *
 * Called by: ChatPanel: renderAssistant (this file), the text <div>
 */
const textStyle = css({ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' })

/**
 * A tool call line: small, monospace and grey, like a log line above the answer.
 *
 * Called by: ChatPanel: renderAssistant (this file), each tool <p>
 */
const toolStyle = css({
  margin: '0 0 4px',
  fontSize: '12px',
  fontFamily: 'ui-monospace, monospace',
  color: '#6b7075',
})

/**
 * The sources block: separated from the text by a rule.
 *
 * Called by: ChatPanel: renderAssistant (this file), the sources <div>
 */
const sourcesStyle = css({
  marginTop: '8px',
  paddingTop: '6px',
  borderTop: '1px solid #d0d4d8',
})

/**
 * The "Sources" title: a small uppercase label in grey.
 *
 * Called by: ChatPanel: renderAssistant (this file), the title <span>
 */
const sourcesTitleStyle = css({
  display: 'block',
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: '#6b7075',
})

/**
 * The numbered list of passages: small text, numbers indented, a gap between items.
 *
 * Called by: ChatPanel: renderAssistant (this file), the sources <ol>
 */
const sourcesListStyle = css({
  margin: '4px 0 0',
  paddingLeft: '18px',
  fontSize: '12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
})

/**
 * One passage: slightly tighter lines than the answer's text.
 *
 * Called by: ChatPanel: renderAssistant (this file), each source <li>
 */
const sourceStyle = css({ lineHeight: 1.35 })
/**
 * The passage's section, lines and score, on its own line in grey.
 *
 * Called by: ChatPanel: renderAssistant (this file), the meta <span> of a source
 */
const sourceMetaStyle = css({ display: 'block', color: '#6b7075' })
/**
 * The passage's snippet, on its own line in the text color.
 *
 * Called by: ChatPanel: renderAssistant (this file), the text <span> of a source
 */
const sourceTextStyle = css({ display: 'block', color: '#313539' })

/**
 * An error line: a red box under the text; long messages wrap anywhere.
 *
 * Called by: ChatPanel: renderAssistant (this file), each error <p>
 */
const errorStyle = css({
  margin: '6px 0 0',
  padding: '6px 8px',
  borderRadius: '6px',
  background: '#fde8e8',
  color: '#a12622',
  overflowWrap: 'anywhere',
})

/**
 * The footer of an answer ("Stopped", or the LLM and the time): small and grey.
 *
 * Called by: ChatPanel: renderAssistant (this file), the <footer>
 */
const footerStyle = css({
  marginTop: '6px',
  fontSize: '11px',
  color: '#6b7075',
})

/**
 * The row that holds the context chip, aligned with the list's padding.
 *
 * Called by: ChatPanel's render (this file), the chip row <div>
 */
const chipRowStyle = css({
  padding: '0 12px',
})

/**
 * The context chip: a light blue pill with the page's blue border and dark blue text; the
 * padding is lighter on the right, where the close button sits.
 *
 * Called by: ChatPanel's render (this file), the chip <span>
 */
const chipStyle = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '3px 6px 3px 10px',
  borderRadius: '999px',
  border: '1px solid #2dacf9',
  background: '#e8f5fe',
  color: '#1b6fa3',
  fontSize: '12px',
})

/**
 * The chip's close button: borderless and round, inheriting the chip's color; filled blue on
 * hover.
 *
 * Called by: ChatPanel's render (this file), the chip's clear <button>
 */
const chipClearStyle = css({
  font: 'inherit',
  fontSize: '14px',
  lineHeight: 1,
  padding: '0 4px',
  border: 0,
  borderRadius: '999px',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  '&:hover': { background: '#2dacf9', color: 'white' },
})

/**
 * The question form: input and button side by side, a rule above.
 *
 * Called by: ChatPanel's render (this file), the <form>
 */
const formStyle = css({
  display: 'flex',
  gap: '8px',
  padding: '12px',
  borderTop: '1px solid #d0d4d8',
})

/**
 * The question field: takes the row's width; greyed out while an answer streams.
 *
 * Called by: ChatPanel's render (this file), the <input>
 */
const inputStyle = css({
  flex: '1 1 auto',
  font: 'inherit',
  padding: '8px',
  '&:disabled': { background: '#f4f6f8' },
})

/**
 * The Send button: the browser's default look with the panel's font and padding.
 *
 * Called by: ChatPanel's render (this file), the Send <button>
 */
const sendStyle = css({ font: 'inherit', padding: '8px 12px', cursor: 'pointer' })

/**
 * The Stop button: the same size as Send, in the error red, so it reads as "interrupt".
 *
 * Called by: ChatPanel's render (this file), the Stop <button>
 */
const stopStyle = css({
  font: 'inherit',
  padding: '8px 12px',
  cursor: 'pointer',
  border: '1px solid #a12622',
  borderRadius: '4px',
  background: '#fde8e8',
  color: '#a12622',
})
