import { customType, timestamp } from "drizzle-orm/pg-core";

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export function timestamptz(name: string) {
  return timestamp(name, { withTimezone: true, mode: "date" });
}
