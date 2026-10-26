// graph-to-flow.ts: turns the shared FlowGraph into React Flow nodes and edges.
//
// Objective
//   The server's FlowGraph (app/ai/types.ts) is neutral: ids, labels, kinds, positions. React
//   Flow wants its own Node and Edge objects, with class names, handle positions and edge types.
//   This file does that translation, plus the one update the canvas needs at run time: moving
//   the assistant's highlight from one node to another without rebuilding the nodes.
//
// Dependencies
//   @xyflow/react: the Edge, Node and Position types only. No React, no DOM: the file runs in
//     the server test as well as in the browser bundle.
//   ../../../ai/types.ts: FlowEdge, FlowGraph, FlowNode, the shared shapes.
//
// Consumers
//   app/actions/public/flow/flow-canvas.tsx: FlowCanvas builds its initial state with
//     toCanvasNodes and toCanvasEdges and applies highlights with applyHighlight; its kindColor
//     map is keyed by CanvasNode's kind.
//   app/actions/public/flow/graph-to-flow.test.ts: tests the three functions and
//     HIGHLIGHTED_CLASS against the fixture graph.
//
// How it relates to them
//   The class names NODE_CLASS, kindClass(kind) and HIGHLIGHTED_CLASS, and the 'flow-edge'
//   class, are the contract with flow.css, which styles by them. The functions are pure: they
//   never mutate their input, and applyHighlight returns the same node object when nothing
//   changed, so React Flow re-renders only the nodes whose highlight moved.
import type { Edge, Node, Position } from '@xyflow/react'

import type { FlowEdge, FlowGraph, FlowNode } from '../../../ai/types.ts'

/**
 * The data React Flow carries on each node of the canvas. It extends Record<string, unknown>
 * because React Flow's Node type requires it. The label is what the node shows; description and
 * kind travel with the node so a click can report them without a lookup; highlighted is the
 * assistant's mark, kept in the data so that a change of highlight is a change React sees.
 *
 * Called by: CanvasNode (this file)
 */
export interface FlowNodeData extends Record<string, unknown> {
  /** The text shown in the node; the fixture keeps it short enough for the 150px card. */
  label: string
  /** A sentence or two about the step; shown nowhere on the canvas, sent to the assistant. */
  description: string
  /** start, step, end or failure: picks the node's colors in flow.css and in the MiniMap. */
  kind: FlowNode['kind']
  /** True on the one node the assistant highlighted, false on all the others. */
  highlighted: boolean
}

/**
 * A node as React Flow renders it: the built-in 'default' node type with FlowNodeData. The POC
 * draws no custom node component; the look comes from class names and flow.css.
 *
 * Called by: app/actions/public/flow/flow-canvas.tsx: kindColor, FlowCanvas;
 *   toCanvasNodes, applyHighlight (this file)
 */
export type CanvasNode = Node<FlowNodeData, 'default'>
/**
 * An edge as React Flow renders it: nothing beyond the library's own Edge, named here so the
 * canvas and the tests speak of CanvasEdge next to CanvasNode.
 *
 * Called by: toCanvasEdges (this file)
 */
export type CanvasEdge = Edge

/**
 * The class every node gets; flow.css hangs the shared card style on it, and the kind classes
 * derive from it.
 *
 * Called by: kindClass, toCanvasNodes (this file)
 */
export const NODE_CLASS = 'flow-node'
/**
 * The class of the highlighted node, added and removed by this file and styled by flow.css.
 *
 * Called by: toCanvasNodes, applyHighlight (this file);
 *   app/actions/public/flow/graph-to-flow.test.ts: its highlight tests
 */
export const HIGHLIGHTED_CLASS = 'flow-node--highlighted'

/**
 * The class that marks a node's kind, in BEM style: flow-node--start, flow-node--failure, ...
 *
 * Called by: toCanvasNodes (this file)
 * @param kind one of FlowNode's kinds
 * @returns the class name; flow.css needs a rule for each kind that has a look of its own
 */
