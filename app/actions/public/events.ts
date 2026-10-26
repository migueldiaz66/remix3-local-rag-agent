// events.ts: the browser events between the React Flow island and the chat panel.
//
// Objective
//   The canvas and the panel are two separate programs on one page: the canvas is React, bundled
//   by esbuild; the panel is a Remix component, served by the asset server. They share nothing
//   but the document they live in, so they talk through DOM CustomEvents on `document`. This file
//   names the two events, types their payloads and wraps dispatch and listen, so that neither
//   side spells an event name or casts an Event by hand.
//
// Dependencies
//   ../../ai/types.ts: FlowNode, from which NodeSelectedDetail picks three fields.
//   The DOM: document.dispatchEvent, document.addEventListener and CustomEvent. Browser only.
//
// Consumers
//   app/actions/public/chat-panel.tsx: ChatPanel listens with onNodeSelected and asks for a
//     highlight with emitHighlightNode.
//   app/actions/public/flow/flow-canvas.tsx: FlowCanvas emits with emitNodeSelected and listens
//     with onHighlightNode.
//
// How it relates to them
//   Each side imports this file through its own loader, so two copies of this module run in the
//   browser: one inside flow-bundle.js, one as a module of the asset server. That is fine only
//   because the copies hold no state: the contract is the event names and the detail shapes,
//   plain strings and objects on `document`. Never add module state here. Every listener takes
//   an AbortSignal, so it leaves with the component that registered it.
import type { FlowNode } from '../../ai/types.ts'

/**
 * Name of the event the canvas dispatches when the user clicks a node. The `ui:` prefix keeps it
 * clear of any DOM or library event name.
 *
 * Called by: emitNodeSelected, onNodeSelected (this file)
 */
export const NODE_SELECTED = 'ui:node-selected'
/**
 * Name of the event the panel dispatches to highlight one node on the canvas, or none.
 *
 * Called by: emitHighlightNode, onHighlightNode (this file)
 */
export const HIGHLIGHT_NODE = 'ui:highlight-node'

/**
 * What the canvas tells the panel about the clicked node: enough to show a chip and to give the
 * server context for the question, never the whole node (position and kind stay on the canvas).
 *
 * Called by: app/actions/public/chat-panel.tsx: ChatPanel;
 *   emitNodeSelected, onNodeSelected (this file)
 */
export type NodeSelectedDetail = Pick<FlowNode, 'id' | 'label' | 'description'>
/**
 * What the panel tells the canvas: the id of the node to highlight, or null to clear the
 * highlight. The id should be one of the graph's node ids; an unknown id highlights nothing.
 *
 * Called by: emitHighlightNode, onHighlightNode (this file)
 */
export interface HighlightNodeDetail {
  nodeId: string | null
}

/**
 * The canvas announces the node the user clicked. Fire and forget: when no panel is listening
 * the event is simply lost, which is the right outcome.
 *
 * Called by: app/actions/public/flow/flow-canvas.tsx: FlowCanvas (its onNodeClick handler)
 * @param detail the clicked node's id, label and description; the id is a node of the graph
 * @returns nothing
 */
export function emitNodeSelected(detail: NodeSelectedDetail): void {
  // Dispatch on document, where the panel listens; the detail travels as the event's payload.
  document.dispatchEvent(new CustomEvent<NodeSelectedDetail>(NODE_SELECTED, { detail }))
}

/**
 * The panel asks the canvas to highlight a node, or none. The panel calls it when the agent's
 * stream carries a 'ui' event, so the LLM's answer can point at a step of the pipeline.
 *
 * Called by: app/actions/public/chat-panel.tsx: ChatPanel (its receive function)
 * @param detail nodeId: the node to highlight, or null to clear the highlight
 * @returns nothing
 */
export function emitHighlightNode(detail: HighlightNodeDetail): void {
  // Dispatch on document, where the canvas listens; the detail travels as the event's payload.
  document.dispatchEvent(new CustomEvent<HighlightNodeDetail>(HIGHLIGHT_NODE, { detail }))
}

/**
 * Subscribes to NODE_SELECTED and hands each event's detail to the listener, already typed.
 *
 * Called by: app/actions/public/chat-panel.tsx: ChatPanel (its browser-only setup task)
 * @param listener receives the clicked node's detail; it should not throw
 * @param signal removes the listener when aborted; pass the component's own signal
 * @returns nothing
 */
export function onNodeSelected(
  listener: (detail: NodeSelectedDetail) => void,
  signal: AbortSignal,
): void {
  // The DOM types the event as a plain Event; the cast recovers the detail dispatched above.
  document.addEventListener(
    NODE_SELECTED,
    (event) => listener((event as CustomEvent<NodeSelectedDetail>).detail),
    { signal },
  )
}

/**
 * Subscribes to HIGHLIGHT_NODE and hands each event's detail to the listener, already typed.
 *
 * Called by: app/actions/public/flow/flow-canvas.tsx: FlowCanvas (its highlight effect)
 * @param listener receives the highlight request; it should not throw
 * @param signal removes the listener when aborted; the effect's cleanup aborts it
 * @returns nothing
 */
export function onHighlightNode(
  listener: (detail: HighlightNodeDetail) => void,
  signal: AbortSignal,
): void {
  // The DOM types the event as a plain Event; the cast recovers the detail dispatched above.
  document.addEventListener(
    HIGHLIGHT_NODE,
    (event) => listener((event as CustomEvent<HighlightNodeDetail>).detail),
    { signal },
  )
}
