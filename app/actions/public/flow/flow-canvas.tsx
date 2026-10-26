/** @jsxImportSource react */
// flow-canvas.tsx: the React Flow canvas that draws the RAG pipeline.
//
// Objective
//   Render the pipeline as a React Flow graph: fixed nodes, labelled edges, a background grid,
//   zoom controls and a minimap. Two things connect it to the rest of the page: a click on a
//   node tells the chat panel which step was chosen, and the panel can ask the canvas to
//   highlight a node. This is React code: the pragma on line 1 makes its JSX React's, not
//   Remix's. Remix never imports this file; the island loads the esbuild bundle that
//   scripts/build-flow.ts makes from mount.ts.
//
// Dependencies
//   react: useCallback and useEffect.
//   @xyflow/react: the ReactFlow component with Background, Controls and MiniMap, the
//     useNodesState and useEdgesState hooks, and the NodeMouseHandler type.
//   ../../../ai/types.ts: FlowGraph, the graph the server rendered into the island.
//   ../events.ts: emitNodeSelected to announce a click, onHighlightNode to receive a highlight.
//   ./graph-to-flow.ts: toCanvasNodes, toCanvasEdges, applyHighlight and the CanvasNode type.
//
// Consumers
//   app/actions/public/flow/mount.ts: mountFlow renders FlowCanvas, with the graph, as the root.
//
// How it relates to them
//   The canvas owns its React Flow state; the graph prop is read once, at mount, so a new graph
//   needs a new mount. Everything that crosses to the Remix side goes through events.ts and
//   nothing else: no shared variables, no DOM reaching into the panel. The highlight listener
//   lives and dies with the component.
import { useCallback, useEffect } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type NodeMouseHandler,
} from '@xyflow/react'

import type { FlowGraph } from '../../../ai/types.ts'
import { emitNodeSelected, onHighlightNode } from '../events.ts'
import { applyHighlight, toCanvasEdges, toCanvasNodes, type CanvasNode } from './graph-to-flow.ts'

/**
 * The MiniMap's color per node kind: the colors flow.css gives the nodes' borders, so the map
 * reads like the canvas. Keyed by CanvasNode's kind, so a new kind is a type error here.
 *
 * Called by: FlowCanvas (this file), through the MiniMap's nodeColor callback
 */
const kindColor: Record<CanvasNode['data']['kind'], string> = {
  start: '#2e8b57',
  step: '#9aa3ab',
  end: '#1f6fb2',
  failure: '#c0392b',
}

/**
 * The canvas component. Builds its nodes and edges from the graph, listens for highlight
 * requests, and reports clicks.
 *
 * Called by: app/actions/public/flow/mount.ts: mountFlow
 * @param props graph: the pipeline to draw, read once at mount
 * @returns the React Flow tree; it fills its container, whose size the island sets
 */
export function FlowCanvas({ graph }: { graph: FlowGraph }) {
  // React Flow's own node state: the nodes, a setter and a change handler that keeps selection
  // and measurements in sync. The initial nodes carry no highlight.
  let [nodes, setNodes, onNodesChange] = useNodesState(toCanvasNodes(graph, null))
  // The edges never change after mount, so the setter is skipped; the handler is still wired.
  let [edges, , onEdgesChange] = useEdgesState(toCanvasEdges(graph))

  // The panel (or the agent through it) asks for a highlight; null clears it.
  useEffect(() => {
    // One controller per subscription; aborting it removes the DOM listener.
    let controller = new AbortController()
    // On each request, move the highlight with applyHighlight, which keeps unchanged nodes.
    onHighlightNode(({ nodeId }) => {
      // The functional form reads the latest nodes, so no dependency on `nodes` is needed.
      setNodes((current) => applyHighlight(current, nodeId))
      // The listener leaves with the effect, not with the page.
    }, controller.signal)
    // The cleanup; StrictMode runs it once in development before running the effect again.
    return () => controller.abort()
    // setNodes is stable, so the effect runs once per mount.
  }, [setNodes])

  // A click reports the node's id, label and description to the panel through events.ts.
  let onNodeClick = useCallback<NodeMouseHandler<CanvasNode>>((_event, node) => {
    // Only the fields the panel needs; position and kind stay here.
    emitNodeSelected({ id: node.id, label: node.data.label, description: node.data.description })
    // No dependencies: the handler reads nothing from the render.
  }, [])

  // The React Flow tree, props one per line.
  return (
    // The canvas: controlled nodes and edges, a read-only pipeline, bounded zoom.
    <ReactFlow
      // The nodes from useNodesState; highlights arrive through setNodes.
      nodes={nodes}
      // The edges from useEdgesState, fixed for the life of the mount.
      edges={edges}
      // Keeps selection and size measurements flowing into the node state.
      onNodesChange={onNodesChange}
      // The same for the edges; without it React Flow treats them as uncontrolled.
      onEdgesChange={onEdgesChange}
      // A click on a node goes to the panel.
      onNodeClick={onNodeClick}
      // Fit the whole pipeline into the viewport at mount...
      fitView
      // ...with a twelfth of the viewport as margin, so the end nodes are not at the edge but the
      // labels stay as large as the width allows.
      fitViewOptions={{ padding: 0.08 }}
      // The layout is the fixture's: the user cannot move nodes...
      nodesDraggable={false}
      // ...nor draw new edges.
      nodesConnectable={false}
      // But a click selects, which gives the dark ring of flow.css and fires onNodeClick.
      elementsSelectable
      // Far enough out to see the whole pipeline...
      minZoom={0.4}
      // ...and close enough to read a label, no further.
      maxZoom={1.5}
    >
      {/* The dotted grid behind the nodes, in the grey of the page's borders. */}
      <Background gap={20} color="#d0d4d8" />
      {/* Zoom in, zoom out, fit; the lock button is hidden since nothing is draggable anyway. */}
      <Controls showInteractive={false} />
      {/* The overview in the corner, colored by node kind; it can pan and zoom the canvas. */}
      <MiniMap pannable zoomable nodeColor={(node) => kindColor[(node as CanvasNode).data.kind]} />
    </ReactFlow>
  )
}
