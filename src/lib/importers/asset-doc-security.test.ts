import { describe, expect, it } from "vitest";
import { assetDocMaxBytes, checkAssetDocSize, detectDocumentType } from "./asset-doc-security.ts";

/**
 * Pure-function security boundary (P10-08): magic-byte sniff + whitelist. Each
 * accepted type's magic bytes must pass; spoofed/disallowed/oversize must fail.
 * SVG and HTML are explicitly rejected (stored-XSS defense, ADR-024).
 */

/** Build a buffer from leading magic bytes, padded to ≥12 bytes. */
function magic(bytes: number[]): Buffer {
  const buf = Buffer.alloc(Math.max(16, bytes.length));
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes[i] ?? 0;
  return buf;
}

describe("detectDocumentType", () => {
  it("accepts a PDF (%PDF)", () => {
    const buf = magic([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    expect(detectDocumentType(buf)?.mime).toBe("application/pdf");
  });

  it("accepts a JPEG (FF D8 FF)", () => {
    const buf = magic([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(detectDocumentType(buf)?.mime).toBe("image/jpeg");
  });

  it("accepts a PNG (89 50 4E 47 0D 0A 1A 0A)", () => {
    const buf = magic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectDocumentType(buf)?.mime).toBe("image/png");
  });

  it("accepts a WEBP (RIFF....WEBP)", () => {
    const buf = magic([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    expect(detectDocumentType(buf)?.mime).toBe("image/webp");
  });

  it("accepts a HEIC (ftyp + heic brand)", () => {
    const buf = magic([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    expect(detectDocumentType(buf)?.mime).toBe("image/heic");
  });

  it("rejects an SVG (XML, not in the whitelist — stored-XSS vector)", () => {
    const buf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(detectDocumentType(buf)).toBeNull();
  });

  it("rejects an HTML payload", () => {
    const buf = Buffer.from("<!DOCTYPE html><html><body>hi</body></html>");
    expect(detectDocumentType(buf)).toBeNull();
  });

  it("rejects an executable spoofed with a .pdf name (wrong bytes)", () => {
    const buf = magic([0x4d, 0x5a, 0x90, 0x00]); // "MZ" DOS header
    expect(detectDocumentType(buf)).toBeNull();
  });

  it("rejects a buffer too short to identify", () => {
    expect(detectDocumentType(Buffer.from([0x25, 0x50]))).toBeNull();
  });

  it("rejects an ftyp box with a non-HEIC brand (e.g. an MP4)", () => {
    const buf = magic([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); // "isom"
    expect(detectDocumentType(buf)).toBeNull();
  });
});

describe("asset-doc size limits", () => {
  it("defaults the cap to 10 MB for missing/invalid env", () => {
    const prev = process.env.ASSET_DOC_MAX_FILE_BYTES;
    // An unparseable value exercises the same fallback as an unset var.
    process.env.ASSET_DOC_MAX_FILE_BYTES = "not-a-number";
    expect(assetDocMaxBytes()).toBe(10 * 1024 * 1024);
    if (prev === undefined) {
      process.env.ASSET_DOC_MAX_FILE_BYTES = "";
    } else {
      process.env.ASSET_DOC_MAX_FILE_BYTES = prev;
    }
  });

  it("honors a valid ASSET_DOC_MAX_FILE_BYTES override", () => {
    const prev = process.env.ASSET_DOC_MAX_FILE_BYTES;
    process.env.ASSET_DOC_MAX_FILE_BYTES = "2048";
    expect(assetDocMaxBytes()).toBe(2048);
    if (prev === undefined) {
      process.env.ASSET_DOC_MAX_FILE_BYTES = "";
    } else {
      process.env.ASSET_DOC_MAX_FILE_BYTES = prev;
    }
  });

  it("checkAssetDocSize returns null at/under the cap and an error above", () => {
    expect(checkAssetDocSize(1024)).toBeNull();
    expect(checkAssetDocSize(assetDocMaxBytes() + 1)).toMatch(/MB/);
  });
});
