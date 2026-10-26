// agent.ts: the agent mode, retrieval first, then a short tool loop over Ollama's tool calling.
//
// Objective
//   Answer a question in 'agent' mode with a local model that may call tools. A small local
//   model orchestrates three tools badly (measured: it searched in 11 runs of 12 but highlighted
//   in 2 of 6), so the loop leaves it one decision. The loop itself retrieves the passages for
//   the question and puts them, with the canvas's steps, in front of the LLM. The LLM then
//   only has to highlight the step the question is about, and answer. Each round sends the
//   conversation with the tools; the LLM either answers, and its tokens are streamed, or asks
//   for tools, which run and come back as tool messages for the next round. After
//   MAX_TOOL_CALLS rounds with tool calls, one last round without tools makes it answer with
//   what it has.
//
//   Tools:
//   - highlight_node(id): yields { type: 'ui', action: 'highlight-node', nodeId } so the panel
//     asks the canvas to highlight that node.
//   - search_docs(query): the RAG's retrieve(), for more passages; yields a 'sources'
//     event.
//   - get_flow(): the canvas's nodes and edges as text; the system prompt already carries it.
//
// Dependencies
//   ../fixtures/rag-pipeline.ts: ragPipeline, the graph behind the default deps.
//   ./ollama.ts: chat, the streaming call to Ollama (port 11434), and its ChatChunk and
//     ChatOptions types.
//   ./rag.ts: retrieve, the search over Qdrant (port 6335) with Ollama embeddings, and cite,
//     the "section, lines" label of a passage.
//   ./types.ts: the shared ChatMessage, ChatRequest, FlowGraph, Source, StreamEvent, ToolCall
//     and ToolDefinition types.
//
// Consumers
//   app/ai/chat.ts: runAgent, for the 'agent' mode of POST /api/chat.
//   app/actions/public/chat-panel.tsx: tools, the tool definitions.
//   app/ai/agent.test.ts: MAX_TOOL_CALLS, AGENT_SYSTEM_PROMPT, tools, runAgent, systemPrompt,
//     toolCallInText and describeFlow, with fake deps instead of Ollama and Qdrant.
//
// How it relates to them
//   runAgent is an async generator of StreamEvent; chat.ts turns it into NDJSON lines without
//   looking inside. Every outside call goes through AgentDeps, so tests run the loop with no
//   service. The tool names here are the names the LLM sees and the panel shows; renaming one
//   changes the prompt, the tests and the panel together.
import { ragPipeline } from '../fixtures/rag-pipeline.ts'
import { chat, type ChatChunk, type ChatOptions } from './ollama.ts'
import { cite, retrieve } from './rag.ts'
import type {
  ChatMessage,
  ChatRequest,
  FlowGraph,
  Source,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from './types.ts'

/**
 * Rounds in which the LLM may ask for tools; after them it must answer without tools.
 *
 * Called by: runAgent (this file), app/ai/agent.test.ts
 */
export const MAX_TOOL_CALLS = 4

/**
 * Passages per search: how many retrieve() returns to the LLM for one query.
 *
 * Called by: searchDocs (this file)
 */
const SEARCH_LIMIT = 3
/**
 * The most characters of each passage the LLM reads; longer passages are cut with an ellipsis.
 *
 * Called by: searchDocs (this file)
 */
const PASSAGE_LENGTH = 1200

/**
 * Tokens are held back while a round's text still looks like a tool call written as text; past
 * this length it is an answer and the held tokens are released.
 *
 * Called by: mayBeToolCall (this file)
 */
const HOLD_LIMIT = 600

/**
 * The system prompt of the agent mode. Short on purpose: prompt processing is the slow part on
 * this CPU. The canvas's steps are appended to it by systemPrompt, so the LLM never has to ask
 * for them. It gives no example name for the citation: a small LLM copies an example instead of
 * reading the passage's label.
 *
 * Called by: systemPrompt (this file), app/ai/agent.test.ts
 */
export const AGENT_SYSTEM_PROMPT =
  'You are the assistant of a UI that teaches retrieval-augmented generation (RAG). The user ' +
  'gives you numbered passages from an article about it and a question. If the question is ' +
  'about one of the canvas steps listed below, call highlight_node with the id of that step ' +
  'before you answer. Then answer from the passages, briefly, in English, naming in ' +
  'parentheses the section of each passage you use, copied from its label; if the passages do ' +
  'not cover the question, say so. You may call search_docs for more passages.'

/**
 * What the loop needs from the outside; tests replace them, chat.ts takes the defaults.
 *
 * Called by: defaultDeps, runAgent, runTool and searchDocs (this file); no other file
 *   names it
 */
export interface AgentDeps {
  // The streaming model call, with the tools and the abort signal as options.
  chat: (messages: ChatMessage[], options?: ChatOptions) => AsyncGenerator<ChatChunk>
  // The semantic search over the article: the closest passages for a question.
  retrieve: (question: string, limit?: number) => Promise<Source[]>
  // The graph the canvas shows: its steps go into the prompt, its ids are what highlight_node
  // accepts.
  graph: FlowGraph
}

/**
 * The real dependencies: Ollama's chat, the RAG's retrieve and the demo's graph.
 *
 * Called by: runAgent (this file), as the default of its deps parameter; no other file names it
 */
export const defaultDeps: AgentDeps = { chat, retrieve, graph: ragPipeline }

/**
 * The tool definitions sent to Ollama with every round that may call tools, in Ollama's
 * function-calling shape. highlight_node takes the id of a step; search_docs takes a
 * query; get_flow takes nothing. The names and parameter names are what runTool, normalize and
 * asCall match on.
 *
 * Called by: runAgent, normalize, asCall and runTool (this file), handed to app/ai/ollama.ts:
 *   chat as the tools option; app/actions/public/chat-panel.tsx, app/ai/agent.test.ts,
 *   app/ai/ollama.test.ts
 */
export const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'highlight_node',
      description: 'Highlights one step in the canvas, by its id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id of the step, such as "retrieval"' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_docs',
      description:
        'Searches the article on retrieval-augmented generation and returns the closest ' +
        'passages with their section.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, as a short question or phrase' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_flow',
      description: 'Returns the steps and transitions of the RAG pipeline shown in the canvas.',
      parameters: { type: 'object', properties: {} },
    },
  },
]

