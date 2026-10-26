// build-flow.ts: bundles the React Flow island for the browser.
//
// Objective
//   Why a bundle: react, react-dom and react/jsx-runtime ship CommonJS only, and the Remix asset
//   server compiles ES modules one by one; it refuses CommonJS (COMMONJS_NOT_SUPPORTED). esbuild
//   turns mount.ts and everything it imports into one ES module the asset server serves
//   unchanged, plus one stylesheet. Outputs are ignored by git; the pre-scripts of dev, hmr and
//   start run this.
//
//   Usage: npm run build:flow [-- --dev]   (--dev keeps React's development build and source maps)
//
// Dependencies
//   esbuild, the bundler, used as a library (esbuild.build).
//   process.argv for the --dev flag; performance.now for the timing line.
//   app/actions/public/flow/mount.ts, the entry, and through it react, react-dom, @xyflow/react,
//     the two stylesheets and the island's own modules.
//
// Consumers
//   package.json: the build:flow script, and predev, prehmr and prestart, which run it before
//     the server starts so the bundle is never stale.
//   Its outputs: app/actions/public/flow/flow-bundle.js is loaded by
//     app/actions/public/flow-island.tsx; flow-bundle.css is served through app/assets.ts
//     (flowStyleHref) and linked by app/actions/page.tsx.
//
// How it relates to them
//   The output paths are a contract with the island, app/assets.ts, flow-bundle.d.ts,
//   .gitignore and scripts/check-comments.ts (which skips flow-bundle.*); rename them together.
//   The bundle's JSX is React's (the jsx options below) and the result is self-contained: no
//   import map entry is needed for react. esbuild throws on a build error, which fails the npm
//   script and so the pre-script that called it.
import * as esbuild from 'esbuild'

/**
 * True when the script is run with --dev: React's development build, no minification, source
 * maps. The default is the production build, which is what the POC serves.
 *
 * Called by: the build options and the final log line (this file)
 */
const dev = process.argv.includes('--dev')
/**
 * Where the bundle goes, next to the island that loads it; the stylesheet is emitted beside it
 * as flow-bundle.css. The path is relative to the working directory, which npm sets to the app.
 *
 * Called by: the build options (this file)
 */
const outfile = 'app/actions/public/flow/flow-bundle.js'

// The clock for the log line.
let started = performance.now()
// The build itself. It throws on an error, which ends the script with a non-zero exit code.
let result = await esbuild.build({
  // mount.ts and everything it reaches: the canvas, events.ts, graph-to-flow.ts, the packages.
  entryPoints: ['app/actions/public/flow/mount.ts'],
  // One JS file at this path; the CSS imports become flow-bundle.css next to it.
  outfile,
  // Inline every import, CommonJS ones included; that is the whole point of this script.
  bundle: true,
  // An ES module, the only format the asset server serves.
  format: 'esm',
  // Browser globals and the packages' "browser" entries; no Node built-ins.
  platform: 'browser',
  // Syntax the project's browsers understand without transforms.
  target: ['es2022'],
  // React's automatic runtime: JSX compiles to react/jsx-runtime calls...
  jsx: 'automatic',
  // ...from this package. flow-canvas.tsx repeats the choice in its first line for tsc.
  jsxImportSource: 'react',
  // React reads process.env.NODE_ENV to pick its build; the browser has no process, so inline it.
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  // Small output in production; readable output with --dev.
  minify: !dev,
  // A .map file with a sourceMappingURL comment in --dev; nothing in production.
  sourcemap: dev ? 'linked' : false,
  // Drop the packages' license comments from the output; the license texts stay in node_modules.
  legalComments: 'none',
  // Ask for the metafile, which the log line below reads for the output sizes.
  metafile: true,
  // Quiet unless something is wrong.
  logLevel: 'warning',
})

// One "file (size)" per output, JS and CSS, for the log line.
let outputs = Object.entries(result.metafile.outputs)
  .map(([file, meta]) => `${file} (${(meta.bytes / 1024).toFixed(0)} kB)`)
  .join(', ')
// The one line the pre-scripts print: which build, which files, how long it took.
console.log(
  `build:flow ${dev ? 'development' : 'production'}: ${outputs} ` +
    `in ${Math.round(performance.now() - started)} ms`,
)
