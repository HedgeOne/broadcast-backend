import { describe, expect, it } from "vitest";

import { contentDisposition } from "../src/modules/media/media.storage.js";
import {
  checkDeclared,
  matchesSignature,
  normalizeMimeType,
  sanitizeFileName,
} from "../src/modules/media/media.policy.js";
import { SAMPLES } from "./helpers/media.js";

describe("media policy", () => {
  it("normalizes MIME types and known aliases", () => {
    expect(normalizeMimeType("IMAGE/JPG")).toBe("image/jpeg");
    expect(normalizeMimeType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(normalizeMimeType("audio/mp3")).toBe("audio/mpeg");
  });

  it("checks category, type and extension together", () => {
    expect(checkDeclared({ category: "image", mimeType: "image/jpg", fileName: "a.JPG" })).toEqual({
      ok: true,
      mimeType: "image/jpeg",
    });
    expect(checkDeclared({ category: "image", mimeType: "image/png", fileName: null }).ok).toBe(
      true,
    );
    expect(
      checkDeclared({ category: "document", mimeType: "application/pdf", fileName: null }),
    ).toEqual({
      ok: false,
      reason: "EXTENSION_MISMATCH",
    });
    expect(checkDeclared({ category: "video", mimeType: "image/png", fileName: "a.png" })).toEqual({
      ok: false,
      reason: "TYPE_MISMATCH",
    });
    expect(
      checkDeclared({
        category: "document",
        mimeType: "application/x-msdos-program",
        fileName: "a.exe",
      }),
    ).toEqual({ ok: false, reason: "UNSUPPORTED_TYPE" });
  });

  it("matches file signatures", () => {
    expect(matchesSignature("image/png", SAMPLES.png)).toBe(true);
    expect(matchesSignature("image/jpeg", SAMPLES.jpeg)).toBe(true);
    expect(matchesSignature("application/pdf", SAMPLES.pdf)).toBe(true);
    expect(matchesSignature("video/mp4", SAMPLES.mp4)).toBe(true);
    expect(matchesSignature("audio/mp4", SAMPLES.m4a)).toBe(true);
    expect(matchesSignature("image/png", SAMPLES.exe)).toBe(false);
    expect(matchesSignature("application/pdf", SAMPLES.png)).toBe(false);
    expect(matchesSignature("text/plain", Buffer.from("hello"))).toBe(true);
    expect(matchesSignature("text/plain", SAMPLES.exe)).toBe(false);
    expect(matchesSignature("image/png", new Uint8Array())).toBe(false);
  });

  it("cleans file names", () => {
    expect(sanitizeFileName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("  ..  ")).toBeNull();
    expect(sanitizeFileName("")).toBeNull();
    expect(sanitizeFileName(`${"x".repeat(300)}.pdf`)?.length).toBe(255);
  });

  it("builds a safe download disposition", () => {
    expect(contentDisposition(null)).toBe("attachment");
    expect(contentDisposition('na"me.pdf')).toBe(
      `attachment; filename="na_me.pdf"; filename*=UTF-8''na%22me.pdf`,
    );
    expect(contentDisposition("résumé.pdf")).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });
});