/**
 * The agent loop. The question arrives with the selected node already written into it by
 * chat.ts (withContext), so the context is not repeated here. Retrieval runs first, by the loop;
 * then up to MAX_TOOL_CALLS rounds with tools, and a last one without them if needed.
 *
 * Called by: app/ai/chat.ts: answer (mode 'agent'), app/ai/agent.test.ts
 * @param question the user's question, with the selected step appended by chat.ts; not empty
 * @param _context the UI context of the request; unused, chat.ts already wrote the selected
 *   node into the question
 * @param signal aborts the loop between rounds and tool calls, and the LLM calls themselves
 * @param deps the chat, retrieve and graph to use; the defaults talk to Ollama and Qdrant
 * @returns a stream of StreamEvent: 'tool' before each tool runs, 'sources' and 'ui' from the
 *   tools, 'token' for the answer; throws the abort reason when the signal fires, and lets
 *   errors from deps.chat and deps.retrieve propagate
 */
export async function* runAgent(
  question: string,
  _context: ChatRequest['context'],
  signal?: AbortSignal,
  deps: AgentDeps = defaultDeps,
): AsyncGenerator<StreamEvent> {
  // Retrieval first, by the loop, never left to the LLM: announce the search as a tool event.
  yield { type: 'tool', name: 'search_docs', args: { query: question } }
  // Search for the question itself; the text goes to the LLM, the events to the panel.
  let found = await searchDocs(question, deps)
  // The 'sources' event, so the panel lists the passages before the answer starts.
  yield* found.events

  // The conversation: the system prompt with the canvas's steps, then the passages and question.
  let messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(deps.graph) },
    { role: 'user', content: `Passages:\n\n${found.text}\n\nQuestion: ${question}` },
  ]

  // Up to MAX_TOOL_CALLS rounds in which the LLM may ask for tools.
  for (let round = 0; round < MAX_TOOL_CALLS; round++) {
    // Stop at once if the client went away.
    signal?.throwIfAborted()
    // One round: the LLM's text is streamed as tokens; the tool calls it asked for come back.
    let { content, toolCalls } = yield* complete(deps.chat(messages, { tools, signal }))
    // No parsed tool call: the text is either a call written as text or the final answer.
    if (toolCalls.length === 0) {
      // A call written as text counts as a call; Ollama did not parse it.
      let written = toolCallInText(content)
      // Plain text is the answer; complete() already streamed its tokens, so the loop is done.
      if (!written) return
      // Treat the written call as if the LLM had asked for it properly.
      toolCalls = [written]
    }

    // Arguments in the object shape the tools and the LLM expect.
    let calls = toolCalls.map(normalize)
    // The LLM's turn joins the conversation, with its calls, before the tool results.
    messages.push({ role: 'assistant', content, tool_calls: calls })
    // Run each call in order; every result becomes a tool message for the next round.
    for (let call of calls) {
      // Stop between tools if the client went away.
      signal?.throwIfAborted()
      // The tool's name and its arguments, already an object.
      let { name, arguments: args } = call.function
      // Tell the panel which tool runs, so it can show it.
      yield { type: 'tool', name, args }
      // Run the tool: text for the LLM, events for the panel.
      let { text, events } = await runTool(name, args, deps)
      // Forward the tool's events ('sources', 'ui') to the panel.
      yield* events
      // The tool's result, as the tool message the LLM reads in the next round.
      messages.push({ role: 'tool', content: text, tool_name: name })
    }
  }

  // The LLM asked for tools in every round it had; without them it has to answer.
  signal?.throwIfAborted()
  // The last round, with no tools offered: its text is the answer and is streamed as tokens.
  yield* complete(deps.chat(messages, { signal }))
}

