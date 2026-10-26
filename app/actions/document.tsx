// document.tsx: the <html> shell of every page, with the import map and the browser entry.
//
// Objective
//   Render the document around a page: the head with the meta tags, the icon, the title, the
//   page's own head elements, the import map, the module preloads and the browser entry
//   script; then the body with the page's children. Everything the browser needs to run the
//   client modules comes from the asset server through scriptEntry.
//
// Dependencies
//   remix/component: the Handle and RemixNode types, and css for the body's style.
//   remix/component/server: ImportMap, the component that renders the import map script.
//   ../assets.ts: scriptEntry, the browser entry's href, its import map and the modules to
//     preload, resolved once when the server starts.
//
// Consumers
//   app/actions/page.tsx: Document, around the page's layout, with the title and the island's
//     stylesheet link as head.
//
// How it relates to them
//   A page passes its content as children and anything for the <head> as head; the shell owns
//   the rest. The default title is the app's display name written into this file by `remix new`;
//   a page overrides it with the title prop. The body has no margin, so the page controls the
//   whole viewport.
import type { Handle, RemixNode } from 'remix/component'
import { css } from 'remix/component'
import { ImportMap } from 'remix/component/server'

import { scriptEntry } from '../assets.ts'

/**
 * The props of Document.
 *
 * Called by: Document (this file); no other file names it
 */
export interface DocumentProps {
  // The page's content, placed in <body>.
  children?: RemixNode
  // Extra elements for <head>, such as a stylesheet link.
  head?: RemixNode
  // The <title>; DEFAULT_TITLE when absent.
  title?: string
}

/**
 * The title used when a page gives none: the app's display name, URL-decoded.
 *
 * Called by: Document (this file)
 */
const DEFAULT_TITLE = readAppDisplayName('Remix%203%20Local%20RAG%20Agent')

/**
 * The document component. The outer function receives the handle and returns the render
 * function, which reads the current props each time it runs.
 *
 * Called by: app/actions/page.tsx: Page
 * @param handle the component's handle; handle.props is a DocumentProps
 * @returns the render function, which returns the <html> element
 */
export function Document(handle: Handle<DocumentProps>) {
  // The render function, run on each render with the props of that moment.
  return () => {
    // The props of this render, with the default title.
    let { children, head, title = DEFAULT_TITLE } = handle.props
    // The browser entry: its URL, the import map of the client modules, and what to preload.
    let { href, importMap, preloads } = scriptEntry

    // The whole document.
    return (
      // The root element; English, as the whole POC is.
      <html lang="en">
        {/* Everything the browser needs before the body. */}
        <head>
          {/* UTF-8, before any text. */}
          <meta charSet="utf-8" />
          {/* Lay out at the device's width, with no initial zoom. */}
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          {/* The page follows the user's light or dark preference. */}
          <meta name="color-scheme" content="light dark" />
          {/* The tab icon, served unchanged from public/. */}
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          {/* The page's title, or the default. */}
          <title>{title}</title>
          {/* The page's own head elements, if any. */}
          {head}
          {/* The import map: how bare module names resolve in the browser. */}
          <ImportMap value={importMap} />
          {/* One modulepreload per module the entry needs, so they load in parallel. */}
          {preloads.map((preloadHref) => (
            // The preload link for one module.
            <link key={preloadHref} rel="modulepreload" href={preloadHref} />
          ))}
          {/* The browser entry, as an ES module. */}
          <script type="module" src={href}></script>
        </head>
        {/* The page's content; no margin, so the page fills the viewport. */}
        <body mix={css({ margin: 0 })}>{children}</body>
      </html>
    )
  }
}

/**
 * The app's display name from the value `remix new` wrote into this file. A value that still
 * starts with '%%' is the template's placeholder, left unreplaced; the generic name is used then.
 *
 * Called by: DEFAULT_TITLE (this file)
 * @param value the URL-encoded display name, or the unreplaced placeholder
 * @returns the decoded name, or 'Remix App' for the placeholder
 */
function readAppDisplayName(value: string): string {
  // The placeholder means no name was written; otherwise undo the URL encoding.
  return value.startsWith('%%') ? 'Remix App' : decodeURIComponent(value)
}
