// assets.ts: the server-side asset pipeline, the browser modules built and served under /assets.
//
// Objective
//   Create the asset server that bundles the browser code (the entry in app/actions/public/ and
//   the files it imports) and serves it under /assets, with source maps and a watcher in
//   development, minified in production, and hot module replacement when `npm run hmr` runs the
//   app. It also resolves, once at start, the two things pages need: the browser entry
//   (scriptEntry) and the React Flow island's stylesheet (flowStyleHref).
//
// Dependencies
//   remix/assets: createAssetServer.
//   remix/component-hmr/assets: componentHmr, the script loader that makes components
//     hot-replaceable.
//   remix/node-hmr/runtime (dynamic, HMR only): createBrowserHmrChannel, the channel that tells
//     the browser what changed.
//   remix/multiple-import-maps-polyfill (by name, HMR only): the module importer the browser
//     uses when import maps change.
//   NODE_ENV and REMIX_NODE_HMR: environment variables; 'development' (the default) and a set
//     REMIX_NODE_HMR choose the development and HMR behaviour.
//   The file system: app/routes.ts, every file under a public/ folder in app/, and the remix
//     package may be served; test files never are.
//   app/actions/public/flow/flow-bundle.css: the island's stylesheet, emitted by
//     `npm run build:flow` (scripts/build-flow.ts), absent before the first build.
//
// Consumers
//   app/router.ts: assets, for the render middleware.
//   app/actions/controller.tsx: assets, whose fetch answers the `assets` route.
//   app/actions/document.tsx: scriptEntry, for the import map, preloads and entry script.
//   app/actions/page.tsx: flowStyleHref, for the stylesheet link.
//
// How it relates to them
//   This module awaits at top level, so importing it blocks until the browser entry is built;
//   the server pays that once before it listens. A missing island stylesheet is a warning, not
//   a failure: the page renders without it. Files outside the allow list are not served even
//   if a browser module imports them, so new client code goes under a public/ folder.
import { createAssetServer } from 'remix/assets'
import { componentHmr } from 'remix/component-hmr/assets'

/**
 * The project root, where the server was started; every allowed path is relative to it.
 *
 * Called by: assets (this file)
 */
const rootDir = process.cwd()
/**
 * The environment's name: 'development' unless NODE_ENV says otherwise.
 *
 * Called by: isDevelopment (this file)
 */
const nodeEnv = process.env.NODE_ENV ?? 'development'
/**
 * Development mode: source maps, no minification, a file watcher.
 *
 * Called by: isHmr and assets (this file)
 */
const isDevelopment = nodeEnv === 'development'
/**
 * Hot module replacement: only in development, and only when REMIX_NODE_HMR is set, which
 * happens under `npm run hmr`.
 *
 * Called by: assets (this file)
 */
const isHmr = Boolean(isDevelopment && process.env.REMIX_NODE_HMR)

/**
 * The asset server. Its options: basePath, the URL prefix of every built file; rootDir, the
 * root the allow lists are relative to; allowFiles, the files the browser may load (the route
 * map and every file under a public/ folder in app/); allowPackages, the one package it may
 * load; denyFiles, the tests, never served; sourceMaps, external files in development only;
 * minify, in production only; watch, in development only; hmr, the browser channel and the
 * import map polyfill when HMR is on; scripts.loaders, the component HMR loader when HMR is on.
 *
 * Called by: app/router.ts (render middleware), app/actions/controller.tsx: assets;
 *   scriptEntry and flowStyleHref (this file)
 */
export const assets = createAssetServer({
  basePath: '/assets',
  rootDir,

  allowFiles: ['app/routes.ts', 'app/**/public/**'],
  allowPackages: ['remix'],
  denyFiles: ['app/**/*.test.*'],
  sourceMaps: isDevelopment ? 'external' : undefined,
  minify: !isDevelopment,
  watch: isDevelopment,
  hmr: isHmr
    ? {
        channel: async () => (await import('remix/node-hmr/runtime')).createBrowserHmrChannel(),
        moduleImporter: 'remix/multiple-import-maps-polyfill',
      }
    : undefined,
  scripts: { loaders: isHmr ? [componentHmr()] : undefined },
})

/**
 * The browser entry, relative to rootDir: the module every page loads first.
 *
 * Called by: scriptEntry (this file)
 */
const entry = 'app/actions/public/entry.ts'

/**
 * The built entry: its href, the import map of every module it reaches, and the modules to
 * preload. Awaited at module load, so pages read it synchronously.
 *
 * Called by: app/actions/document.tsx: Document
 */
export const scriptEntry = await assets.getScriptEntry(entry)

/**
 * The React Flow island's stylesheet, emitted by scripts/build-flow.ts next to its bundle.
 * Before the first build it does not exist; the page then renders without it instead of
 * failing.
 *
 * Called by: flowStyleHref (this file)
 */
const flowStyle = 'app/actions/public/flow/flow-bundle.css'

/**
 * The href of the island's stylesheet under /assets, or null when the file is not built yet.
 *
 * Called by: app/actions/page.tsx: Page
 */
export const flowStyleHref = await assets.getHref(flowStyle).catch((error: unknown) => {
  // The reason as text, whatever was thrown.
  let reason = error instanceof Error ? error.message : String(error)
  // Say what is missing and how to fix it, on the server log, once at start.
  console.warn(`Flow island stylesheet unavailable, run "npm run build:flow": ${reason}`)
  // The page checks for null and skips the link.
  return null
})
