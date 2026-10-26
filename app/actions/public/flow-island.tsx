// flow-island.tsx: the React island; Remix owns this container, React owns everything inside it.
//
// Objective
//   Put the React Flow canvas on a Remix page. The component renders a placeholder <div> on the
//   server; in the browser, once the element is in the document, it loads the island's bundle
//   and hands the element to mountFlow. From then on the children belong to React, and Remix is
//   told to leave them alone.
//
// Dependencies
//   remix/component: clientEntry (makes this a component the browser hydrates), css, ref and the
//     Handle type.
//   ../../ai/types.ts: FlowGraph, the prop the page passes.
//   ./flow/flow-bundle.js, imported dynamically: mountFlow. The file is built by
//     scripts/build-flow.ts and typed by ./flow/flow-bundle.d.ts; react ships CommonJS and the
//     asset server serves ES modules only, which is why the React code arrives as one bundle.
//
// Consumers
//   app/actions/page.tsx: Page renders FlowIsland, with the graph, in the canvas section.
//   app/actions/public/entry.ts: the browser runtime loads this module through clientEntry.
//
// How it relates to them
//   The page gives a graph and a flex container; the island fills it (minHeight 420px) and
//   never reads the graph again after mount. This file stays a Remix component: it never imports
//   React, and it never writes the JSX import-source pragma, which would switch this file's JSX
//   to React. The bundle is loaded, not imported statically, so a missing bundle breaks the
//   canvas alone and not the page.
import { clientEntry, css, ref, type Handle } from 'remix/component'

import type { FlowGraph } from '../../ai/types.ts'

/**
 * The island component, registered as a client entry so the browser hydrates it by its module
 * URL and export name. Props: graph, the pipeline to draw.
 *
 * Called by: app/actions/page.tsx: Page
 */
export const FlowIsland = clientEntry(
  import.meta.url,
  /**
   * Renders the container and, in the browser, mounts the canvas into it.
   *
   * Called by: the Remix component runtime, on the server and in the browser
   * @param handle the component handle; handle.props.graph is the pipeline
   * @returns the render function
   */
  function FlowIsland(handle: Handle<{ graph: FlowGraph }>) {
    // The render: one <div> whose children React will own.
    return () => (
      // The container. data-rmx-key gives it a stable identity across renders.
      <div
        data-rmx-key="flow-canvas"
        // Remix leaves the children alone, so React's DOM survives a re-render of the page.
        data-rmx-preserve-dom
        // The style, and the ref that mounts the canvas.
        mix={[
          containerStyle,
          ref((node, signal) => {
            // Runs in the browser only, once the element is inserted. The signal aborts when the
            // element leaves the document, and mountFlow unmounts the React root on it.
            import('./flow/flow-bundle.js')
              .then((flow) => {
                // The element left while the bundle was loading: do not mount into a dead node.
                if (signal.aborted) return
                // Hand the element, the graph and the signal to the bundle; React takes over.
                flow.mountFlow(node, handle.props.graph, signal)
              })
              .catch((error: unknown) => {
                // Nobody is looking at the element any more.
                if (signal.aborted) return
                // The usual cause is a missing bundle; say so where the canvas would have been.
                node.textContent = 'The canvas could not load. Run "npm run build:flow" and reload.'
                // The full error goes to the console for whoever is debugging.
                console.error('Flow island failed to load', error)
              })
          }),
        ]}
      >
        {/* The server-rendered placeholder; mountFlow or the catch above replaces it. */}
        Loading the canvas…
      </div>
    )
  },
)

/**
 * The container's style: fills the section it is in, guarantees a minimum height so React Flow
 * (which sizes to its parent) has room, and centers the placeholder text in grey.
 *
 * Called by: FlowIsland (this file), on the container <div>
 */
const containerStyle = css({
  flex: '1 1 auto',
  minHeight: '420px',
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#6b7075',
  fontSize: '14px',
})
