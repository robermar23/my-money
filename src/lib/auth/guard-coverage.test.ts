// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every way into the app's data is guarded.
 *
 * my-money has no middleware: each page, server action and route handler calls
 * `requireUser()` itself. That is easy to forget on the next new file, and a
 * forgotten guard on a server action is a public endpoint that reads or writes
 * the household's finances. This test reads the source (no Next runtime) and
 * fails on any entry point that cannot reach a guard.
 *
 * "Reaches a guard" means its body calls `requireUser` (routes may also use
 * `getSession`), or calls a function in the same file that does — the accounts
 * actions go through a local `loadAccount` that guards. It does not prove the
 * guard runs first; review still owns that.
 */

const SRC = join(import.meta.dirname, "..", "..");
const APP = join(SRC, "app");

/** Entry points that are public on purpose, as `<path under src/app>#<export>`. */
const PUBLIC = new Set([
  // Signing in cannot require being signed in.
  "login/actions.ts#loginOrBootstrap",
  // Liveness probe for Docker; returns no household data.
  "api/health/route.ts#GET",
  // Plaid calls this; it is authenticated by the Plaid-Verification JWT instead.
  "api/plaid/webhook/route.ts#POST",
  // Ending a session needs no session.
  "logout/route.ts#POST",
]);

/** Pages that render without a session. */
const PUBLIC_PAGES = new Set(["login/page.tsx"]);

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

function appPath(path: string): string {
  return relative(APP, path).split(sep).join("/");
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function isUseServerFile(file: ts.SourceFile): boolean {
  const first = file.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use server"
  );
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** Top-level functions in the file, by name, whether exported or not. */
function topLevelFunctions(file: ts.SourceFile): Map<string, ts.Node> {
  const fns = new Map<string, ts.Node>();
  for (const stmt of file.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      fns.set(stmt.name.text, stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (
          ts.isIdentifier(decl.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          fns.set(decl.name.text, init.body);
        }
      }
    }
  }
  return fns;
}

function exportedFunctionNames(file: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of file.statements) {
    if (!isExported(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) names.push(stmt.name.text);
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
      }
    }
  }
  return names;
}

function callsAny(body: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (names.has(node.expression.text)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/**
 * The guard names reachable in `file`: the base guards plus every top-level
 * function that calls one, to a fixpoint.
 */
function guardsIn(file: ts.SourceFile, base: readonly string[]): Set<string> {
  const guards = new Set(base);
  const fns = topLevelFunctions(file);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of fns) {
      if (!guards.has(name) && callsAny(body, guards)) {
        guards.add(name);
        grew = true;
      }
    }
  }
  return guards;
}

/** `<path>#<export>` for every exported function in `file` that cannot reach a guard. */
function unguardedExports(
  path: string,
  base: readonly string[],
  keep: (name: string) => boolean,
): string[] {
  const file = parse(path);
  const fns = topLevelFunctions(file);
  const guards = guardsIn(file, base);
  const missing: string[] = [];
  for (const name of exportedFunctionNames(file)) {
    if (!keep(name)) continue;
    const id = `${appPath(path)}#${name}`;
    if (PUBLIC.has(id)) continue;
    const body = fns.get(name);
    if (!body || !guards.has(name)) missing.push(id);
  }
  return missing;
}

const files = walk(APP);

describe("auth guard coverage", () => {
  it("every exported server action reaches requireUser", () => {
    const actionFiles = files.filter((path) => isUseServerFile(parse(path)));
    expect(actionFiles.length).toBeGreaterThan(0);
    const missing = actionFiles.flatMap((path) =>
      unguardedExports(path, ["requireUser"], () => true),
    );
    expect(missing, "server actions with no auth guard").toEqual([]);
  });

  it("every route handler reaches requireUser or getSession", () => {
    const routes = files.filter((path) => /(^|[/\\])route\.ts$/.test(path));
    expect(routes.length).toBeGreaterThan(0);
    const missing = routes.flatMap((path) =>
      unguardedExports(path, ["requireUser", "getSession"], (name) => HTTP_METHODS.has(name)),
    );
    expect(missing, "route handlers with no auth guard").toEqual([]);
  });

  it("every page calls requireUser", () => {
    const pages = files.filter((path) => /(^|[/\\])page\.tsx$/.test(path));
    expect(pages.length).toBeGreaterThan(0);
    const missing = pages
      .filter((path) => !PUBLIC_PAGES.has(appPath(path)))
      .filter((path) => !callsAny(parse(path), new Set(["requireUser"])));
    expect(missing.map(appPath), "pages with no requireUser call").toEqual([]);
  });

  it("the allowlist names only entry points that still exist", () => {
    const existing = new Set(
      files.flatMap((path) =>
        exportedFunctionNames(parse(path)).map((n) => `${appPath(path)}#${n}`),
      ),
    );
    for (const id of PUBLIC) expect(existing, `stale allowlist entry ${id}`).toContain(id);
  });
});
