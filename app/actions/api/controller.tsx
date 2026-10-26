// controller.tsx: the api route controller, the actions for POST /api/chat and GET /api/graph.
//
// Objective
//   Implement the nested `api` routes of app/routes.ts: `chat` hands the request to the chat
//   module, `graph` returns the demo graph as JSON. Nothing is computed here; the controller
//   only connects a route to the module that answers it.
//
// Dependencies
//   remix/router: createController, which binds the actions to the routes by key.
//   ../../ai/chat.ts: handleChat, the whole chat endpoint (validation, modes, NDJSON stream).
//   ../../fixtures/rag-pipeline.ts: ragPipeline, the graph of the canvas.
//   ../../routes.ts: routes, whose routes.api map these actions implement.
//
// Consumers
//   app/router.ts: the default export, mapped with router.map(routes.api, apiController).
//   app/actions/api/controller.test.ts: through the router.
//
// How it relates to them
//   The browser calls these routes by their typed hrefs (routes.api.chat.href() reaches the
//   panel through the page's props). GET /api/graph returns the same graph the page embeds and
//   the agent's get_flow tool describes. The response contracts belong to the modules: chat.ts
//   owns the NDJSON stream and its status codes, rag-pipeline.ts the shape of the graph
//   (FlowGraph in app/ai/types.ts).
import { createController } from 'remix/router'

import { handleChat } from '../../ai/chat.ts'
import { ragPipeline } from '../../fixtures/rag-pipeline.ts'
import { routes } from '../../routes.ts'

/**
 * The controller for the api route map: one action per key of routes.api.
 *
 * Called by: app/router.ts (router.map)
 */
export default createController(routes.api, {
  actions: {
    /**
     * POST /api/chat: the chat endpoint, answered entirely by handleChat.
     *
     * Called by: app/router.ts, through this default export, for the `chat` route
     * @param context the request context; only its request is used
     * @returns handleChat's Response: an NDJSON stream, or 400 for a bad body
     */
    chat(context) {
      // Hand the raw request over; chat.ts validates it and streams the answer.
      return handleChat(context.request)
    },
    /**
     * GET /api/graph: the canvas's graph as JSON.
     *
     * Called by: app/router.ts, through this default export, for the `graph` route
     * @returns a JSON Response with the FlowGraph of the demo
     */
    graph() {
      // The fixture, serialised as is.
      return Response.json(ragPipeline)
    },
  },
})
