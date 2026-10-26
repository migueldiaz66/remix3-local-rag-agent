// entry.ts: the browser runtime; it hydrates the page's client entries and reloads on HMR.
//
// Objective
//   This is the one <script type="module"> the document loads. It starts the Remix component
//   runtime with two callbacks: how to import a component module by URL and export name, and
//   what to do with a client entry's preloads when the browser cannot take more than one import
//   map. Under `npm run hmr` it also reloads the top frame when the server changes.
//
// Dependencies
//   remix/multiple-import-maps-polyfill: detectMultipleImportMapSupport, importModule and
//     preloadShim, which make several import maps work in browsers that accept only one.
//   remix/component: run, the browser runtime that hydrates every clientEntry on the page.
//   import.meta.hot: defined only when the asset server runs with HMR (`npm run hmr`, see
//     app/assets.ts).
//
// Consumers
//   app/assets.ts: names this file as the script entry (assets.getScriptEntry) and gives the
//     document its href, import map and preloads.
//   app/actions/document.tsx: Document puts that href in the <script type="module"> of the head.
//   The browser, which runs it; through it, app/actions/public/chat-panel.tsx and
//     app/actions/public/flow-island.tsx are loaded and hydrated.
//
// How it relates to them
//   Nothing here is specific to this POC: the components only need to be clientEntry modules
//   under app/**/public/ (the asset server's allow list) for loadModule to find them. The
//   runtime is a module-level singleton: `app` is created once per page load.
import {
  detectMultipleImportMapSupport,
  importModule,
  preloadShim,
} from 'remix/multiple-import-maps-polyfill'
import { run } from 'remix/component'

/**
 * The running Remix browser app: hydration of the client entries already in the HTML, the
 * frames, and the ready promise the HMR handler below waits on.
 *
 * Called by: the HMR handler (this file); the Remix runtime itself calls the two methods
 */
const app = run({
  /**
   * Imports a component module and returns the named export, which must be a component
   * function. The runtime calls it for every clientEntry it finds in the HTML.
   *
   * Called by: the Remix component runtime (remix/component: run)
   * @param moduleUrl the component module's URL, as clientEntry recorded it with import.meta.url
   * @param exportName the export to take from that module
   * @returns the component function
   * @throws when the export is missing or is not a function, with both names in the message
   */
  async loadModule(moduleUrl, exportName) {
    // Through the polyfill, so the URL resolves under every import map on the page.
    let mod = await importModule(moduleUrl)
    // The export the server-rendered markup named.
    let Component = mod[exportName]
    // A wrong name or a non-component export is a bug worth a clear message, not a silent miss.
    if (typeof Component !== 'function') {
      throw new Error(`Unknown component: ${moduleUrl}#${exportName}`)
    }
    // The runtime hydrates with it.
    return Component
  },
  /**
   * Decides what to do with a client entry's module preloads. Browsers that accept several
   * import maps get them as they are; the others get them shimmed, and nothing is left for the
   * runtime to preload.
   *
   * Called by: the Remix component runtime (remix/component: run)
   * @param preloads the entry's preload descriptors, as the asset server emitted them
   * @returns the preloads the runtime should still handle: all of them, or none
   */
  async processClientEntryPreloads(preloads) {
    // Native support: nothing to shim, the runtime preloads as usual.
    if (await detectMultipleImportMapSupport()) return preloads

    // No native support: the polyfill registers the preloads itself...
    preloadShim(preloads)
    // ...so the runtime has none left to handle.
    return []
  },
})

// Only under `npm run hmr`: the asset server defines import.meta.hot; otherwise it is undefined.
if (import.meta.hot) {
  // The server restarted or a server module changed: refresh the page's top frame.
  import.meta.hot.on('server:update', async () => {
    // A failed reload must not kill the HMR channel, so it is caught and logged.
    try {
      // Wait for hydration to finish; a reload during it would race the runtime.
      await app.ready()
      // Fetch and render the top frame again in place, keeping the browser's state.
      await app.frames.top.reload()
      // The reload failed: say so, and keep listening.
    } catch (error) {
      // The message names the event, so the console reader knows where it came from.
      console.error('Error reloading top frame on server update', error)
    }
  })
}
