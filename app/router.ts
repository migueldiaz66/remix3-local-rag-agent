// router.ts: wires the routes to their controllers and installs the shared middleware.
//
// Objective
//   Build the one router of the app: the static files middleware (public/), the render
//   middleware that gives actions context.render, and the two route maps with their
//   controllers. It also declares the request context type for the whole app.
//
// Dependencies
//   remix/router: createRouter, and the RouterContext type to derive AppContext.
//   remix/middleware/render: render, which adds context.render for components and needs the
//     asset server to resolve the browser entry.
//   remix/middleware/static: staticFiles, which serves ./public as is.
//   ./actions/api/controller.tsx: the controller of routes.api.
//   ./actions/controller.tsx: the controller of the root routes.
//   ./assets.ts: assets, the asset server given to the render middleware.
//   ./routes.ts: routes, the route maps.
//
// Consumers
//   server.ts: router, whose fetch answers every request of the Node server.
//   app/actions/controller.test.ts and app/actions/api/controller.test.ts: router, to call the
//     routes without a server.
//   remix (module augmentation below): AppContext, as the context type of every action.
//
// How it relates to them
//   router.fetch is a Request to Response function, so the server and the tests use it alike.
//   Importing this module has effects: it imports assets.ts, which creates the asset server and
//   awaits its browser entry. The order below is the order a request is handled in: the
//   middleware first, then the maps.
import { createRouter, type RouterContext } from 'remix/router'
import { render } from 'remix/middleware/render'
import { staticFiles } from 'remix/middleware/static'

import apiController from './actions/api/controller.tsx'
import controller from './actions/controller.tsx'
import { assets } from './assets.ts'
import { routes } from './routes.ts'

/**
 * The app's router: static files from ./public first (no directory index), then the render
 * middleware with the asset server, then the routes mapped below.
 *
 * Called by: server.ts (router.fetch), app/actions/controller.test.ts,
 *   app/actions/api/controller.test.ts; router.map (this file)
 */
export const router = createRouter({
  middleware: [staticFiles('./public', { index: false }), render({ assets })],
})

/**
 * The request context every action receives, derived from the router's middleware so that
 * context.render is typed.
 *
 * Called by: the RouterTypes augmentation below; no other file names it
 */
export type AppContext = RouterContext<typeof router>

/**
 * Tells Remix which context type its controllers use, so createController infers AppContext for
 * every action without an explicit annotation.
 *
 * Called by: the TypeScript compiler, for every createController in app/actions/
 */
declare module 'remix' {
  /** Remix's registry of app-level types; only the context is set here. */
  interface RouterTypes {
    // The context type of every action.
    context: AppContext
  }
}

// GET / and GET /assets/*path go to the root controller.
router.map(routes, controller)
// POST /api/chat and GET /api/graph go to the api controller.
router.map(routes.api, apiController)
