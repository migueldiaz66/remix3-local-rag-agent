// controller.tsx: the root route controller, the actions for GET / and GET /assets/*path.
//
// Objective
//   Implement the two top-level routes of app/routes.ts: `home` renders the page with the demo
//   graph and the chat endpoint's href; `assets` serves the browser modules and stylesheets the
//   asset server builds. The nested `api` routes have their own controller in api/.
//
// Dependencies
//   remix/router: createController, which binds the actions to the routes by key.
//   ../assets.ts: assets, the asset server whose fetch answers /assets/* requests.
//   ../fixtures/rag-pipeline.ts: ragPipeline, the graph the page shows.
//   ../routes.ts: routes, the map these actions implement; routes.api.chat.href() for the page.
//   ./page.tsx: Page, the component rendered for GET /.
//
// Consumers
//   app/router.ts: the default export, mapped with router.map(routes, controller).
//   app/actions/controller.test.ts: through the router, as a smoke test of the root routes.
//
// How it relates to them
//   Each action's name is a key of routes (`assets`, `home`). The actions return a Response;
//   `home` gets its Response from context.render, which the render middleware in router.ts
//   provides. The page receives its data as props and never reaches for the request itself.
import { createController } from 'remix/router'

import { assets } from '../assets.ts'
import { ragPipeline } from '../fixtures/rag-pipeline.ts'
import { routes } from '../routes.ts'
import { Page } from './page.tsx'

/**
 * The controller for the root route map: one action per top-level route key.
 *
 * Called by: app/router.ts (router.map)
 */
export default createController(routes, {
  actions: {
    /**
     * GET /assets/*path: a built browser module, stylesheet or source map from the asset server.
     *
     * Called by: app/router.ts, through this default export, for the `assets` route
     * @param context the request context; only its request is used
     * @returns the asset server's Response, or 404 Not Found when it has no such file
     */
    async assets(context) {
      // The asset server answers with the file it built, or with nothing for an unknown path.
      return (await assets.fetch(context.request)) ?? new Response('Not Found', { status: 404 })
    },
    /**
     * GET /: the one page of the POC, rendered on the server.
     *
     * Called by: app/router.ts, through this default export, for the `home` route
     * @param context the request context, with render from the render middleware
     * @returns the HTML Response of Page, with the demo graph and the chat endpoint's href
     */
    home(context) {
      // Render the page; the href comes from routes, so the panel never hard-codes a path.
      return context.render(<Page graph={ragPipeline} chatHref={routes.api.chat.href()} />)
    },
  },
})
