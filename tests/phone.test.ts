import { describe, expect, it } from "vitest";

import { normalizePhoneNumber, toMsg91Mobile } from "../src/lib/phone.js";

describe("normalizePhoneNumber", () => {
  it.each([
    ["+919876543210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    [" +91-98765-43210 ", "+919876543210"],
    ["+1 415 555 2671", "+14155552671"],
    ["+44 (0) 7911 123456", "+447911123456"],
    ["+61 412 345 678", "+61412345678"],
    ["+65 8123 4567", "+6581234567"],
  ])("normalises %s to %s", (input, expected) => {
    expect(normalizePhoneNumber(input)).toBe(expected);
  });

  it("maps every formatting of a number to one canonical value", () => {
    const variants = ["+919876543210", "+91 98765 43210", "+91 (98765) 43210", "+91.98765.43210"];
    expect(new Set(variants.map(normalizePhoneNumber))).toEqual(new Set(["+919876543210"]));
  });

  it.each([
    ["no country code", "9876543210"],
    ["national trunk prefix only", "09876543210"],
    ["too few digits", "+91 98765"],
    ["too many digits", "+91 98765 432101"],
    ["unassigned range", "+1 555 555 0101"],
    ["unknown country code", "+999 1234567"],
    ["letters", "+91 phone"],
    ["empty", ""],
    ["just a plus", "+"],
    ["overlong input", `+91${"9".repeat(40)}`],
  ])("rejects %s", (_label, input) => {
    expect(normalizePhoneNumber(input)).toBeNull();
  });
});

describe("MSG91 mobile identifiers", () => {
  it("drop the leading plus", () => {
    expect(toMsg91Mobile("+919876543210")).toBe("919876543210");
  });
});
