// controller.test.ts: the API controller through the real router, chat guards and the graph.
//
// Objective
//   Prove that POST /api/chat refuses a malformed request with a 400 and a JSON error before any
//   model is called, and that GET /api/graph serves the canvas graph as JSON. The happy path of
//   POST /api/chat needs Ollama and is not run here; its pure parts are covered by
//   app/ai/chat.test.ts.
//
// Dependencies
//   remix/assert: equal, match and ok, the assertions.
//   remix/test: describe and it, the runner's grouping and cases.
//   ../../router.ts: router, whose fetch runs a Request through the controllers in-process.
//   ../../routes.ts: routes, for the typed hrefs of api.chat and api.graph.
//   No external service: every case ends before Ollama or Qdrant would be contacted.
//
// Consumers
//   `npm test` (package.json) runs it; nothing imports it.
//   app/actions/api/controller.tsx is the module it covers: a change there must keep it green.
//
// How it relates to them
//   The api.chat action delegates to handleChat (app/ai/chat.ts), which must keep validating the
//   body and answering 400 with { error } naming the problem. The api.graph action must keep
//   returning the ragPipeline fixture with its nodes and edges arrays.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { router } from '../../router.ts'
import { routes } from '../../routes.ts'

/**
 * The base URL every test URL is built on. The router does not look at it, but a Request needs an
 * absolute URL, and one constant keeps the cases from repeating a literal.
 *
 * Called by: this file: postChat, the GET /api/graph case
 */
const baseUrl = 'http://localhost'

/**
 * Sends a body to POST /api/chat through the router and returns the Response, so each case
 * states only what it sends and what it expects back.
 *
 * Called by: this file: the three POST /api/chat cases
 * @param body the raw request body, usually a JSON string; a non-JSON string is allowed so a
 *   case can send one on purpose
 * @param contentType the Content-Type header, application/json unless a case overrides it
 * @returns the controller's Response; a 400 for a bad body, as the cases below check
 */
function postChat(body: BodyInit, contentType = 'application/json'): Promise<Response> {
  // One in-process round trip, with the method, header and body a browser would send.
  return router.fetch(
    new Request(new URL(routes.api.chat.href(), baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    }),
  )
}

// The API controller owns /api/*; this group checks its request guards and the graph endpoint.
describe('api controller', () => {
  // Proves that a JSON body with an unknown mode is refused with a 400 whose message names the
  // field. Covers: app/actions/api/controller.tsx: the api.chat action, through handleChat.
  it('POST /api/chat answers 400 to a body that is not a ChatRequest', async () => {
    // Well-formed JSON whose mode is none of the ChatMode values.
    let response = await postChat(JSON.stringify({ mode: 'nope', question: 'x' }))

    // Refused as a client error, not a 500: validation happens before any work starts.
    assert.equal(response.status, 400)
    // The error arrives as JSON with a message, so a client can show it.
    let body = (await response.json()) as { error: string }
    // The message points at the offending field, so the caller knows what to fix.
    assert.match(body.error, /mode/)
  })

  // Proves that a question made only of whitespace is refused like a missing one.
  // Covers: app/actions/api/controller.tsx: the api.chat action, through handleChat.
  it('POST /api/chat answers 400 to an empty question', async () => {
    // A valid mode with a blank question: nothing to ask the LLM.
    let response = await postChat(JSON.stringify({ mode: 'llm', question: '  ' }))

    // Refused before any model call.
    assert.equal(response.status, 400)
  })

  // Proves that a body that does not parse as JSON is refused with a 400 that says so, instead
  // of a 500 from the parser. Covers: app/actions/api/controller.tsx: the api.chat action.
  it('POST /api/chat answers 400 to a body that is not JSON', async () => {
    // A form-encoded body under a text Content-Type, as a wrong client might send.
    let response = await postChat('mode=llm&question=hi', 'text/plain')

    // Still a client error, not a crash.
    assert.equal(response.status, 400)
    // The error is JSON even when the request was not.
    let body = (await response.json()) as { error: string }
    // The message names the real problem, the body's format.
    assert.match(body.error, /JSON/)
  })

  // Proves that the canvas graph is served as JSON with nodes and edges.
  // Covers: app/actions/api/controller.tsx: the api.graph action, serving ragPipeline.
  it('GET /api/graph returns the canvas', async () => {
    // A plain GET on the typed href.
    let response = await router.fetch(new Request(new URL(routes.api.graph.href(), baseUrl)))

    // The route exists and answered.
    assert.equal(response.status, 200)
    // The body is the graph; its title and the shape of its lists are checked here.
    let graph = (await response.json()) as { title: string; nodes: unknown[]; edges: unknown[] }
    // The graph is the RAG pipeline of the fixture, named by its title.
    assert.match(graph.title, /RAG pipeline/)
    // A canvas with no nodes would be an empty page, so at least one is required.
    assert.ok(Array.isArray(graph.nodes) && graph.nodes.length > 0)
    // Edges may be empty in theory, but they must be an array the canvas can map.
    assert.ok(Array.isArray(graph.edges))
  })
})
