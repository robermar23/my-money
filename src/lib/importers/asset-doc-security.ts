/**
 * Proof-of-authenticity document upload security (Phase 10, P10-08, ADR-024).
 *
 * Siblings the import `upload-security.ts` (whose `sanitizeFilename` we reuse)
 * but enforces a *document* whitelist instead of the OFX/CSV one. Proof
 * documents are the most sensitive new data class in the app (vehicle titles,
 * jewelry appraisals, receipts), so the type check is **magic-byte sniffing**
 * against a fixed whitelist — never the client-supplied `Content-Type` or the
 * filename extension, both trivially spoofable.
 *
 * Whitelist: JPEG, PNG, WebP, HEIC images and PDF. **SVG is deliberately
 * excluded** — SVG is XML that can carry inline `<script>`, so serving one
 * (even attachment-only) is a stored-XSS foot-gun. The download route is
 * attachment-only + `nosniff` as a second layer (ADR-024 / P10-10).
 */

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Canonical MIME types accepted for proof documents. */
export const ASSET_DOC_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
] as const;

export type AssetDocMime = (typeof ASSET_DOC_MIME_TYPES)[number];

export interface DetectedDocument {
  /** Canonical MIME, derived from magic bytes — store this, not the header. */
  readonly mime: AssetDocMime;
}

/**
 * ISO-BMFF `ftyp` brands that identify the HEIC/HEIF family. HEIC files are an
 * ISO base-media container whose major/compatible brand names the codec.
 */
const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
  "heif",
]);

/**
 * The maximum proof-document size in bytes. Defaults to 10 MB; override with the
 * `ASSET_DOC_MAX_FILE_BYTES` env var (mirrors `IMPORT_MAX_FILE_BYTES`).
 *
 * @returns The configured cap, or the 10 MB default for missing/invalid values.
 */
export function assetDocMaxBytes(): number {
  const raw = process.env.ASSET_DOC_MAX_FILE_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/**
 * Reject files over the size cap.
 *
 * @param bytes - The candidate file's byte length.
 * @returns A user-facing error message when too large, else null.
 */
export function checkAssetDocSize(bytes: number): string | null {
  const max = assetDocMaxBytes();
  if (bytes > max) {
    return `File is ${(bytes / 1024 / 1024).toFixed(1)} MB; max is ${(max / 1024 / 1024).toFixed(0)} MB`;
  }
  return null;
}

/**
 * Identify a proof document by its magic bytes, returning the canonical MIME or
 * null (reject). The client `Content-Type` and the filename extension are
 * ignored — only the leading bytes decide. SVG/HTML and anything not in the
 * whitelist return null.
 *
 * @param buf - The full file contents (only the header is inspected).
 * @returns The detected document type, or null if it is not an allowed type.
 */
export function detectDocumentType(buf: Buffer): DetectedDocument | null {
  if (buf.length < 12) return null;

  // PDF: "%PDF"
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return { mime: "application/pdf" };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { mime: "image/png" };
  }
  // WEBP: "RIFF" <4-byte size> "WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { mime: "image/webp" };
  }
  // HEIC/HEIF: ISO-BMFF "ftyp" box at bytes 4-7, brand at bytes 8-11.
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.toString("ascii", 8, 12);
    if (HEIC_BRANDS.has(brand)) {
      return { mime: "image/heic" };
    }
  }
  return null;
}
