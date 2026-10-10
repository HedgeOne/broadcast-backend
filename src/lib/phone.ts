import { parsePhoneNumberFromString } from "libphonenumber-js/max";

// Clients send numbers already normalised to E.164, but anything with a
// leading "+" and an unambiguous country code is accepted and re-normalised.
// Full ("max") metadata is used so validity is checked against each
// country's real numbering plan, not just its length.
export function normalizePhoneNumber(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("+") || trimmed.length > 32) return null;

  const parsed = parsePhoneNumberFromString(trimmed);
  if (!parsed?.isValid()) return null;
  return parsed.number;
}

// MSG91 identifies mobile numbers as digits with country code and no "+".
export function toMsg91Mobile(e164: string): string {
  return e164.slice(1);
}
