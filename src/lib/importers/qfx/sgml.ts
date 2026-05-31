import { QfxParseError } from "./types.ts";

/**
 * Minimal SGML reader for OFX 1.x.
 *
 * OFX 1.x body grammar:
 *   - Aggregate (container) elements have explicit close tags:
 *       <STMTTRN> ... </STMTTRN>
 *   - Leaf elements omit the close tag and run to the next '<':
 *       <TRNAMT>-12.34
 *   - Leaves MAY also include an explicit close (OFX 2.x style):
 *       <BALAMT>1234.56</BALAMT>
 *
 * Algorithm:
 *   1. Scan to the first '<'.
 *   2. Read a tag.
 *      - If it's an aggregate (the next non-whitespace token is another '<'),
 *        push a new node.
 *      - If it's a leaf (the next non-whitespace token is a value), capture
 *        the value, then check whether an explicit close follows and consume
 *        it if so. Either way, attach the leaf to the current aggregate.
 *   3. On a closing tag, pop until the matching aggregate is closed.
 */

export interface SgmlNode {
  readonly tag: string;
  readonly value: string | null;
  readonly children: SgmlNode[];
}

interface MutableSgmlNode {
  tag: string;
  value: string | null;
  children: MutableSgmlNode[];
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

export function parseSgml(body: string): SgmlNode {
  let i = 0;
  const len = body.length;

  function skipWhitespace(): void {
    while (i < len && isWhitespace(body[i])) i++;
  }

  function readTagAt(pos: number): { name: string; closing: boolean; end: number } | null {
    if (body[pos] !== "<") return null;
    let j = pos + 1;
    let closing = false;
    if (body[j] === "/") {
      closing = true;
      j++;
    }
    const start = j;
    while (j < len && body[j] !== ">") j++;
    if (j >= len) return null;
    const name = body.slice(start, j).trim().toUpperCase();
    if (!name) return null;
    return { name, closing, end: j + 1 };
  }

  function consumeTag(): { name: string; closing: boolean } {
    const result = readTagAt(i);
    if (!result) {
      throw new QfxParseError("Malformed or unterminated tag", i);
    }
    i = result.end;
    return { name: result.name, closing: result.closing };
  }

  // Skip everything before the first '<'.
  while (i < len && body[i] !== "<") i++;
  if (i >= len) {
    throw new QfxParseError("No SGML body found");
  }

  // Root tag.
  const rootTag = consumeTag();
  if (rootTag.closing) {
    throw new QfxParseError(`Unexpected closing tag </${rootTag.name}> at document start`, i);
  }
  const root: MutableSgmlNode = { tag: rootTag.name, value: null, children: [] };
  const stack: MutableSgmlNode[] = [root];

  while (i < len) {
    skipWhitespace();
    if (i >= len) break;

    if (body[i] !== "<") {
      // Bare text outside of any leaf — ignore (OFX uses only tag-delimited content).
      i++;
      continue;
    }

    const peek = readTagAt(i);
    if (!peek) {
      throw new QfxParseError("Malformed tag", i);
    }

    if (peek.closing) {
      consumeTag();
      const top = stack[stack.length - 1];
      if (!top) {
        throw new QfxParseError(`Unbalanced closing tag </${peek.name}>`, i);
      }
      if (top.tag !== peek.name) {
        throw new QfxParseError(
          `Mismatched closing tag </${peek.name}> while inside <${top.tag}>`,
          i,
        );
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(top);
      } else {
        // Closed the root — done.
        return finalize(top);
      }
      continue;
    }

    // Opening tag.
    consumeTag();
    const node: MutableSgmlNode = { tag: peek.name, value: null, children: [] };

    // Decide aggregate vs. leaf by looking at the next non-whitespace position.
    const savedI = i;
    skipWhitespace();
    if (body[i] === "<") {
      // Aggregate. Push and let the loop handle children.
      stack.push(node);
      continue;
    }

    // Leaf — capture value (to the next '<'), then optionally consume an
    // explicit closing tag.
    i = savedI; // preserve any leading whitespace in the value? Not needed; trim below.
    const valStart = i;
    while (i < len && body[i] !== "<") i++;
    node.value = body.slice(valStart, i).trim();

    // Optional explicit close.
    const closeLook = readTagAt(i);
    if (closeLook?.closing && closeLook.name === peek.name) {
      i = closeLook.end;
    }

    const parent = stack[stack.length - 1];
    if (!parent) {
      throw new QfxParseError(`Leaf <${peek.name}> with no parent`, i);
    }
    parent.children.push(node);
  }

  // EOF — root was never closed. Tolerate by returning what we have.
  while (stack.length > 1) {
    const child = stack.pop();
    const parent = stack[stack.length - 1];
    if (!child || !parent) break;
    parent.children.push(child);
  }
  const finalRoot = stack[0];
  if (!finalRoot) {
    throw new QfxParseError("Empty SGML document");
  }
  return finalize(finalRoot);
}

function finalize(node: MutableSgmlNode): SgmlNode {
  return {
    tag: node.tag,
    value: node.value,
    children: node.children.map(finalize),
  };
}

export function findFirst(node: SgmlNode, tag: string): SgmlNode | null {
  if (node.tag === tag) return node;
  for (const child of node.children) {
    const found = findFirst(child, tag);
    if (found) return found;
  }
  return null;
}

export function findAll(node: SgmlNode, tag: string): SgmlNode[] {
  const out: SgmlNode[] = [];
  function walk(n: SgmlNode): void {
    if (n.tag === tag) out.push(n);
    for (const c of n.children) walk(c);
  }
  walk(node);
  return out;
}

export function childValue(node: SgmlNode, tag: string): string | null {
  for (const child of node.children) {
    if (child.tag === tag) return child.value;
  }
  return null;
}
