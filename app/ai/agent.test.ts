// agent.test.ts: the agent loop against a scripted chat and a fake retrieve, with no network.
//
// Objective
//   Prove the agent's behavior without Ollama or Qdrant: the tools it declares and the prompt it
//   writes; that runAgent retrieves first and hands the LLM the passages, the canvas steps and
//   the tools; that it runs tool calls, feeds results back and emits ui events for highlights;
//   that it recognizes calls a small model writes as text instead of structured tool calls, and
//   releases held text when it turns out to be an answer; that it caps the tool rounds, answers
//   unknown tools and node ids with guidance, and stops on abort. The LLM is replaced by a
//   script of rounds, so every path is deterministic.
//
// Dependencies
//   remix/assert: deepEqual, equal, match, doesNotMatch, ok and rejects, the assertions.
//   remix/test: describe and it, the runner's grouping and cases.
//   ./agent.ts: AGENT_SYSTEM_PROMPT, MAX_TOOL_CALLS, describeFlow, runAgent, systemPrompt,
//   toolCallInText and tools, under test.
//   ./ollama.ts: the types ChatChunk and ChatOptions, so the scripted chat has the real signature.
//   ./types.ts: ChatMessage, FlowGraph, Source, StreamEvent and ToolCall, the shapes exchanged.
//   No external service: chat and retrieve are injected through runAgent's deps argument.
//
// Consumers
//   `npm test` (package.json) runs it; nothing imports it.
//   app/ai/agent.ts is the module it covers: a change to the prompt, the tools, the event order
//   or the text-call detection must keep these cases green.
//
// How it relates to them
//   The event sequences pinned here (tool, sources, ui, token) are what handleChat streams and
//   what the chat panel renders; the messages pinned here are what Ollama receives. The scripted
//   chat honors the abort signal as the real one does, so the abort case is faithful.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  AGENT_SYSTEM_PROMPT,
  MAX_TOOL_CALLS,
  describeFlow,
  runAgent,
  systemPrompt,
  toolCallInText,
  tools,
} from './agent.ts'
import type { ChatChunk, ChatOptions } from './ollama.ts'
import type { ChatMessage, FlowGraph, Source, StreamEvent, ToolCall } from './types.ts'

/**
 * A three-step pipeline with a start, a step and an end node and one labeled edge: small enough
 * to write its textual description by hand in FLOW_TEXT, and the graph the agent is given in
 * every run. It is not the app's own fixture, so these cases do not change when that one does.
 *
 * Called by: this file: run (as the agent's graph), the agent.tools cases, the first runAgent case
 */
const graph: FlowGraph = {
  title: 'A mini RAG pipeline, test graph',
  nodes: [
    {
      id: 'question',
      label: 'Question',
      description: 'The user asks.',
      kind: 'start',
      position: { x: 0, y: 0 },
    },
    {
      id: 'retrieval',
      label: 'Retrieval',
      description: 'The closest passages are found.',
      kind: 'step',
      position: { x: 1, y: 0 },
    },
    {
      id: 'answer',
      label: 'Answer',
      description: 'The LLM replies.',
      kind: 'end',
      position: { x: 2, y: 0 },
    },
  ],
  edges: [
    { id: 'e1', source: 'question', target: 'retrieval' },
    { id: 'e2', source: 'retrieval', target: 'answer', label: 'passages' },
  ],
}

/**
 * The description of graph the agent must write: title, the steps with their descriptions, the
 * transitions with their labels. It is what the LLM reads and what get_flow returns.
 *
 * Called by: this file: the "canvas steps" case, the "cap" case
 */
const FLOW_TEXT = [
  'A mini RAG pipeline, test graph',
  'Steps:',
  'question: Question — The user asks.',
  'retrieval: Retrieval — The closest passages are found.',
  'answer: Answer — The LLM replies.',
  'Transitions:',
  'question -> retrieval',
  'retrieval -> answer (passages)',
].join('\n')

/**
 * A retrieved passage from the sub-section "Chunking" of the chapter "Improvements", the best
 * match the fake retrieve returns.
 *
 * Called by: this file: run (default sources), PASSAGES, the first runAgent case, the abort case
 */
const chunking: Source = {
  id: 'improvements-3',
  chapter: 'Improvements',
  heading: 'Chunking',
  lines: [69, 71],
  text: 'Chunking involves various strategies for breaking up the data into vectors.',
  score: 0.81,
}