export function kindClass(kind: FlowNode['kind']): string {
  // The double dash is the BEM modifier convention, which keeps the kind rules readable in CSS.
  return `${NODE_CLASS}--${kind}`
}

/**
 * Builds the canvas's nodes from the graph, once, with at most one of them highlighted. The
 * nodes are fixed in place: the pipeline's layout is part of the fixture, not of the user's
 * session, so dragging and connecting are off.
 *
 * Called by: app/actions/public/flow/flow-canvas.tsx: FlowCanvas (its initial state);
 *   app/actions/public/flow/graph-to-flow.test.ts: its tests
 * @param graph the pipeline; every node needs a position, used as given
 * @param highlightedId the node to mark, or null for none; an unknown id marks nothing
 * @returns one CanvasNode per graph node, in the graph's order
 */
export function toCanvasNodes(graph: FlowGraph, highlightedId: string | null): CanvasNode[] {
  // One canvas node per graph node, in order; the id is reused, so the edges still resolve.
  return graph.nodes.map((node) => {
    // Only the node whose id matches gets the mark; null matches no id.
    let highlighted = node.id === highlightedId
    // React Flow's Node shape; the class list is what flow.css styles by.
    return {
      id: node.id,
      type: 'default',
      position: node.position,
      // The pipeline reads left to right, so edges leave on the right and arrive on the left.
      sourcePosition: 'right' as Position,
      targetPosition: 'left' as Position,
      data: { label: node.label, description: node.description, kind: node.kind, highlighted },
      className: [NODE_CLASS, kindClass(node.kind), highlighted ? HIGHLIGHTED_CLASS : '']
        .filter(Boolean)
        .join(' '),
      draggable: false,
      connectable: false,
    }
  })
}

/**
 * Builds the canvas's edges from the graph. Edges are 'smoothstep' lines with a closed arrow at
 * the target, labelled with the graph's label, and carry the 'flow-edge' class for flow.css.
 *
 * Called by: app/actions/public/flow/flow-canvas.tsx: FlowCanvas (its initial state);
 *   app/actions/public/flow/graph-to-flow.test.ts: its tests
 * @param graph the pipeline; each edge's source and target must be ids of its nodes
 * @returns one CanvasEdge per graph edge, in the graph's order
 */
export function toCanvasEdges(graph: FlowGraph): CanvasEdge[] {
  // One canvas edge per graph edge; React Flow resolves source and target by node id.
  return graph.edges.map((edge: FlowEdge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: 'smoothstep',
    markerEnd: { type: 'arrowclosed' },
    className: 'flow-edge',
  }))
}

/**
 * Applies a new highlight to nodes already on the canvas without rebuilding them. Nodes whose
 * state does not change are returned as the same object, so React Flow skips them; the ones
 * that change get a new object with the class list and the data flag both updated.
 *
 * Called by: app/actions/public/flow/flow-canvas.tsx: FlowCanvas (its highlight effect);
 *   app/actions/public/flow/graph-to-flow.test.ts: its highlight tests
 * @param nodes the canvas's current nodes, as React Flow holds them; never mutated
 * @param highlightedId the node to mark, or null to clear every mark
 * @returns a new array; same length and order, same objects where nothing changed
 */
export function applyHighlight(nodes: CanvasNode[], highlightedId: string | null): CanvasNode[] {
  // Walk every node: the one to mark, the one to unmark, and the rest, which pass through.
  return nodes.map((node) => {
    // What this node should be after the change.
    let highlighted = node.id === highlightedId
    // Already right: keep the object, so React Flow sees no change for this node.
    if (highlighted === node.data.highlighted) return node
    // The class list without the highlight class, wherever it was; empty strings dropped.
    let classes = (node.className ?? '').split(' ').filter((c) => c && c !== HIGHLIGHTED_CLASS)
    // Put the highlight class back only on the node that is now highlighted.
    if (highlighted) classes.push(HIGHLIGHTED_CLASS)
    // A new node object: React compares by identity, so both the data and the node must change.
    return { ...node, data: { ...node.data, highlighted }, className: classes.join(' ') }
  })
}
