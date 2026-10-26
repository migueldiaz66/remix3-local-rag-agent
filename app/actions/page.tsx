// page.tsx: the one page of the POC, the canvas on the left and the assistant on the right.
//
// Objective
//   Lay out the page: a two-column grid with the RAG pipeline (title, hint and the React
//   Flow island) on the left and the chat panel on the right, inside the HTML document that
//   document.tsx renders. The page is rendered on the server; the island and the panel become
//   interactive in the browser.
//
// Dependencies
//   remix/component: the Handle type (a component's props and lifecycle) and css, for styles.
//   ../ai/types.ts: FlowGraph, the shape of the graph prop.
//   ../assets.ts: flowStyleHref, the href of the React Flow island's stylesheet, or null before
//     the first `npm run build:flow`.
//   ./document.tsx: Document, the <html> shell with the import map and the browser entry.
//   ./public/chat-panel.tsx: ChatPanel, the assistant's panel.
//   ./public/flow-island.tsx: FlowIsland, the island that mounts the React Flow canvas in the
//     browser.
//
// Consumers
//   app/actions/controller.tsx: Page, rendered by the `home` action with the demo graph and the
//     chat endpoint's href.
//
// How it relates to them
//   The page receives everything as props, graph and chatHref, and passes them down; it reads
//   no request and no environment. The hint tells the user that selecting a step feeds the
//   assistant: the island and the panel talk through the DOM events of public/events.ts, not
//   through this page.
import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import type { FlowGraph } from '../ai/types.ts'
import { flowStyleHref } from '../assets.ts'
import { Document } from './document.tsx'
import { ChatPanel } from './public/chat-panel.tsx'
import { FlowIsland } from './public/flow-island.tsx'

/**
 * The page component. The outer function receives the handle and returns the render function,
 * which reads the current props each time it runs.
 *
 * Called by: app/actions/controller.tsx: home
 * @param handle the component's handle; handle.props carries graph (the FlowGraph the canvas
 *   shows) and chatHref (where the panel posts its questions)
 * @returns the render function, which returns the whole document of the page
 */
export function Page(handle: Handle<{ graph: FlowGraph; chatHref: string }>) {
  // The render function, run on each render with the props of that moment.
  return () => {
    // The props of this render.
    let { graph, chatHref } = handle.props

    // The document, with the island's stylesheet in the head once it has been built.
    return (
      // The HTML shell; the stylesheet link is skipped before the first build:flow.
      <Document
        title="Remix 3 Local RAG Agent"
        // The island's stylesheet, linked once the bundle has been built.
        head={flowStyleHref ? <link rel="stylesheet" href={flowStyleHref} /> : null}
      >
        {/* The two-column grid: the canvas takes the free width, the assistant 400px. */}
        <main mix={layoutStyle}>
          {/* The left column, a landmark for the RAG pipeline. */}
          <section mix={canvasStyle} aria-label="RAG pipeline">
            {/* The title bar above the canvas. */}
            <header mix={titleStyle}>
              {/* The graph's title: what the pipeline does. */}
              <h1 mix={h1Style}>{graph.title}</h1>
              {/* The one instruction the user needs. */}
              <p mix={hintStyle}>Click a step to ask the assistant about it.</p>
            </header>
            {/* The React Flow canvas, mounted in the browser with this graph. */}
            <FlowIsland graph={graph} />
          </section>
          {/* The right column: the assistant. */}
          <aside mix={asideStyle}>
            {/* The chat panel, posting its questions to the chat route. */}
            <ChatPanel chatHref={chatHref} />
          </aside>
        </main>
      </Document>
    )
  }
}

/**
 * The page grid: the canvas column takes the free width, the assistant a fixed 400px; the full
 * viewport height, the system font and the POC's text and background colours.
 *
 * Called by: Page (this file), on <main>
 */
const layoutStyle = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 400px',
  height: '100vh',
  fontFamily: 'system-ui, sans-serif',
  color: '#313539',
  background: '#f7fbff',
})

/**
 * The canvas column: a vertical flex so the title bar keeps its height and the island takes the
 * rest; minWidth 0 lets the column shrink below its content's width.
 *
 * Called by: Page (this file), on <section>
 */
const canvasStyle = css({
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
})

/**
 * The title bar: padding and a bottom border that separates it from the canvas.
 *
 * Called by: Page (this file), on <header>
 */
const titleStyle = css({ padding: '12px 16px', borderBottom: '1px solid #d0d4d8' })
/**
 * The title: no margin, a modest size, so the bar stays low.
 *
 * Called by: Page (this file), on <h1>
 */
const h1Style = css({ margin: 0, fontSize: '16px' })
/**
 * The hint under the title: small and grey.
 *
 * Called by: Page (this file), on <p>
 */
const hintStyle = css({ margin: '4px 0 0', fontSize: '13px', color: '#6b7075' })

/**
 * The assistant column: a left border, white background, and minHeight 0 so the panel scrolls
 * inside the grid row instead of growing it.
 *
 * Called by: Page (this file), on <aside>
 */
const asideStyle = css({
  borderLeft: '1px solid #d0d4d8',
  minHeight: 0,
  background: 'white',
})