/**
 * A second retrieved passage, from the chapter "Process", so the numbering of passages can be
 * checked.
 *
 * Called by: this file: run (default sources), PASSAGES, the first runAgent case
 */
const stages: Source = {
  id: 'process-1',
  chapter: 'Process',
  heading: 'RAG key stages',
  lines: [21, 25],
  text: 'Given a user query, a document retriever is first called to select the documents.',
  score: 0.52,
}

/**
 * The question every run asks; also the query of the agent's first, automatic search.
 *
 * Called by: this file: PASSAGES, run, several runAgent cases
 */
const QUESTION = 'How does retrieval find the closest passages?'

/**
 * The user turn the agent must build from the two passages and the question: the same layout
 * as the RAG mode's, so the LLM sees one format in both modes.
 *
 * Called by: this file: the first runAgent case
 */
const PASSAGES =
  `Passages:\n\n[1] Improvements, Chunking, lines 69-71:\n${chunking.text}\n\n` +
  `[2] Process, RAG key stages, lines 21-25:\n${stages.text}\n\nQuestion: ${QUESTION}`

/**
 * One scripted answer of the LLM: its text, in pieces, then the tool calls it asks for. Either
 * part may be absent; a round with neither is an empty answer.
 *
 * Called by: this file: scriptedChat, run, the "cap" case
 */
interface Round {
  // The answer's text, in the pieces the stream delivers.
  tokens?: string[]
  // The structured tool calls the LLM asks for after its text.
  toolCalls?: ToolCall[]
}

/**
 * What the agent passed to chat on one call: the messages at that moment and the options, so a
 * case can check the prompt, the tool list and the signal.
 *
 * Called by: this file: scriptedChat
 */
interface Call {
  // The conversation as it was when chat was called.
  messages: ChatMessage[]
  // The tools and the signal the agent passed.
  options: ChatOptions
}

/**
 * A chat that plays one scripted round per call and records what it was asked. The messages are
 * copied at call time because the agent keeps appending to its own array, and a case needs the
 * prompt as it was on each call.
 *
 * Called by: this file: run
 * @param rounds the LLM's answers, one per call; a call beyond the script is a test error
 * @returns the chat function to inject, and the live list of calls it received
 */
function scriptedChat(rounds: Round[]) {
  // The calls, in order; the case reads them after the run.
  let calls: Call[] = []
  /**
   * The injected chat: streams the next round as ChatChunks, honoring the abort signal between
   * tokens as the real client does.
   *
   * Called by: runAgent, through the deps of run
   * @param messages the agent's conversation so far
   * @param options the tools and signal the agent passed
   * @returns the round's text chunks, its tool-call chunk if any, then the done chunk
   */
  async function* chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<ChatChunk> {
    // Snapshot the messages: the agent mutates its array after this call.
    calls.push({ messages: structuredClone(messages), options })
    // The round for this call.
    let round = rounds[calls.length - 1]
    // A missing round means the agent asked the LLM more often than the case expected.
    if (!round) throw new Error(`the script has no round ${calls.length}`)
    // Stream the text one piece at a time.
    for (let text of round.tokens ?? []) {
      // An aborted signal stops the stream with an AbortError, as a cancelled fetch would.
      options.signal?.throwIfAborted()
      // One token chunk.
      yield { content: text, done: false }
    }
    // The structured tool calls, if the round has any, come after the text as Ollama sends them.
    if (round.toolCalls) yield { toolCalls: round.toolCalls, done: false }
    // The end of the answer.
    yield { done: true }
  }
  // The function to inject and the recording.
  return { chat, calls }
}

/**
 * A retrieve that returns fixed sources and records every question and limit it was asked.
 *
 * Called by: this file: run
 * @param sources what every search returns, whatever the question
 * @returns the retrieve function to inject, and the live list of its calls
 */
function fakeRetrieve(sources: Source[]) {
  // The calls, in order.
  let calls: { question: string; limit: number | undefined }[] = []
  /**
   * The injected retrieve: records the call and answers with the fixed sources.
   *
   * Called by: runAgent, through the deps of run
   * @param question the search query
   * @param limit the number of passages asked for, if the agent gave one
   * @returns the fixed sources
   */
  async function retrieve(question: string, limit?: number): Promise<Source[]> {
    // Record the query.
    calls.push({ question, limit })
    // Same answer every time.
    return sources
  }
  // The function to inject and the recording.
  return { retrieve, calls }
}

