import { z } from "zod";

export const MIN_AGE_YEARS = 16;
export const MAX_AGE_YEARS = 120;
export const DISPLAY_NAME_MAX_LENGTH = 50;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

// Rejects shapes like 2023-02-30 that a Date would silently roll over.
function parseCalendarDate(value: string): CalendarDate | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

// Whole years between two calendar dates. Someone born on 29 Feb has their
// birthday on 1 Mar in non-leap years.
export function ageInYears(birth: CalendarDate, today: CalendarDate): number {
  const hadBirthday =
    today.month > birth.month || (today.month === birth.month && today.day >= birth.day);
  return today.year - birth.year - (hadBirthday ? 0 : 1);
}

function todayUtc(now: Date): CalendarDate {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
}

// Ages are measured against the UTC date, so the boundary can be off by a
// day for users far from UTC; acceptable for an age gate.
export function dateOfBirthSchema(now: () => Date = () => new Date()) {
  return z.string().superRefine((value, ctx) => {
    const birth = parseCalendarDate(value);
    if (!birth) {
      ctx.addIssue({ code: "custom", message: "Use a valid date in YYYY-MM-DD format." });
      return;
    }
    const age = ageInYears(birth, todayUtc(now()));
    if (age < 0) {
      ctx.addIssue({ code: "custom", message: "Date of birth cannot be in the future." });
    } else if (age < MIN_AGE_YEARS) {
      ctx.addIssue({
        code: "custom",
        message: `You must be at least ${MIN_AGE_YEARS} years old.`,
        params: { reason: "too_young", minAge: MIN_AGE_YEARS },
      });
    } else if (age > MAX_AGE_YEARS) {
      ctx.addIssue({ code: "custom", message: "Enter a real date of birth." });
    }
  });
}

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(DISPLAY_NAME_MAX_LENGTH, `Name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`);

// Partial update: omitted fields are left unchanged, but at least one is required.
export function updateMeBody(now?: () => Date) {
  return z
    .object({
      displayName: displayNameSchema.optional(),
      dateOfBirth: dateOfBirthSchema(now).optional(),
    })
    .refine((body) => body.displayName !== undefined || body.dateOfBirth !== undefined, {
      message: "Provide at least one field to update.",
    });
}

export const MAX_DISCOVERY_HASHES = 1000;

// SHA-256 (hex) of E.164 phone numbers normalised on the device.
export const discoverBody = z.object({
  phoneHashes: z
    .array(z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase hex SHA-256 hash."))
    .min(1)
    .max(MAX_DISCOVERY_HASHES),
});

export const userParams = z.object({ userId: z.uuid() });

export type UpdateMeBody = z.infer<ReturnType<typeof updateMeBody>>;