/**
 * The full system prompt: AGENT_SYSTEM_PROMPT followed by the canvas's steps and transitions.
 *
 * Called by: runAgent (this file), app/ai/agent.test.ts
 * @param graph the graph the canvas shows
 * @returns the prompt text, with describeFlow(graph) after "The canvas shows:"
 */
export function systemPrompt(graph: FlowGraph): string {
  // The fixed instructions, a blank line, then the graph as text.
  return `${AGENT_SYSTEM_PROMPT}\n\nThe canvas shows:\n${describeFlow(graph)}`
}

/**
 * What one round of the LLM produced.
 *
 * Called by: complete (this file), as its return value
 */
interface Round {
  // The whole text of the round, streamed or held.
  content: string
  // The tool calls Ollama parsed from the LLM's output; empty when it answered in text.
  toolCalls: ToolCall[]
}

/**
 * Streams one round's text as tokens; returns the text and the tool calls the LLM asked for.
 * While the text so far could still be a tool call written as text, the tokens are held: they
 * are released as soon as it cannot be one, or at the end of the round if it was an answer
 * after all, and dropped if it was a call.
 *
 * Called by: runAgent (this file)
 * @param chunks the LLM's stream from deps.chat: pieces of text and the parsed tool calls
 * @returns the yielded 'token' events, then a Round with the whole text and the parsed calls;
 *   an error in the stream propagates to the caller
 */
async function* complete(chunks: AsyncGenerator<ChatChunk>): AsyncGenerator<StreamEvent, Round> {
  // The round's text so far.
  let content = ''
  // The tool calls Ollama parsed.
  let toolCalls: ToolCall[] = []
  // Tokens not yet sent, while the text may still be a tool call written as text.
  let held: string[] = []
  // True until the text can no longer be a tool call.
  let holding = true
  // Read the stream chunk by chunk as Ollama sends it.
  for await (let chunk of chunks) {
    // A chunk with text: accumulate it and decide whether to send it.
    if (chunk.content) {
      // Add the piece to the round's text.
      content += chunk.content
      // The text just stopped looking like a tool call: release everything held so far.
      if (holding && !mayBeToolCall(content)) {
        // From here on tokens go straight out.
        holding = false
        // Send the held tokens in order.
        for (let text of held) yield { type: 'token', text }
        // Nothing is held any more.
        held = []
      }
      // Still undecided: keep the piece back.
      if (holding) held.push(chunk.content)
      // Decided it is an answer: send the piece at once.
      else yield { type: 'token', text: chunk.content }
    }
    // Collect the tool calls Ollama parsed, from whichever chunks carry them.
    if (chunk.toolCalls) toolCalls.push(...chunk.toolCalls)
  }
  // The round ended undecided with no call, parsed or written: it was a short answer after all.
  if (holding && toolCalls.length === 0 && !toolCallInText(content)) {
    // Send the whole held answer.
    for (let text of held) yield { type: 'token', text }
  }
  // The round's text and calls, for runAgent to decide the next step.
  return { content, toolCalls }
}

/**
 * Whether the text so far could still turn into a tool call written as text. Text that starts
 * like JSON or a <tool> tag may turn out to be a call. A complete leading object decides it at
 * once; an incomplete one is given HOLD_LIMIT characters to close.
 *
 * Called by: complete (this file)
 * @param content the round's text so far, possibly empty
 * @returns true while the tokens must be held, false once the text is surely an answer
 */
