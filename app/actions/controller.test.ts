// controller.test.ts: the root controller's smoke test, GET / through the real router.
//
// Objective
//   Prove that the router wired in app/router.ts answers GET / with a complete HTML page. It is
//   the one test that runs the whole server path in-process: the route map, the root controller,
//   the page rendering and the render middleware, without starting an HTTP server.
//
// Dependencies
//   remix/assert: equal and match, the assertions.
//   remix/test: describe and it, the runner's grouping and cases.
//   ../router.ts: router, whose fetch runs a URL or Request through the controllers.
//   ../routes.ts: routes, for the typed href of the home route instead of a literal "/".
//   No external service: the page is rendered from the ragPipeline fixture, so neither
//   Ollama nor Qdrant is contacted.
//
// Consumers
//   `npm test` (package.json) runs it; nothing imports it.
//   app/actions/controller.tsx is the module it covers: a change there must keep this green.
//
// How it relates to them
//   The test may assume router.fetch accepts a URL and returns a standard Response. The root
//   controller must keep answering GET / with a 200, a text/html Content-Type and a full <html>
//   document; a redirect, a fragment or JSON would fail here.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { router } from '../router.ts'
import { routes } from '../routes.ts'

// The root controller owns the top-level routes; this group holds its one smoke test.
describe('root controller', () => {
  // Proves that GET / is served as a complete HTML page by the real router, end to end.
  // Covers: app/actions/controller.tsx: the default export, the action behind routes.home.
  it('GET / returns the home page', async () => {
    // Run the request in-process; the typed href keeps the test honest if the path changes.
    let response = await router.fetch(new URL(routes.home.href(), 'http://localhost'))

    // A 200 means the route exists and the action rendered without throwing.
    assert.equal(response.status, 200)
    // The answer is HTML, not JSON or a redirect: a browser must be able to render it.
    assert.match(response.headers.get('Content-Type') ?? '', /text\/html/)
    // The body is a whole document, not a fragment: the Document layout wrapped the page.
    assert.match(await response.text(), /<html[\s>]/)
  })
})
