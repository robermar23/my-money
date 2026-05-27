/**
 * Registers the `server-only` stub hook for the current Node process.
 * Loaded via `node --import ./scripts/loaders/register.mjs` in the worker
 * scripts (see package.json). Pair with `--import tsx` for TS support.
 */
import { register } from "node:module";

register("./server-only-hook.mjs", import.meta.url);
