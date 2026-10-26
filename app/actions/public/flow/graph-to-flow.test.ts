// graph-to-flow.test.ts: the pure mapping from a FlowGraph to React Flow nodes and edges.
//
// Objective
//   Prove, on the ragPipeline fixture, that toCanvasNodes and toCanvasEdges give React Flow
//   what it needs (ids, labels, positions, kind classes, arrow heads) and that applyHighlight
//   lights exactly one node and hands back the untouched nodes unchanged, so React Flow does not
//   re-render them.
//
// Dependencies
//   remix/assert: equal, deepEqual and ok, the assertions.
//   remix/test: describe and it, the runner's grouping and cases.
//   ../../../fixtures/rag-pipeline.ts: ragPipeline, the nine-step graph the canvas shows.
//   ../../../ai/types.ts: FlowGraph, the type of the small graph that carries a failure node.
//   ./graph-to-flow.ts: applyHighlight, HIGHLIGHTED_CLASS, toCanvasEdges and toCanvasNodes, the
//   code under test. No DOM and no React: the mapping is plain data.
//
// Consumers
//   `npm test` (package.json) runs it; nothing imports it.
//   app/actions/public/flow/graph-to-flow.ts is the module it covers: a change there must keep
//   these cases green; flow-canvas.tsx relies on the same guarantees in the browser.
//
// How it relates to them
//   The fixture's shape is pinned here: nine nodes in the order Documents, Chunking, Embedding,
//   Vector store, Question, Retrieval, Augmented prompt, Generation, Answer; eight edges; the
//   second node at (-190, 60). Changing the fixture means changing these expectations too. The
//   fixture has no failure node, so that kind is tested on a small graph made in this file.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import type { FlowGraph } from '../../../ai/types.ts'
import { ragPipeline } from '../../../fixtures/rag-pipeline.ts'
import { applyHighlight, HIGHLIGHTED_CLASS, toCanvasEdges, toCanvasNodes } from './graph-to-flow.ts'

// One group for the module: nodes, edges and the highlight.
describe('graph-to-flow', () => {
  // Proves that every fixture node becomes a canvas node with its label, kind class, position
  // and locked drag state, with nothing highlighted at first. Covers: graph-to-flow.ts:
  // toCanvasNodes.
  it('maps every node with its label, kind class and position', () => {
    // Map the fixture with no highlighted node.
    let nodes = toCanvasNodes(ragPipeline, null)

    // Every node of the fixture is kept; none is dropped or invented.
    assert.equal(nodes.length, 9)
    // The labels follow the fixture's order, which is the reading order of the canvas.
    assert.deepEqual(
      nodes.map((node) => node.data.label),
      [
        'Documents',
        'Chunking',
        'Embedding',
        'Vector store',
        'Question',
        'Retrieval',
        'Augmented prompt',
        'Generation',
        'Answer',
      ],
    )
    // The kind becomes a CSS class, so the start node can be styled apart.
    assert.ok(nodes[0].className?.includes('flow-node--start'))
    // The end kind gets its own class as well.
    assert.ok(nodes[8].className?.includes('flow-node--end'))
    // Positions pass through untouched: the fixture decides the layout, not the mapping.
    assert.deepEqual(nodes[1].position, { x: -190, y: 60 })
    // The canvas is read-only: nothing drags, and no node starts highlighted.
    assert.ok(nodes.every((node) => node.draggable === false && !node.data.highlighted))
  })

  // Proves that edges keep their endpoints and labels and all get an arrow head, so direction
  // is visible. Covers: graph-to-flow.ts: toCanvasEdges.
  it('maps edges with their labels and an arrow head', () => {
    // Map the fixture's transitions.
    let edges = toCanvasEdges(ragPipeline)

    // Every transition of the fixture is kept.
    assert.equal(edges.length, 8)
    // The fifth edge is the one from the vector store to retrieval; its source survives.
    assert.equal(edges[4].source, 'vector-store')
    // And its target.
    assert.equal(edges[4].target, 'retrieval')
    // The transition's label is shown on the edge.
    assert.equal(edges[4].label, 'closest passages')
    // Every edge has an arrow head, so the pipeline reads as a direction, not a line.
    assert.ok(edges.every((edge) => edge.markerEnd !== undefined))
  })

  // Proves that applyHighlight marks exactly the requested node, keeps the others by identity,
  // and clears everything for null. Covers: graph-to-flow.ts: applyHighlight, HIGHLIGHTED_CLASS.
  it('highlights exactly the requested node, and none for null', () => {
    // Start from an unlit canvas.
    let nodes = toCanvasNodes(ragPipeline, null)

    // Light the sixth node, as the agent's highlight_node tool would.
    let lit = applyHighlight(nodes, 'retrieval')
    // Only the requested node carries the highlighted flag.
    assert.deepEqual(
      lit.filter((node) => node.data.highlighted).map((node) => node.id),
      ['retrieval'],
    )
    // The flag is mirrored as a class, which is what the CSS styles.
    assert.ok(lit[5].className?.includes(HIGHLIGHTED_CLASS))
    // Untouched nodes are the same objects, so React Flow skips re-rendering them.
    assert.equal(lit[0], nodes[0], 'untouched nodes keep their identity')

    // Clearing with null turns the highlight off again.
    let dark = applyHighlight(lit, null)
    // No flag remains.
    assert.ok(dark.every((node) => !node.data.highlighted))
    // And no class remains either, so the style goes with the flag.
    assert.ok(dark.every((node) => !node.className?.includes(HIGHLIGHTED_CLASS)))
  })

  // Proves that a failure node gets its own class, which the fixture cannot show because the RAG
  // pipeline has none. Covers: graph-to-flow.ts: toCanvasNodes.
  it('gives a failure node its own class', () => {
    // A graph of one failure node, written here because the fixture has none.
    let graph: FlowGraph = {
      title: 'One failure',
      nodes: [
        {
          id: 'oops',
          label: 'Oops',
          description: 'A failure.',
          kind: 'failure',
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    }
    // Map it with no highlighted node.
    let nodes = toCanvasNodes(graph, null)

    // The kind becomes the class the CSS styles in red.
    assert.ok(nodes[0].className?.includes('flow-node--failure'))
  })
})