/**
 * A tool call as Ollama parses it. The arguments are untyped so a test can hand over the string
 * form some models produce instead of an object.
 *
 * Called by: this file: the runAgent cases with tool calls, the agent.toolCallInText case
 * @param name the tool's name, known or not
 * @param args the arguments, an object or a JSON string
 * @returns the ToolCall shape
 */
function call(name: string, args: unknown): ToolCall {
  // Ollama nests name and arguments under function.
  return { function: { name, arguments: args as Record<string, unknown> } }
}

/**
 * Drains the agent's event stream into an array, so a case can assert on the whole sequence.
 *
 * Called by: this file: every runAgent case but the abort case
 * @param events the generator runAgent returned
 * @returns every event, in order; rejects with the generator's error if it throws
 */
async function collect(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  // The events in order.
  let all: StreamEvent[] = []
  // Pull until the agent finishes.
  for await (let event of events) all.push(event)
  // Hand them back.
  return all
}

/**
 * Runs the agent on QUESTION with a scripted model and a fake retrieval, and returns the event
 * stream with both recordings, so a case states only the script and the expectations.
 *
 * Called by: this file: every agent.runAgent case
 * @param rounds the LLM's scripted answers, one per chat call
 * @param sources what every retrieval returns; the two passages unless a case says otherwise
 * @param signal an AbortSignal for the abort case; none otherwise
 * @returns the event generator, the chat calls and the retrieve calls
 */
function run(rounds: Round[], sources: Source[] = [chunking, stages], signal?: AbortSignal) {
  // The scripted model and its recording.
  let { chat, calls } = scriptedChat(rounds)
  // The fake retrieval and its recording.
  let retrieval = fakeRetrieve(sources)
  // The agent under test, with no selected node and the injected dependencies.
  let events = runAgent(QUESTION, undefined, signal, { chat, retrieve: retrieval.retrieve, graph })
  // Everything a case may want to inspect.
  return { events, calls, retrieveCalls: retrieval.calls }
}

/**
 * The texts of the token events, in order: the answer as the user would read it.
 *
 * Called by: this file: the runAgent cases that check the answer's text
 * @param events the collected events
 * @returns the token texts
 */
function tokens(events: StreamEvent[]): string[] {
  // Keep only token events, and only their text.
  return events.flatMap((e) => (e.type === 'token' ? [e.text] : []))
}

/**
 * The kind of each event, with tool events tagged by their tool name, so a case can pin the
 * whole sequence in one deepEqual.
 *
 * Called by: this file: the runAgent cases that check the event order
 * @param events the collected events
 * @returns one label per event, such as "tool:highlight_node", "sources", "ui" or "token"
 */
function kinds(events: StreamEvent[]): string[] {
  // Tool events carry their name; the rest are their type.
  return events.map((e) => (e.type === 'tool' ? `tool:${e.name}` : e.type))
}

// The static part of the agent: its tool declarations and its prompt.
describe('agent.tools', () => {
  // Proves the tool list the LLM sees: three function tools, highlight_node first because the
  // small model favors the first, each with its required parameters. Covers: app/ai/agent.ts:
  // tools.
  it('declares the three tools, the highlight first, with their required parameters', () => {
    // Type, name and required parameters of each tool, in order.
    assert.deepEqual(
      tools.map((t) => [t.type, t.function.name, t.function.parameters.required ?? []]),
      [
        ['function', 'highlight_node', ['id']],
        ['function', 'search_docs', ['query']],
        ['function', 'get_flow', []],
      ],
    )
  })

  // Proves what the fixed prompt asks for: to call highlight_node, to search, to cite the section
  // of each passage, to answer in English, without naming any section, and in under 800
  // characters.
  // Covers: app/ai/agent.ts: AGENT_SYSTEM_PROMPT.
  it('asks the LLM for one decision, briefly, and how to cite', () => {
    // The highlight tool is named so the LLM knows to call it.
    assert.match(AGENT_SYSTEM_PROMPT, /call highlight_node/)
    // So is the search tool.
    assert.match(AGENT_SYSTEM_PROMPT, /search_docs/)
    // Citations are by section, copied from the passage's label.
    assert.match(AGENT_SYSTEM_PROMPT, /section of each passage/)
    // The subject of the article is named, so the LLM knows what the passages are.
    assert.match(AGENT_SYSTEM_PROMPT, /retrieval-augmented generation/)
    // The answer language is fixed.
    assert.match(AGENT_SYSTEM_PROMPT, /in English/)
    // No example section name: a small LLM would repeat it in every answer.
    assert.doesNotMatch(AGENT_SYSTEM_PROMPT, /Improvements|Process|Chunking|Applications/)
    // Short, because prompt processing is the slow part on this CPU.
    assert.ok(AGENT_SYSTEM_PROMPT.length < 800)
  })

  // Proves that the graph is described as FLOW_TEXT and appended to the fixed prompt.
  // Covers: app/ai/agent.ts: describeFlow, systemPrompt.
  it('puts the canvas steps in the system prompt', () => {
    // The description matches the hand-written text line for line.
    assert.equal(describeFlow(graph), FLOW_TEXT)
    // The fixed prompt comes first.
    assert.ok(systemPrompt(graph).startsWith(AGENT_SYSTEM_PROMPT))
    // The steps close it.
    assert.ok(systemPrompt(graph).endsWith(FLOW_TEXT))
  })
})