function mayBeToolCall(content: string): boolean {
  // Leading whitespace decides nothing.
  let text = content.trimStart()
  // Nothing yet: anything can follow.
  if (text === '') return true
  // A <tool> tag: a call once the closing tag is there, and possibly one until HOLD_LIMIT.
  if (text.startsWith('<tool')) return CLOSING.test(text) || text.length <= HOLD_LIMIT
  // Not JSON and not a tag: an answer.
  if (!text.startsWith('{')) return false
  // The object the text starts with, if it is closed already.
  let lead = leadingObject(text)
  // Still open: hold until it closes or the text grows past HOLD_LIMIT.
  if (lead === undefined) return text.length <= HOLD_LIMIT
  // Closed: a call only if it names a known tool.
  return asCall(lead) !== undefined
}

/**
 * Puts a tool call's arguments in the object shape. Ollama gives the arguments as an object;
 * some models send them as a JSON string, or as a bare value for the tool's one parameter. The
 * call goes back to the LLM with an object.
 *
 * Called by: runAgent (this file)
 * @param call a tool call as Ollama parsed it or as toolCallInText found it
 * @returns the same call with its arguments as a record; anything else becomes an empty record
 */
function normalize(call: ToolCall): ToolCall {
  // The tool's name, kept as is.
  let name = call.function.name
  // The arguments in whatever shape the LLM sent them.
  let value: unknown = call.function.arguments
  // A string is either JSON to parse or a bare value for the one parameter.
  if (typeof value === 'string') {
    // Try the JSON reading first.
    try {
      // Replace the string by what it encodes.
      value = JSON.parse(value)
      // Not JSON: it is the bare value of the tool's first required parameter.
    } catch {
      // The tool the LLM named, if it exists.
      let tool = tools.find((t) => t.function.name === name)
      // Its first required parameter, such as "id" or "query".
      let [parameter] = tool?.function.parameters.required ?? []
      // Wrap the bare value under that parameter; no parameter means no arguments.
      value = parameter ? { [parameter]: value } : {}
    }
  }
  // Only a record is accepted as arguments.
  return { function: { name, arguments: isRecord(value) ? value : {} } }
}

/**
 * A tool call inside <tool> or <tool_call> tags, with the JSON object as the captured group.
 *
 * Called by: toolCallInText (this file)
 */
const WRAPPED = /<tool(?:_call)?>\s*([\s\S]*?)\s*<\/tool(?:_call)?>/
/**
 * The closing tag of a wrapped call: once it is there, the text is surely a call.
 *
 * Called by: mayBeToolCall (this file)
 */
const CLOSING = /<\/tool(?:_call)?>/

/**
 * Finds a tool call the LLM wrote as text. A small model sometimes writes the call as text,
 * which Ollama does not parse: a JSON object at the start of its answer, sometimes followed by
 * text it made up without the result, or an object inside <tool> tags, sometimes after a
 * preamble. Both count as the call, and the text around them is dropped. A bare object in the
 * middle of prose is not a call.
 *
 * Called by: runAgent and complete (this file), app/ai/agent.test.ts
 * @param content the whole text of a round
 * @returns the call of a known tool, or undefined when the text is an answer
 */
export function toolCallInText(content: string): ToolCall | undefined {
  // Surrounding whitespace never matters.
  let text = content.trim()
  // The tagged form first, anywhere in the text.
  let wrapped = WRAPPED.exec(text)
  // Tags found: a call if what they wrap names a known tool.
  if (wrapped) {
    // The wrapped object as a call.
    let call = asCall(wrapped[1]!)
    // A known tool: done.
    if (call) return call
  }
  // Otherwise the object the text starts with, if any.
  let lead = leadingObject(text)
  // No leading object means an answer; a leading object is a call only if it names a tool.
  return lead === undefined ? undefined : asCall(lead)
}

/**
 * The JSON object the text starts with, up to its matching brace; undefined when it is not
 * closed yet, or the text does not start with one.
 *
 * Called by: mayBeToolCall and toolCallInText (this file)
 * @param text the LLM's text, already trimmed at the start
 * @returns the object's source text, or undefined
 */
