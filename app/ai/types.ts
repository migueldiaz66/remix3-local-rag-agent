// types.ts: the shapes shared by the server modules in app/ai and the browser modules in
// app/actions/public.
//
// Objective
//   One place for every shape that crosses a boundary: the request the panel posts and the
//   stream it reads back, the passages stored in Qdrant and listed as sources, the messages and
//   tool definitions Ollama's /api/chat takes, and the graph the canvas draws. Both sides import
//   the same names, so the browser and the server cannot drift apart silently.
//
// Dependencies
//   None. The file imports nothing and runs no code: it holds types only, so a browser module
//   imports it with `import type` and nothing of it reaches the bundle.
//
// Consumers
//   app/ai/chat.ts, app/ai/agent.ts: ChatRequest, StreamEvent, ChatMessage, ToolCall,
//     ToolDefinition, Source, FlowGraph.
//   app/ai/ollama.ts: ChatMessage, ToolCall, ToolDefinition.
//   app/ai/chunk.ts, app/ai/qdrant.ts, app/ai/rag.ts: Chunk, Source, ChatMessage.
//   app/actions/public/chat-panel.tsx: ChatMode, ChatRequest, StreamEvent, Source.
//   app/actions/public/events.ts, app/actions/public/flow/*, app/actions/page.tsx,
//     app/fixtures/rag-pipeline.ts: FlowNode, FlowEdge, FlowGraph.
//   app/routes.ts: ChatRequest, StreamEvent. The tests beside each of those files.
//
// How it relates to them
//   A change here is a change to a contract. ChatRequest and StreamEvent are the wire protocol
//   between the panel and POST /api/chat and must change on both sides in the same edit. Chunk is
//   what Qdrant stores: changing it needs a new `npm run ingest`. ChatMessage, ToolCall and
//   ToolDefinition follow Ollama's API and change only when Ollama's does.

/**
 * The three ways the panel can ask a question, one per tab: `llm` sends the question to the
 * model alone; `rag` first retrieves passages from the corpus and makes the LLM answer
 * from them; `agent` lets the LLM call the tools app/ai/agent.ts defines and streams their
 * calls and canvas effects back.
 *
 * Called by: app/actions/public/chat-panel.tsx (the server reads it through ChatRequest.mode)
 */
export type ChatMode = 'llm' | 'rag' | 'agent'

/**
 * The body of POST /api/chat: built by the panel in the browser, parsed by app/ai/chat.ts.
 *
 * Called by: app/actions/public/chat-panel.tsx, app/ai/chat.ts, app/ai/agent.ts, app/routes.ts,
 *   app/actions/api/controller.test.ts
 */
export interface ChatRequest {
  // Which pipeline answers; see ChatMode.
  mode: ChatMode
  // The user's text as typed in the panel.
  question: string
  // What the UI knows that the LLM should too, such as the node selected in the canvas.
  // Optional: a question asked with nothing selected carries no context.
  context?: {
    // The selected node reduced to what a prompt needs; its position and kind stay in the browser.
    selectedNode?: Pick<FlowNode, 'id' | 'label' | 'description'>
  }
}

/**
 * One line of the NDJSON stream POST /api/chat sends back; the panel parses each line as it
 * arrives. `token` is the next piece of the answer text; `sources` the passages the answer
 * draws on, so the panel can list them; `tool` a tool call the agent made, with its name and
 * arguments; `ui` an effect on the canvas, today only highlighting a node (null clears the
 * highlight); `done` ends the stream with the LLM's name and the elapsed milliseconds;
 * `error` ends it with a failure said in words.
 *
 * Called by: app/actions/public/chat-panel.tsx, app/ai/chat.ts, app/ai/agent.ts, app/routes.ts,
 *   app/ai/chat.test.ts, app/ai/agent.test.ts
 */
export type StreamEvent =
  | { type: 'token'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'ui'; action: 'highlight-node'; nodeId: string | null }
  | { type: 'done'; model: string; ms: number }
  | { type: 'error'; message: string }

/**
 * A passage of the corpus, as stored in Qdrant (the point payload) and as shown in the
 * panel. app/ai/chunk.ts makes them; `lines` lets the panel cite the exact place in the file.
 *
 * Called by: app/ai/chunk.ts, app/ai/qdrant.ts, app/ai/rag.ts, app/ai/chunk.test.ts,
 *   app/ai/qdrant.test.ts, app/ai/rag.test.ts
 */
export interface Chunk {
  // The chapter's slug and the piece's position in it, such as "improvements-2". It depends only
  // on the heading and the order, so a re-ingest of the same document gives the same ids.
  id: string
  // The text of the nearest "## " heading above the passage, such as "Improvements".
  chapter: string
  // The nearest heading of any level above the passage; the chapter itself for its first lines.
  heading: string
  // First and last line of the passage in the source file, 1-based and inclusive.
  lines: [number, number]
  // Exactly those lines of the source, joined with newlines; nothing is rewritten.
  text: string
}

