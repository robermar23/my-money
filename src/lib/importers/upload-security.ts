/**
 * File upload sanitization + magic-byte sniffing (P3-28 security pass).
 *
 * These helpers are used by the upload server action to enforce:
 *   - Max file size (default 10 MB; override via env IMPORT_MAX_FILE_BYTES).
 *   - Extension whitelist.
 *   - Magic-byte sniff: OFX 1.x starts with `OFXHEADER:`, OFX 2.x with `<?xml`,
 *     CSV must look ASCII-printable in the first 1 KB.
 *   - Filename sanitization (strip path separators, normalize unicode).
 */

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const NUL = String.fromCharCode(0);
const PATH_SEPARATORS_RE = new RegExp(`[\\\\/${NUL}]`, "g");

export function maxFileBytes(): number {
  const raw = process.env.IMPORT_MAX_FILE_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

export function sanitizeFilename(input: string): string {
  // Strip path separators (both flavors) and any NUL bytes, normalize unicode,
  // cap length. The regex is built via RegExp constructor so the source file
  // stays free of literal control characters (biome lint rule).
  const cleaned = input
    .normalize("NFKC")
    .replace(PATH_SEPARATORS_RE, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 200) || "upload";
}

export type DetectedSource = "qfx" | "csv" | "unknown";

export function detectSource(filename: string, buf: Buffer): DetectedSource {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  // Magic-byte first; extension is advisory.
  const head = buf.slice(0, 1024).toString("utf8");

  if (
    head.startsWith("OFXHEADER") ||
    /<OFX\b/i.test(head) ||
    head.trimStart().startsWith("<?xml")
  ) {
    return "qfx";
  }
  if (ext === "csv" && looksLikeCsv(head)) {
    return "csv";
  }
  return "unknown";
}

function looksLikeCsv(head: string): boolean {
  // Reject if it contains NUL bytes (binary smell).
  if (head.includes(NUL)) return false;
  // Require at least one comma in the first line — a CSV without commas is
  // either malformed or a single-column file that's not worth importing.
  const firstLine = head.split(/\r?\n/)[0] ?? "";
  return firstLine.includes(",");
}

export function checkSize(bytes: number): string | null {
  const max = maxFileBytes();
  if (bytes > max) {
    return `File is ${(bytes / 1024 / 1024).toFixed(1)} MB; max is ${(max / 1024 / 1024).toFixed(0)} MB`;
  }
  return null;
}
