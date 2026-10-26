// mount.ts: the entry of the island's bundle; it puts the React Flow canvas into a container.
//
// Objective
//   The Remix island (flow-island.tsx) owns a <div> and hands it over; mountFlow renders the
//   React tree inside it and unmounts when the island's signal aborts. Being the bundle's entry,
//   this file also imports the two stylesheets, so that esbuild emits them as flow-bundle.css.
//
// Dependencies
//   @xyflow/react/dist/style.css and ./flow.css: bundled into flow-bundle.css, not into the JS.
//   react: createElement (no JSX here, so no pragma is needed) and StrictMode.
//   react-dom/client: createRoot, the way React 18 and later own a DOM subtree.
//   ../../../ai/types.ts: FlowGraph, the graph the server rendered into the island's props.
//   ./flow-canvas.tsx: FlowCanvas, the component that is rendered.
//
// Consumers
//   scripts/build-flow.ts: the esbuild entry point; everything reachable from here is bundled.
//   app/actions/public/flow-island.tsx: FlowIsland calls mountFlow through flow-bundle.js.
//   app/actions/public/flow/flow-bundle.d.ts: re-exports this file's types as the bundle's.
//
// How it relates to them
//   The island promises an element that is in the document and a signal that aborts when the
//   element leaves it; nothing else is needed. The island must not touch the container's
//   children afterwards (it sets data-rmx-preserve-dom for that). Whatever this file exports is
//   what the bundle exports; flow-bundle.d.ts depends on that.
import '@xyflow/react/dist/style.css'
import './flow.css'

import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import type { FlowGraph } from '../../../ai/types.ts'
import { FlowCanvas } from './flow-canvas.tsx'

/**
 * Renders the canvas inside the island's container and removes it when the signal aborts. Safe
 * to call with an already aborted signal: it then does nothing, so a container that left the
 * document while the bundle was loading is never touched.
 *
 * Called by: app/actions/public/flow-island.tsx: FlowIsland (the ref callback, once the bundle
 *   has loaded)
 * @param container the island's <div>, in the document; its children are replaced
 * @param graph the pipeline to draw; nodes need positions, edges need existing node ids
 * @param signal aborts when the island leaves the document; unmounts the React root
 * @returns nothing; React errors surface in the console, not here
 */
export function mountFlow(container: HTMLElement, graph: FlowGraph, signal: AbortSignal): void {
  // The island may be gone already (a navigation during the dynamic import): render nothing.
  if (signal.aborted) return

  // Drop the server-rendered placeholder; from here on React owns the container's children.
  container.replaceChildren()
  // One React root per island; createRoot is the concurrent API of React 18 and later.
  let root = createRoot(container)
  // StrictMode double-invokes effects in development, which checks that the effect in FlowCanvas
  // cleans up its listener. createElement instead of JSX keeps this a plain .ts file.
  root.render(createElement(StrictMode, null, createElement(FlowCanvas, { graph })))

  // Unmount when the island leaves the document; once, since a signal aborts a single time.
  signal.addEventListener('abort', () => root.unmount(), { once: true })
}
