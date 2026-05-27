/**
 * Node ESM resolve hook: stub Next.js's `server-only` marker to an empty
 * module so files that carry it can be imported by the BullMQ worker process.
 *
 * In a Next.js build, `import "server-only"` errors out if the module gets
 * bundled into the client. The worker is a plain Node process — it isn't a
 * client, so the marker is functionally a no-op there. We resolve it to an
 * empty data URL rather than removing the marker from the source files,
 * preserving the client-bundle safety check on the Next.js side.
 *
 * Mirrors `vitest.stub-empty.ts` for the worker runtime.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return {
      shortCircuit: true,
      url: "data:text/javascript,export%20%7B%7D;",
      format: "module",
    };
  }
  return nextResolve(specifier, context);
}
