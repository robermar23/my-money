import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/*
 * Shared by the guards that compare a registry against the pages on disk:
 * docs/FEATURES.md (P19-34) and the help registry (P20-03). One walker, so the
 * two guards cannot disagree about what a route is. This folder is test-only
 * and is kept out of the image by .dockerignore.
 */

/** The App Router root every route is relative to. */
export const APP_DIR: string = join(process.cwd(), "src", "app");

/**
 * Every page route under `src/app`, with each dynamic segment written `<id>`.
 *
 * `src/app/accounts/[id]/import/[batchId]/page.tsx` becomes
 * `/accounts/<id>/import/<id>`, and the root page becomes `/`.
 *
 * @param dir - The directory to walk. Defaults to {@link APP_DIR}.
 * @returns The route patterns, in directory-walk order.
 */
export async function pageRoutes(dir: string = APP_DIR): Promise<string[]> {
  const routes: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) routes.push(...(await pageRoutes(path)));
    else if (entry.name === "page.tsx") {
      const rel = relative(APP_DIR, dir).split(sep).join("/");
      routes.push(`/${rel}`.replace(/\[[^\]]+\]/g, "<id>").replace(/\/$/, "") || "/");
    }
  }
  return routes;
}