function leadingObject(text: string): string | undefined {
  // Only text that starts with a brace can have a leading object.
  if (!text.startsWith('{')) return undefined
  // Brace depth, so nested objects do not end the scan early.
  let depth = 0
  // Inside a JSON string, where braces do not count.
  let inString = false
  // Right after a backslash inside a string, where a quote does not end it.
  let escaped = false
  // Walk the characters until the first brace closes.
  for (let i = 0; i < text.length; i++) {
    // The character at hand.
    let ch = text[i]!
    // Inside a string: only track escapes and the closing quote.
    if (inString) {
      // The escaped character is consumed, whatever it is.
      if (escaped) escaped = false
      // A backslash escapes the next character.
      else if (ch === '\\') escaped = true
      // An unescaped quote ends the string.
      else if (ch === '"') inString = false
      // Nothing else matters inside a string.
      continue
    }
    // A quote opens a string.
    if (ch === '"') inString = true
    // An opening brace goes one level deeper.
    else if (ch === '{') depth++
    // The brace that brings the depth back to zero closes the leading object.
    else if (ch === '}' && --depth === 0) return text.slice(0, i + 1)
  }
  // The object is not closed yet.
  return undefined
}

/**
 * The object as a call of a known tool, in the {name, arguments} or {function: {…}} shape.
 *
 * Called by: mayBeToolCall and toolCallInText (this file)
 * @param json the source text of one object
 * @returns the call, or undefined when the text is not JSON, not an object, or not a known tool
 */
function asCall(json: string): ToolCall | undefined {
  // What the JSON decodes to, if it is JSON at all.
  let parsed: unknown
  // The LLM's text is not trusted to be valid JSON.
  try {
    // Decode the text.
    parsed = JSON.parse(json)
    // Not valid JSON: not a call.
  } catch {
    // Give up on this text.
    return undefined
  }
  // A call is an object, never an array or a scalar.
  if (!isRecord(parsed)) return undefined
  // Accept both {name, arguments} and {function: {name, arguments}}.
  let call = isRecord(parsed.function) ? parsed.function : parsed
  // The tool the LLM named.
  let name = call.name
  // Only a known tool's name makes it a call.
  if (typeof name !== 'string' || !tools.some((t) => t.function.name === name)) return undefined
  // Arguments must be an object; anything else means none.
  let args = isRecord(call.arguments) ? call.arguments : {}
  // The call in the shape the rest of the loop uses.
  return { function: { name, arguments: args } }
}

/**
 * Whether a value is a plain object (not null, not an array), usable as a record.
 *
 * Called by: normalize and asCall (this file)
 * @param value anything
 * @returns true for a plain object; narrows the type to Record<string, unknown>
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  // Objects minus null and arrays.
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * What a tool run produces, for the LLM and for the panel.
 *
 * Called by: runTool, searchDocs and highlightNode (this file), as their return value
 */
interface ToolResult {
  // What goes back to the LLM as the tool message.
  text: string
  // What goes to the panel: sources to list, a node to highlight.
  events: StreamEvent[]
}

/**
 * Runs one tool by name. An unknown name is answered with the list of real names, so the LLM
 * can correct itself instead of failing the round.
 *
 * Called by: runAgent (this file)
 * @param name the tool's name as the LLM gave it
 * @param args its arguments, already an object (see normalize)
 * @returns the tool's text for the LLM and its events for the panel; never throws for a bad
 *   name or argument, only for a failing retrieve
 */
async function runTool(
  name: string,
  args: Record<string, unknown>,
  deps: AgentDeps,
): Promise<ToolResult> {
  // Dispatch on the tool's name.
  switch (name) {
    // More passages from the article, for the query the LLM chose.
    case 'search_docs':
      // The passages as text, and a 'sources' event for the panel.
      return searchDocs(argument(args, 'query'), deps)
    // The canvas as text; the system prompt already has it, but the LLM may ask again.
    case 'get_flow':
      // No event: the panel has nothing to show for it.
      return { text: describeFlow(deps.graph), events: [] }
    // Highlight one step in the canvas.
    case 'highlight_node':
      // A 'ui' event when the id is known, an error text for the LLM when it is not.
      return highlightNode(argument(args, 'id'), deps.graph)
    // A name the LLM made up: tell it the real names so it can retry.
    default: {
      // The valid names, comma separated.
      let names = tools.map((t) => t.function.name).join(', ')
      // The correction as the tool's text; no event.
      return { text: `unknown tool "${name}"; the tools are ${names}`, events: [] }
    }
  }
}

