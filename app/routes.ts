// routes.ts: the route map, shared by the server and the browser for type-safe hrefs.
//
// Objective
//   Declare every URL of the app once, with its method, so the controllers implement them by
//   key and the browser builds hrefs from them (routes.api.chat.href()) instead of typing
//   paths. This file is on the asset server's allow list, so browser modules may import it.
//
// Dependencies
//   remix/routes: route, to build a map or a nested map with a prefix; get and post, one route
//     each with its method.
//
// Consumers
//   app/router.ts: routes and routes.api, mapped to their controllers.
//   app/actions/controller.tsx: routes, as its map, and routes.api.chat.href() for the page.
//   app/actions/api/controller.tsx: routes.api, as its map.
//   app/assets.ts: names this file in allowFiles, so the browser may load it.
//   app/actions/controller.test.ts and app/actions/api/controller.test.ts: routes, to build
//     the URLs they request.
//
// How it relates to them
//   A route added here needs an action with the same key in the matching controller and, if
//   the browser calls it, an href built from it rather than a string.
import { get, post, route } from 'remix/routes'

/**
 * The route map. Top level: the built assets and the page; under /api, the chat and the graph.
 *
 * Called by: app/router.ts, app/actions/controller.tsx, app/actions/api/controller.tsx,
 *   app/actions/controller.test.ts, app/actions/api/controller.test.ts
 */
export const routes = route({
  // The browser modules, stylesheets and source maps the asset server builds, by path.
  assets: get('/assets/*path'),
  // The one page.
  home: get('/'),
  // The JSON and stream endpoints, as a nested map with the /api prefix.
  api: route('/api', {
    // The chat panel posts a ChatRequest and reads back a stream of StreamEvent lines (NDJSON).
    chat: post('/chat'),
    // The canvas's nodes and edges, also read by the agent's get_flow tool.
    graph: get('/graph'),
  }),
})
