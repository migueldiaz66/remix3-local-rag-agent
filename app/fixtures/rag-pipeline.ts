// rag-pipeline.ts: the pipeline of a retrieval-augmented generation (RAG) app, for the canvas.
//
// Objective
//   Sample data for the demo: the graph the canvas draws and the agent describes. Nine nodes in
//   two rows: the top row onboards a document (documents, chunking, embedding, vector store),
//   the bottom row answers a question (question, retrieval, augmented prompt, generation,
//   answer), and an edge from the vector store to retrieval joins them. The words follow the
//   Wikipedia article in data/rag-wikipedia.md, and the descriptions say how this app does each
//   step: passages of about 500 characters, 768-dimension vectors from nomic-embed-text, Qdrant,
//   the four closest passages, qwen3:1.7b. The assistant can quote the descriptions.
//
// Dependencies
//   ../ai/types.ts: FlowGraph, the shape of the graph (title, nodes with id, label, description,
//     kind and position; edges with id, source, target and an optional label).
//
// Consumers
//   app/actions/controller.tsx: ragPipeline, as the page's graph prop.
//   app/actions/api/controller.tsx: ragPipeline, as the JSON of GET /api/graph.
//   app/ai/agent.ts: ragPipeline, the graph of the agent's default deps (the system prompt
//     lists its steps; highlight_node matches its ids).
//   app/actions/public/flow/graph-to-flow.test.ts and app/actions/api/controller.test.ts:
//     ragPipeline, as test input and expectation.
//
// How it relates to them
//   The node ids are the vocabulary the LLM and the canvas share: the agent's highlight_node
//   tool receives one of them, and the canvas highlights the node with that id. Positions are
//   in canvas pixels, fixed here rather than computed. The graph is a constant; when a number in
//   a description changes in app/ai/config.ts, the description changes in the same edit.
import type { FlowGraph } from '../ai/types.ts'

/**
 * The demo graph: how a RAG app onboards a document and then answers a question. Nodes:
 * documents and question (start), chunking, embedding, vector-store, retrieval,
 * augmented-prompt and generation (steps), answer (end). Edges: documents -> chunking ->
 * embedding -> vector-store on the top row, question -> retrieval -> augmented-prompt ->
 * generation -> answer on the bottom row, and vector-store -> retrieval, labelled "closest
 * passages", between them.
 *
 * Called by: app/actions/controller.tsx: home, app/actions/api/controller.tsx: graph,
 *   app/ai/agent.ts: defaultDeps, app/actions/public/flow/graph-to-flow.test.ts,
 *   app/actions/api/controller.test.ts
 */
export const ragPipeline: FlowGraph = {
  title: 'A RAG pipeline: onboarding a document, then answering a question',
  nodes: [
    {
      id: 'documents',
      label: 'Documents',
      description:
        'The external data the answers come from. Here it is one Wikipedia article ' +
        'about retrieval-augmented generation, kept as a Markdown file.',
      kind: 'start',
      position: { x: -380, y: 60 },
    },
    {
      id: 'chunking',
      label: 'Chunking',
      description:
        'The article is cut into passages of about 500 characters that never cross a ' +
        'section heading, so the retriever can find details in it.',
      kind: 'step',
      position: { x: -190, y: 60 },
    },
    {
      id: 'embedding',
      label: 'Embedding',
      description:
        'Each passage becomes an embedding, a vector of 768 numbers, made by the ' +
        'nomic-embed-text model running in Ollama.',
      kind: 'step',
      position: { x: 0, y: 60 },
    },
    {
      id: 'vector-store',
      label: 'Vector store',
      description:
        'The vectors are stored with their passages in Qdrant, a vector database that ' +
        'finds the vectors closest to a question.',
      kind: 'step',
      position: { x: 190, y: 60 },
    },
    {
      id: 'question',
      label: 'Question',
      description:
        'What the user asks. It is turned into a vector the same way as a passage, so ' +
        'the two can be compared.',
      kind: 'start',
      position: { x: 0, y: 220 },
    },
    {
      id: 'retrieval',
      label: 'Retrieval',
      description:
        "The question's vector is compared with the stored ones, and the four closest " +
        "passages are selected to augment the question.",
      kind: 'step',
      position: { x: 190, y: 220 },
    },
    {
      id: 'augmented-prompt',
      label: 'Augmented prompt',
      description:
        "The four passages and the user's question are put into one prompt, so the " +
        "LLM answers from the retrieved text and not only from its training data.",
      kind: 'step',
      position: { x: 380, y: 220 },
    },
    {
      id: 'generation',
      label: 'Generation',
      description:
        'The LLM, qwen3:1.7b running in Ollama, writes the answer from the augmented prompt.',
      kind: 'step',
      position: { x: 570, y: 220 },
    },
    {
      id: 'answer',
      label: 'Answer',
      description:
        'A short answer that cites the section of each passage it used, so the user ' +
        'can check the source.',
      kind: 'end',
      position: { x: 760, y: 220 },
    },
  ],
  edges: [
    { id: 'e1', source: 'documents', target: 'chunking' },
    { id: 'e2', source: 'chunking', target: 'embedding' },
    { id: 'e3', source: 'embedding', target: 'vector-store' },
    { id: 'e4', source: 'question', target: 'retrieval' },
    { id: 'e5', source: 'vector-store', target: 'retrieval', label: 'closest passages' },
    { id: 'e6', source: 'retrieval', target: 'augmented-prompt' },
    { id: 'e7', source: 'augmented-prompt', target: 'generation' },
    { id: 'e8', source: 'generation', target: 'answer' },
  ],
}
