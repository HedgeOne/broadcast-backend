import { z } from "zod";

export const identityAssertionBody = z.object({
  purpose: z.enum(["register", "refresh", "recover"]),
  assurance: z.enum(["normal", "recent", "step-up"]).default("normal"),
  environment: z.enum(["sandbox", "production"]),
  publishableKey: z.string().trim().min(1).max(256),
  migration: z
    .object({
      action: z.enum(["prepare", "inspect", "cutover", "rollback", "finalize"]),
      providerRole: z.enum(["source", "target"]),
    })
    .optional(),
});

export type IdentityAssertionBody = z.infer<typeof identityAssertionBody>;
