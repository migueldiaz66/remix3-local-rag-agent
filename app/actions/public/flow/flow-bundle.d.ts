// flow-bundle.d.ts: the types of the generated bundle, so the island can import it safely.
//
// Objective
//   flow-island.tsx loads './flow/flow-bundle.js' at run time. That file is written by
//   scripts/build-flow.ts and ignored by git, so TypeScript may never see it. This declaration
//   stands in for it: whatever mount.ts exports, the bundle exports too, with the same types.
//
// Dependencies
//   ./mount.ts, re-exported whole: today that is mountFlow and nothing else.
//
// Consumers
//   tsc, when it checks app/actions/public/flow-island.tsx: its `import('./flow/flow-bundle.js')`
//   resolves to this file, so `flow.mountFlow(...)` is typed without the bundle existing.
//
// How it relates to them
//   The declaration is only true while mount.ts stays the bundle's single entry point in
//   scripts/build-flow.ts. Whoever adds a second entry or renames the output updates all three
//   files in the same change. At run time the bundle is what runs; this file never does.
export * from './mount.ts'