// The loop: retrieval, model rounds, tool execution and the event stream.
describe('agent.runAgent', () => {
  // Proves the opening of every run: a search event and a sources event before any model call,
  // then a prompt of the system text plus the passages, with the tools offered.
  // Covers: app/ai/agent.ts: runAgent.
  it('retrieves first and gives the LLM the passages, the steps and the tools', async () => {
    // One round: a plain answer in two pieces.
    let { events, calls, retrieveCalls } = run([{ tokens: ['The retrieval ', 'step.'] }])
    // Drain the stream.
    let all = await collect(events)

    // The automatic search shows as a tool event, then its sources, then the answer.
    assert.deepEqual(kinds(all), ['tool:search_docs', 'sources', 'token', 'token'])
    // The first search uses the question itself as the query.
    assert.deepEqual(all[0], { type: 'tool', name: 'search_docs', args: { query: QUESTION } })
    // The sources event carries what retrieve returned, for the panel's citations.
    assert.deepEqual(all[1], { type: 'sources', sources: [chunking, stages] })
    // The answer streams as it came.
    assert.deepEqual(tokens(all), ['The retrieval ', 'step.'])
    // Retrieval asked for three passages, fewer than the RAG mode, to keep the prompt short.
    assert.deepEqual(retrieveCalls, [{ question: QUESTION, limit: 3 }])
    // One model call for a plain answer.
    assert.equal(calls.length, 1)
    // The prompt: the system text with the steps, and the user turn with the passages.
    assert.deepEqual(calls[0]!.messages, [
      { role: 'system', content: systemPrompt(graph) },
      { role: 'user', content: PASSAGES },
    ])
    // The very tools array, so the LLM can call them.
    assert.equal(calls[0]!.options.tools, tools)
  })

  // Proves a structured tool call end to end: the tool event, the ui event that lights the node,
  // and the assistant and tool turns appended before the next model call.
  // Covers: app/ai/agent.ts: runAgent.
  it('runs a highlight call, lights the node and feeds the result back', async () => {
    // Round one asks to highlight; round two answers.
    let { events, calls } = run([
      { toolCalls: [call('highlight_node', { id: 'retrieval' })] },
      { tokens: ['It is ', 'retrieval.'] },
    ])
    // Drain the stream.
    let all = await collect(events)

    // Search, sources, the highlight call, the ui effect, then the answer.
    assert.deepEqual(kinds(all), [
      'tool:search_docs',
      'sources',
      'tool:highlight_node',
      'ui',
      'token',
      'token',
    ])
    // The ui event names the node the canvas must light.
    assert.deepEqual(all[3], { type: 'ui', action: 'highlight-node', nodeId: 'retrieval' })
    // Two model calls: the one that asked, the one that answered.
    assert.equal(calls.length, 2)
    // The second call carries the assistant's call and the tool's result after the two turns.
    let [, , assistant, tool] = calls[1]!.messages
    // The assistant turn records the call with an empty content, as Ollama expects it back.
    assert.deepEqual(assistant, {
      role: 'assistant',
      content: '',
      tool_calls: [call('highlight_node', { id: 'retrieval' })],
    })
    // The tool turn tells the LLM what happened, with the tool's name.
    assert.deepEqual(tool, {
      role: 'tool',
      content: 'highlighted Retrieval',
      tool_name: 'highlight_node',
    })
  })

  // Proves that a call a small model writes as text inside <tool> tags, split across tokens, is
  // executed like a structured one and never reaches the user. Covers: app/ai/agent.ts: runAgent.
  it('treats a call written as text inside <tool> tags as a call, and never shows it', async () => {
    // Round one is the text form of a call, cut in two tokens; round two answers.
    let { events } = run([
      {
        tokens: [
          '<tool> {"name": "highlight_node", ',
          '"arguments": {"id": "retrieval"}} </tool>',
        ],
      },
      { tokens: ['Done.'] },
    ])
    // Drain the stream.
    let all = await collect(events)

    // Same sequence as a structured call.
    assert.deepEqual(kinds(all), [
      'tool:search_docs',
      'sources',
      'tool:highlight_node',
      'ui',
      'token',
    ])
    // Only the answer reaches the user; the JSON of the call does not.
    assert.deepEqual(tokens(all), ['Done.'])
  })

  // Proves that bare JSON in Ollama's own nested shape, naming a known tool, is also a call.
  // Covers: app/ai/agent.ts: runAgent.
  it('treats bare JSON naming a known tool as a call too', async () => {
    // Round one is JSON with a function wrapper; round two answers.
    let { events } = run([
      { tokens: ['{"function": {"name": "highlight_node", "arguments": {"id": "retrieval"}}}'] },
      { tokens: ['Done.'] },
    ])
    // Drain the stream.
    let all = await collect(events)
    // Executed as a call, with the ui effect.
    assert.deepEqual(kinds(all), [
      'tool:search_docs',
      'sources',
      'tool:highlight_node',
      'ui',
      'token',
    ])
  })

  // Proves that when a model writes a JSON call and then keeps talking, the trailing text is
  // dropped: it was written before the tool ran, so it is a guess. Covers: app/ai/agent.ts:
  // runAgent.
  it('drops the text a model adds after a call it wrote as JSON', async () => {
    // Round one is a call followed by a made-up answer; round two is the real answer.
    let { events } = run([
      {
        tokens: [
          '{"name": "highlight_node", "arguments": {"id": "retrieval"}}',
          '\n\nThe step is retrieval.',
        ],
      },
      { tokens: ['Retrieval finds them (Process).'] },
    ])
    // Drain the stream.
    let all = await collect(events)
    // The call ran.
    assert.deepEqual(kinds(all), [
      'tool:search_docs',
      'sources',
      'tool:highlight_node',
      'ui',
      'token',
    ])
    // Only the second round's answer is shown.
    assert.deepEqual(tokens(all), ['Retrieval finds them (Process).'])
  })

  // Proves that a <tool> block is found even after some preamble text, and that the final
  // answer still arrives. Covers: app/ai/agent.ts: runAgent.
  it('finds a <tool> block after a preamble', async () => {
    // Round one talks, then calls; round two answers.
    let { events } = run([
      {
        tokens: [
          'First, let me look. ',
          '<tool> {"name": "highlight_node", "arguments": {"id": "retrieval"}} </tool>',
        ],
      },
      { tokens: ['Retrieval.'] },
    ])
    // Drain the stream.
    let all = await collect(events)
    // The node was lit.
    assert.ok(all.some((e) => e.type === 'ui' && e.nodeId === 'retrieval'))
    // The answer is the last token.
    assert.deepEqual(tokens(all).at(-1), 'Retrieval.')
  })

  // Proves that text held back because it started like JSON is released untouched when the
  // round ends without a call: a brace does not make an answer a tool call.
  // Covers: app/ai/agent.ts: runAgent.
  it('releases held text at the end of a round when it was an answer after all', async () => {
    // An answer that opens with a brace but is not JSON.
    let { events } = run([{ tokens: ['{not json', ' answer'] }])
    // Both pieces reach the user, in their original form.
    assert.deepEqual(tokens(await collect(events)), ['{not json', ' answer'])
  })

  // Proves that held text is released as soon as it exceeds the size a call could have, so a
  // long answer that starts with a brace streams instead of waiting for the end.
  // Covers: app/ai/agent.ts: runAgent.
  it('releases held text as soon as it is too long to be a call', async () => {
    // A brace followed by more characters than any call needs.
    let long = '{' + 'x'.repeat(650)
    // The long token, then a short one.
    let { events } = run([{ tokens: [long, ' more'] }])
    // Both pieces arrive, in order.
    assert.deepEqual(tokens(await collect(events)), [long, ' more'])
  })

  // Proves the plain path: an answer with no brace and no tags streams piece by piece.
  // Covers: app/ai/agent.ts: runAgent.
  it('streams an ordinary answer as it arrives', async () => {
    // Three pieces of a cited answer.
    let { events } = run([{ tokens: ['Retrieval ', 'does it', ' (Process).'] }])
    // The same three pieces, unchanged.
    assert.deepEqual(tokens(await collect(events)), ['Retrieval ', 'does it', ' (Process).'])
  })

  // Proves the cap: after MAX_TOOL_CALLS rounds of tool calls the LLM is called once more
  // without tools, so it must answer; and that get_flow returned the steps on the way.
  // Covers: app/ai/agent.ts: runAgent, MAX_TOOL_CALLS.
  it('stops asking for tools after the cap and makes the LLM answer', async () => {
    // As many tool rounds as the cap allows, each asking for the flow.
    let rounds: Round[] = Array.from({ length: MAX_TOOL_CALLS }, () => ({
      toolCalls: [call('get_flow', {})],
    }))
    // Then the forced answer.
    rounds.push({ tokens: ['Final'] })
    // Run the script.
    let { events, calls } = run(rounds)
    // Drain the stream.
    let all = await collect(events)

    // Only the forced answer reaches the user.
    assert.deepEqual(tokens(all), ['Final'])
    // One call per tool round plus the final one.
    assert.equal(calls.length, MAX_TOOL_CALLS + 1)
    // The final call offers no tools, so the LLM cannot keep looping.
    assert.equal(calls[MAX_TOOL_CALLS]!.options.tools, undefined)
    // The conversation grew by an assistant and a tool turn per round, after the two first turns.
    assert.equal(calls[MAX_TOOL_CALLS]!.messages.length, 2 + MAX_TOOL_CALLS * 2)
    // The first get_flow result is the steps text, the same the prompt carries.
    assert.equal(calls[1]!.messages[3]!.content, FLOW_TEXT)
  })

  // Proves that a call to a tool that does not exist is reported to the LLM with the list of
  // valid tools, instead of failing the run. Covers: app/ai/agent.ts: runAgent.
  it('answers an unknown tool with the list of tools', async () => {
    // Round one calls a tool that does not exist; round two answers.
    let { events, calls } = run([{ toolCalls: [call('nope', {})] }, { tokens: ['ok'] }])
    // Drain the stream.
    let all = await collect(events)
    // The attempt is still shown as a tool event, so the panel can display what the LLM tried.
    assert.deepEqual(all[2], { type: 'tool', name: 'nope', args: {} })
    // The tool turn the LLM receives next.
    let tool = calls[1]!.messages[3]!
    // It is attributed to the name the LLM used.
    assert.equal(tool.tool_name, 'nope')
    // It names the problem and the three valid tools, in the declared order.
    assert.match(
      tool.content,
      /^unknown tool "nope"; the tools are highlight_node, search_docs, get_flow$/,
    )
  })

  // Proves that highlight_node with an id not on the canvas lights nothing and tells the LLM
  // the valid ids. Covers: app/ai/agent.ts: runAgent.
  it('refuses an unknown node id without lighting anything', async () => {
    // Round one asks for a node that does not exist; round two answers.
    let { events, calls } = run([
      { toolCalls: [call('highlight_node', { id: 'x' })] },
      { tokens: ['ok'] },
    ])
    // Drain the stream.
    let all = await collect(events)
    // No ui event: the canvas is not touched.
    assert.ok(!all.some((e) => e.type === 'ui'))
    // The tool turn lists the ids the LLM may use.
    assert.equal(
      calls[1]!.messages[3]!.content,
      'unknown node id "x"; valid ids: question, retrieval, answer',
    )
  })

  // Proves two tolerances for small models: arguments arriving as a JSON string, and a node
  // named by its label in another case; and that the normalized call is what gets recorded.
  // Covers: app/ai/agent.ts: runAgent.
  it('accepts arguments as a JSON string and a label in another case', async () => {
    // Round one makes two calls, one with string arguments, one with an upper-case label.
    let { events, calls } = run([
      {
        toolCalls: [
          call('highlight_node', '{"id":"retrieval"}'),
          call('highlight_node', { id: 'ANSWER' }),
        ],
      },
      { tokens: ['ok'] },
    ])
    // Drain the stream.
    let all = await collect(events)
    // Both resolved to real node ids, in order.
    assert.deepEqual(
      all.filter((e) => e.type === 'ui').map((e) => (e.type === 'ui' ? e.nodeId : '')),
      ['retrieval', 'answer'],
    )
    // The tool event shows the parsed arguments, not the string.
    assert.deepEqual(all[2], { type: 'tool', name: 'highlight_node', args: { id: 'retrieval' } })
    // The assistant turn fed back to the LLM.
    let assistant = calls[1]!.messages[2]!
    // It carries the normalized call, so the LLM sees the form it should have used.
    assert.deepEqual(assistant.tool_calls?.[0], call('highlight_node', { id: 'retrieval' }))
  })

  // Proves that an explicit search_docs call runs a second retrieval, emits its sources,
  // and feeds the numbered passages back as the tool result. Covers: app/ai/agent.ts: runAgent.
  it('runs a second search when the LLM asks, with a sources event', async () => {
    // Round one asks for a search; round two answers.
    let { events, calls, retrieveCalls } = run([
      { toolCalls: [call('search_docs', { query: 'embeddings' })] },
      { tokens: ['ok'] },
    ])
    // Drain the stream.
    let all = await collect(events)
    // Two search-and-sources pairs before the answer.
    assert.deepEqual(kinds(all), [
      'tool:search_docs',
      'sources',
      'tool:search_docs',
      'sources',
      'token',
    ])
    // The automatic search, then the LLM's, both with the agent's limit.
    assert.deepEqual(retrieveCalls, [
      { question: QUESTION, limit: 3 },
      { question: 'embeddings', limit: 3 },
    ])
    // The tool result is the passages in the numbered layout the LLM already knows.
    assert.ok(
      calls[1]!.messages[3]!.content.startsWith('[1] Improvements, Chunking, lines 69-71:\n'),
    )
  })

  // Proves that aborting while tokens stream rejects the loop with the abort and makes no
  // further model call. Covers: app/ai/agent.ts: runAgent.
  it('stops when the signal aborts during the stream', async () => {
    // The controller the case aborts with.
    let controller = new AbortController()
    // One round of two tokens, one source, and the signal.
    let { events, calls } = run([{ tokens: ['one', 'two'] }], [chunking], controller.signal)
    // The events received before the abort took effect.
    let seen: StreamEvent[] = []
    // Consume the stream and abort on the first token; the loop must then reject.
    await assert.rejects(async () => {
      // Read until the abort propagates.
      for await (let event of events) {
        // Keep the event.
        seen.push(event)
        // Abort as soon as the LLM starts answering.
        if (event.type === 'token') controller.abort()
      }
    // The rejection must be the abort itself, not some other failure.
    }, /abort/i)
    // The LLM was not called again after the abort.
    assert.equal(calls.length, 1)
    // The search, its sources and at least the first token were delivered before the stop.
    assert.ok(seen.length >= 3)
  })
})

