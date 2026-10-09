import { Writable } from "node:stream";

import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  IOS_DEVICE,
  closeConnections,
  createTestApp,
  resetState,
  verifyEmail,
  type LoginResult,
  type TestContext,
} from "./helpers/auth.js";

afterAll(closeConnections);

describe("auth logging", () => {
  const lines: string[] = [];
  let ctx: TestContext;

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    ctx = await createTestApp({ logger: pino({ level: "trace" }, sink) });
    await resetState();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it("never writes provider tokens or our tokens to the logs", async () => {
    const accessToken = ctx.verifier.issue("quiet@example.com");
    const signedIn = await verifyEmail(ctx.app, { accessToken, device: IOS_DEVICE });
    const replayed = await verifyEmail(ctx.app, { accessToken, device: IOS_DEVICE });
    const rejected = await verifyEmail(ctx.app, {
      accessToken: "forged-provider-token",
      device: IOS_DEVICE,
    });

    expect(signedIn.statusCode).toBe(200);
    expect(replayed.statusCode).toBe(401);
    expect(rejected.statusCode).toBe(401);

    const session = signedIn.json<LoginResult>();
    const output = lines.join("");

    expect(output).toContain("user authenticated");
    expect(output).toContain("provider access token replayed");
    for (const secret of [
      accessToken,
      "forged-provider-token",
      session.accessToken,
      session.refreshToken,
      "test-msg91-auth-key",
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