/**
 * A chunk as a search returns it: the stored payload plus how close it is to the question. The
 * panel lists them under the answer; the RAG prompt numbers them.
 *
 * Called by: app/actions/public/chat-panel.tsx, app/ai/agent.ts, app/ai/qdrant.ts, app/ai/rag.ts,
 *   app/ai/agent.test.ts, app/ai/rag.test.ts
 */
export interface Source extends Chunk {
  // Cosine similarity between the question's vector and the passage's; higher is closer.
  score: number
}

/**
 * One message in the shape Ollama's /api/chat takes: the conversation the LLM sees, in order.
 *
 * Called by: app/ai/ollama.ts, app/ai/rag.ts, app/ai/agent.ts, app/ai/chat.ts,
 *   app/ai/ollama.test.ts, app/ai/agent.test.ts
 */
export interface ChatMessage {
  // Who speaks: the system prompt, the user, the LLM's earlier turns, or a tool's result.
  role: 'system' | 'user' | 'assistant' | 'tool'
  // The text of the message; for a tool, the result the agent feeds back to the LLM.
  content: string
  // On an assistant message, the tool calls the LLM asked for, kept in the history so the LLM
  // sees what it requested when it reads the tool's answer.
  tool_calls?: ToolCall[]
  // On a tool message, which tool produced it. Ollama's field name, hence the underscore.
  tool_name?: string
}

/**
 * A tool call as Ollama reports it in a streamed message: the function's name and its arguments,
 * already parsed from the LLM's JSON.
 *
 * Called by: app/ai/ollama.ts, app/ai/agent.ts, app/ai/agent.test.ts
 */
export interface ToolCall {
  // Ollama nests the call under `function`, mirroring the OpenAI shape.
  function: { name: string; arguments: Record<string, unknown> }
}

/**
 * A tool declared to the LLM, in the shape Ollama's /api/chat takes: a function with a
 * description the LLM reads to decide when to call it, and a JSON Schema of its arguments.
 *
 * Called by: app/ai/agent.ts, app/ai/ollama.ts, app/ai/ollama.test.ts
 */
export interface ToolDefinition {
  // The only kind Ollama knows.
  type: 'function'
  // The function itself.
  function: {
    // The name the LLM uses in its tool calls; the agent matches it to an implementation.
    name: string
    // What the tool does and when to use it, in words for the LLM.
    description: string
    // The arguments as a JSON Schema object, the subset Ollama forwards to the LLM.
    parameters: {
      // Always an object: arguments are named.
      type: 'object'
      // Each argument's type and meaning.
      properties: Record<string, { type: string; description: string }>
      // The arguments the LLM must always provide.
      required?: string[]
    }
  }
}

/**
 * One node of the RAG pipeline drawn in the canvas: a step of onboarding a document or of
 * answering a question.
 * Positions are React Flow's, in canvas pixels.
 *
 * Called by: app/actions/public/events.ts, app/actions/public/flow/graph-to-flow.ts, and
 *   ChatRequest.context in this file
 */
export interface FlowNode {
  // Unique in the graph; edges point at it and the agent highlights it by this id.
  id: string
  // The short text drawn in the node.
  label: string
  // The longer explanation; the panel sends it to the LLM as context when the node is selected.
  description: string
  // The role of the step: where the pipeline starts, a normal step, where it ends, or a failure.
  // graph-to-flow.ts picks the node's style from it.
  kind: 'start' | 'step' | 'end' | 'failure'
  // Where React Flow draws the node; fixed by the fixture, not computed.
  position: { x: number; y: number }
}

/**
 * A directed connection between two nodes of the pipeline, drawn as an arrow in the canvas.
 *
 * Called by: app/actions/public/flow/graph-to-flow.ts
 */
export interface FlowEdge {
  // Unique in the graph; React Flow needs it to track the edge.
  id: string
  // The id of the node the arrow leaves.
  source: string
  // The id of the node the arrow enters.
  target: string
  // An optional caption on the arrow, such as the condition that takes this path.
  label?: string
}

/**
 * The whole canvas: a title and the nodes and edges of one RAG pipeline. Today a single
 * fixture, app/fixtures/rag-pipeline.ts, provides it; the agent describes it to the LLM.
 *
 * Called by: app/actions/page.tsx, app/actions/public/flow-island.tsx,
 *   app/actions/public/flow/flow-canvas.tsx, app/actions/public/flow/graph-to-flow.ts,
 *   app/actions/public/flow/mount.ts, app/fixtures/rag-pipeline.ts, app/ai/agent.ts,
 *   app/ai/agent.test.ts
 */
export interface FlowGraph {
  // The name of the pipeline the graph draws.
  title: string
  // Every node; positions are inside each node.
  nodes: FlowNode[]
  // Every edge; each names two ids present in `nodes`.
  edges: FlowEdge[]
}