// The detector for tool calls written as text.
describe('agent.toolCallInText', () => {
  // Proves which texts count as a call: a tagged call with surrounding whitespace, bare JSON
  // naming a known tool with or without arguments, JSON followed by extra text; and which do
  // not: an unknown tool, JSON after prose, plain text. Covers: app/ai/agent.ts: toolCallInText.
  it('recognizes the wrapped and the bare forms, and nothing else', () => {
    // Tagged, with spaces around: recognized and parsed.
    assert.deepEqual(
      toolCallInText(' <tool_call>{"name":"get_flow","arguments":{}}</tool_call> '),
      call('get_flow', {}),
    )
    // Bare JSON with no arguments: an empty object is assumed.
    assert.deepEqual(toolCallInText('{"name":"highlight_node"}'), call('highlight_node', {}))
    // JSON with a brace inside a string value, then trailing prose: the JSON is found whole.
    assert.deepEqual(
      toolCallInText('{"name":"get_flow","arguments":{"a":"}"}}\n\nMade-up answer.'),
      call('get_flow', { a: '}' }),
    )
    // A tool that does not exist is not a call.
    assert.equal(toolCallInText('{"name":"other","arguments":{}}'), undefined)
    // JSON after prose is part of an answer, not a call.
    assert.equal(toolCallInText('The answer is {"name":"get_flow"}'), undefined)
    // Plain text is plain text.
    assert.equal(toolCallInText('plain text'), undefined)
  })
})