/**
 * The named argument as text; a model that renames the parameter still gets its first string
 * value.
 *
 * Called by: runTool (this file)
 * @param args the call's arguments
 * @param key the parameter's name in the tool definition
 * @returns the trimmed text, or '' when there is no usable value
 */
function argument(args: Record<string, unknown>, key: string): string {
  // The named value, or the first string value under any other name.
  let value = args[key] ?? Object.values(args).find((v) => typeof v === 'string')
  // Nothing usable gives ''; anything else is turned into trimmed text.
  return value === undefined || value === null ? '' : String(value).trim()
}

/**
 * The search tool: "[1] Process, lines 17-29:" followed by the passage, for each of the
 * closest passages.
 *
 * Called by: runAgent and runTool (this file)
 * @param query what to search for; '' is refused without searching
 * @param deps the retrieve to use
 * @returns the numbered passages as text (or a sentence saying none were found) and a 'sources'
 *   event with the same passages; errors from retrieve propagate
 */
async function searchDocs(query: string, deps: AgentDeps): Promise<ToolResult> {
  // An empty query would match nothing useful; tell the LLM instead of searching.
  if (!query) return { text: 'search_docs needs a query', events: [] }
  // The closest passages; the slice guards against a retrieve that ignores the limit.
  let sources = (await deps.retrieve(query, SEARCH_LIMIT)).slice(0, SEARCH_LIMIT)
  // One numbered block per passage: "[n] section, lines:" then the text, cut at PASSAGE_LENGTH.
  let passages = sources.map((s, i) => `[${i + 1}] ${cite(s)}:\n${trim(s.text, PASSAGE_LENGTH)}`)
  // The LLM reads either the blocks or a plain sentence saying nothing was found.
  let text = sources.length === 0 ? `No passages found for "${query}".` : passages.join('\n\n')
  // The panel gets the sources to list them.
  return { text, events: [{ type: 'sources', sources }] }
}

/**
 * The graph as text for the LLM: the title, then "id: label — description" per step and
 * "source -> target (label)" per edge.
 *
 * Called by: systemPrompt and runTool (this file), app/ai/agent.test.ts
 * @param graph the graph the canvas shows
 * @returns one line per item, joined with newlines
 */
export function describeFlow(graph: FlowGraph): string {
  // One line per node, with the id the LLM must use in highlight_node.
  let steps = graph.nodes.map((n) => `${n.id}: ${n.label} — ${n.description}`)
  // One line per edge, with its label in parentheses when it has one.
  let transitions = graph.edges.map(
    (e) => `${e.source} -> ${e.target}${e.label ? ` (${e.label})` : ''}`,
  )
  // Title, the steps under their heading, the transitions under theirs.
  return [graph.title, 'Steps:', ...steps, 'Transitions:', ...transitions].join('\n')
}

/**
 * The highlight tool: finds the node and yields the 'ui' event the panel forwards to the canvas.
 * The id as the system prompt lists it; a label, or a different case, is accepted too.
 *
 * Called by: runTool (this file)
 * @param id the step's id or label, in any case
 * @param graph the graph whose nodes are searched
 * @returns a confirmation and the 'ui' event, or the list of valid ids and no event
 */
function highlightNode(id: string, graph: FlowGraph): ToolResult {
  // For the case-insensitive matches.
  let wanted = id.toLowerCase()
  // The exact id first; then the id or the label ignoring case.
  let node =
    graph.nodes.find((n) => n.id === id) ??
    graph.nodes.find((n) => n.id.toLowerCase() === wanted || n.label.toLowerCase() === wanted)
  // Nothing matched: tell the LLM which ids exist.
  if (!node) {
    // The valid ids, comma separated.
    let ids = graph.nodes.map((n) => n.id).join(', ')
    // The correction as the tool's text; no event.
    return { text: `unknown node id "${id}"; valid ids: ${ids}`, events: [] }
  }
  // Confirm to the LLM, and ask the panel to highlight the node by its real id.
  return {
    text: `highlighted ${node.label}`,
    events: [{ type: 'ui', action: 'highlight-node', nodeId: node.id }],
  }
}

/**
 * Cuts text to a length, ending it with an ellipsis when it was longer.
 *
 * Called by: searchDocs (this file)
 * @param text the text to cut
 * @param max the most characters allowed, ellipsis included
 * @returns the text unchanged, or its first max - 1 characters and "…"
 */
function trim(text: string, max: number): string {
  // Short enough as is, or cut with room for the ellipsis.
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
