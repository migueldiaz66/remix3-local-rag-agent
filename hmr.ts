// hmr.ts: the development proxy of `npm run hmr`, for live server and browser updates.
//
// Objective
//   Run server.ts as a child process that restarts when its code changes, and sit in front of
//   it as a proxy on the port the user opens, so the browser's URL never changes across
//   restarts. The runner also serves the browser's HMR channel, on which changed components are
//   pushed to the page without a reload. `npm run dev` only restarts the server; this adds the
//   browser side.
//
// Dependencies
//   node:http: createServer, the proxy's HTTP server.
//   remix/fetch-proxy: createFetchProxy, a fetch that forwards to the child server and adds
//     the X-Forwarded headers.
//   remix/node-hmr: run, which starts and restarts the child with the given Node arguments and
//     opens the browser channel; createHmrReadyFetch, which holds requests while the child
//     restarts and releases them once it emits ready.
//   remix/node-fetch-server: createRequestListener, Node request to fetch Request.
//   remix/node-tsx and remix/component-hmr/node (by name): the child's --import hooks, to run
//     TypeScript directly and to make components hot-replaceable.
//   PORT, HMR_PORT and APP_PORT: environment variables for the proxy, the channel and the
//     child; 44100, 44101 and 44102 by default.
//   server.ts: the child process, given PORT and HMR_PROXY_PORT. REMIX_NODE_HMR is not set
//     here; server.ts and app/assets.ts rely on the runner to set it for the child.
//
// Consumers
//   package.json: the hmr script runs this file with Node. Nothing imports it; it exports
//     nothing.
//
// How it relates to them
//   server.ts reads HMR_PROXY_PORT to print the proxy's URL and REMIX_NODE_HMR to trust the
//   forwarded headers and to emit ready. The three ports must be free; change PORT and the
//   other two follow. Shutdown closes the proxy, then the child, then exits.
import * as http from 'node:http'

import { createFetchProxy } from 'remix/fetch-proxy'
import { createHmrReadyFetch, run } from 'remix/node-hmr'
import { createRequestListener } from 'remix/node-fetch-server'

/**
 * The proxy's port, the one the user opens: PORT, or 44100.
 *
 * Called by: hmrEventPort, hmrRunner and server.listen (this file)
 */
const hmrProxyPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 44100
/**
 * The browser HMR channel's port: HMR_PORT, or the proxy's plus one (44101).
 *
 * Called by: appPort and hmrRunner (this file)
 */
const hmrEventPort = process.env.HMR_PORT
  ? Number.parseInt(process.env.HMR_PORT, 10)
  : hmrProxyPort + 1
/**
 * The child server's port: APP_PORT, or the channel's plus one (44102).
 *
 * Called by: hmrRunner and server (this file)
 */
const appPort = process.env.APP_PORT ? Number.parseInt(process.env.APP_PORT, 10) : hmrEventPort + 1

/**
 * The runner of server.ts: a child Node process with this environment plus its own PORT and
 * HMR_PROXY_PORT, the TypeScript and component-HMR import hooks, and the browser channel on
 * hmrEventPort. It restarts the child when server code changes.
 *
 * Called by: server (through createHmrReadyFetch) and shutdown (this file)
 */
const hmrRunner = run('server.ts', {
  env: {
    ...process.env,
    PORT: String(appPort),
    HMR_PROXY_PORT: String(hmrProxyPort),
  },
  nodeArgs: ['--import', 'remix/node-tsx', '--import', 'remix/component-hmr/node'],
  browserHmrChannel: { port: hmrEventPort },
})

/**
 * The proxy server: requests wait while the child restarts, then are forwarded to it on
 * 127.0.0.1:appPort with X-Forwarded headers, so the child knows the browser's host.
 *
 * Called by: server.listen and shutdown (this file)
 */
const server = http.createServer(
  createRequestListener(
    createHmrReadyFetch(
      hmrRunner,
      createFetchProxy(`http://127.0.0.1:${appPort}`, {
        xForwardedHeaders: true,
      }),
    ),
  ),
)

// Listen on the loopback interface only; this is a development tool.
server.listen(hmrProxyPort, '127.0.0.1')

// Set by the first signal, so a second signal does not close twice.
let shuttingDown = false

/**
 * Stops the proxy once, then the child, then exits 0 whatever the child's close did.
 *
 * Called by: process.on('SIGINT') and process.on('SIGTERM') (this file)
 */
function shutdown() {
  // A second signal while closing does nothing.
  if (shuttingDown) return
  // From here on, shutdown is a no-op.
  shuttingDown = true
  // Stop accepting; once closed, stop the child and exit when it has stopped, even on failure.
  server.close(() => hmrRunner.close().finally(() => process.exit(0)))
  // Close the open connections now, so close() completes without waiting for them.
  server.closeAllConnections()
}

// Ctrl-C in the terminal.
process.on('SIGINT', shutdown)
// The stop signal of a container or a service manager.
process.on('SIGTERM', shutdown)
