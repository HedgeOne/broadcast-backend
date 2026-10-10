import { Writable } from "node:stream";

import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  IOS_DEVICE,
  closeConnections,
  createTestApp,
  resetState,
  startChallenge,
  testPhone,
  verifyPhone,
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

  it("never writes codes, numbers, challenge ids or tokens to the logs", async () => {
    const phoneNumber = testPhone();
    const { challengeId } = await startChallenge(ctx, phoneNumber);
    const code = ctx.otp.latestCode(phoneNumber);
    const wrongCode = code === "482915" ? "591824" : "482915";

    const wrong = await verifyPhone(ctx.app, { challengeId, code: wrongCode, device: IOS_DEVICE });
    const signedIn = await verifyPhone(ctx.app, { challengeId, code, device: IOS_DEVICE });
    const replayed = await verifyPhone(ctx.app, { challengeId, code, device: IOS_DEVICE });

    ctx.otp.failNext("send", "misconfigured");
    const otherPhone = testPhone();
    const failed = await ctx.app.inject({
      method: "POST",
      url: "/auth/phone/start",
      payload: { phoneNumber: otherPhone },
      remoteAddress: "10.200.0.1",
    });

    expect(wrong.statusCode).toBe(400);
    expect(signedIn.statusCode).toBe(200);
    expect(replayed.statusCode).toBe(410);
    expect(failed.statusCode).toBe(502);

    const session = signedIn.json<LoginResult>();
    const requestIds = ctx.otp.calls.flatMap((call) => (call.requestId ? [call.requestId] : []));
    const output = lines.join("");

    expect(output).toContain("phone otp sent");
    expect(output).toContain("user authenticated");
    expect(output).toContain("otp provider request failed");
    for (const secret of [
      code,
      wrongCode,
      challengeId,
      ...requestIds,
      phoneNumber,
      phoneNumber.slice(1),
      otherPhone,
      otherPhone.slice(1),
      session.accessToken,
      session.refreshToken,
      "test-msg91-auth-key",
      "test-msg91-template-id",
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
