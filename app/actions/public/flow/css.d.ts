// css.d.ts: lets TypeScript accept the stylesheet imports that esbuild bundles.
//
// Objective
//   mount.ts imports '@xyflow/react/dist/style.css' and './flow.css' so that esbuild copies both
//   into flow-bundle.css. TypeScript has no idea what a .css module is and would reject those
//   imports with "Cannot find module"; this ambient declaration tells it that any '*.css' module
//   exists and exports nothing.
//
// Dependencies
//   None. It is a type-only file; nothing in it runs.
//
// Consumers
//   tsc (`npm run typecheck`), which reads every .ts file of the project, and through it
//   app/actions/public/flow/mount.ts, whose stylesheet imports would not compile without it.
//
// How it relates to them
//   The declaration is empty on purpose: the CSS has no JavaScript exports, so a file that tried
//   to import a value from a stylesheet would still fail, which is the right outcome. esbuild
//   never reads this file; it has its own CSS loader.
// Any import whose specifier ends in .css resolves to this empty module shape.
declare module '*.css' {}
