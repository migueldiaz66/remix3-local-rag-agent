// server.ts: the Node HTTP server of the app; every request goes to the Remix router.
//
// Objective
//   Start the server: listen on PORT (44100 by default), hand each request to router.fetch
//   through Remix's Node adapter, tell the HMR runner when ready, and close cleanly on SIGINT
//   and SIGTERM. `npm run start` and `npm run dev` run this file directly (dev with a watcher
//   that restarts it); `npm run hmr` runs it as a child of hmr.ts, behind a proxy.
//
// Dependencies
//   node:http: createServer, the HTTP server.
//   remix/node-fetch-server: createRequestListener, which turns Node's request and response
//     into a fetch Request and Response for the router.
//   remix/node-hmr/runtime (dynamic, HMR only): emitServerReady, which tells hmr.ts the new
//     server process accepts requests.
//   ./app/router.ts: router, whose fetch answers everything.
//   PORT, HMR_PROXY_PORT and REMIX_NODE_HMR: environment variables; hmr.ts gives its child the
//     first two, and REMIX_NODE_HMR=1 marks an HMR run.
//
// Consumers
//   package.json: the start and dev scripts run this file with Node.
//   hmr.ts: run('server.ts', ...) runs it as a child process and restarts it on changes.
//   Nothing imports it; it exports nothing.
//
// How it relates to them
//   Under HMR the real port is the child's (APP_PORT, chosen by hmr.ts) but the URL printed is
//   the proxy's, the one the user opens; trustProxy makes the router read the forwarded
//   headers the proxy adds, so it sees the request as the browser sent it. Shutdown closes the
//   listener and every open connection, then exits 0.
import * as http from 'node:http'
import { createRequestListener } from 'remix/node-fetch-server'

import { router } from './app/router.ts'

/**
 * The port to listen on: PORT, or 44100.
 *
 * Called by: server.listen and the start-up log (this file)
 */
const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 44100
/**
 * The HMR proxy's port when hmr.ts runs this server as its child, or null when it runs alone;
 * only used to print the URL the user should open.
 *
 * Called by: the start-up log (this file)
 */
const hmrProxyPort = process.env.HMR_PROXY_PORT
  ? Number.parseInt(process.env.HMR_PROXY_PORT, 10)
  : null
/**
 * Whether hmr.ts runs this server, which is marked with REMIX_NODE_HMR=1.
 *
 * Called by: server and server.listen (this file)
 */
const isHmr = process.env.REMIX_NODE_HMR === '1'

/**
 * The HTTP server; every request becomes a fetch Request for router.fetch. Behind the HMR proxy,
 * trustProxy reads the X-Forwarded headers so the router sees the browser's host and protocol.
 *
 * Called by: server.listen and shutdown (this file)
 */
const server = http.createServer(createRequestListener(router.fetch, { trustProxy: isHmr }))

// Start listening; the callback runs once the port is bound.
server.listen(port, () => {
  // Under HMR, tell the runner the new process is ready, so the proxy sends requests to it.
  if (isHmr) {
    // The runtime is loaded only now, so a plain run never imports it.
    import('remix/node-hmr/runtime').then((nodeHmr) => nodeHmr.emitServerReady())
  }

  // The URL to open: the proxy's port under HMR, this server's otherwise.
  console.log(`Server listening on http://localhost:${hmrProxyPort ?? port}`)
})

// Set by the first signal, so a second signal does not close twice.
let shuttingDown = false

/**
 * Stops the server once: stop accepting, exit when closed, and cut every open connection so
 * the close does not wait for idle keep-alive sockets.
 *
 * Called by: process.on('SIGINT') and process.on('SIGTERM') (this file)
 */
function shutdown() {
  // A second signal while closing does nothing.
  if (shuttingDown) {
    // Already on the way out.
    return
  }

  // From here on, shutdown is a no-op.
  shuttingDown = true
  // Stop accepting connections; exit with success once the last one has closed.
  server.close(() => process.exit(0))
  // Close the open connections now, so close() completes without waiting for them.
  server.closeAllConnections()
}

// Ctrl-C in the terminal.
process.on('SIGINT', shutdown)
// The stop signal of the HMR runner, a container or a service manager.
process.on('SIGTERM', shutdown)
