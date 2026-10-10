import { describe, expect, it } from "vitest";

import { parseEnv } from "../src/config/env.js";
import {
  Msg91MobileOtpProvider,
  OtpProviderError,
  type OtpProviderErrorKind,
} from "../src/modules/auth/otp/index.js";

const CONFIG = {
  apiBaseUrl: "https://msg91.test",
  authKey: "auth-key-xyz",
  templateId: "template-abc",
  otpLength: 6,
  otpExpiryMinutes: 15,
  timeoutMs: 1000,
};

const PHONE = "+919876543210";
const MOBILE = "919876543210";
const REQ_ID = "34676b6d426b303131363537";

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: string | undefined;
}

type Reply = { status?: number; body?: unknown; raw?: string } | Error;

// Replies are consumed in order, one per request.
function stubFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl = (
    input: URL,
    init: RequestInit & { headers: Record<string, string>; body?: string },
  ): Promise<Response> => {
    calls.push({
      url: input,
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      redirect: init.redirect,
    });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected request");
    if (reply instanceof Error) return Promise.reject(reply);
    const text = reply.raw ?? JSON.stringify(reply.body);
    return Promise.resolve(
      new Response(text, {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    calls,
    provider: new Msg91MobileOtpProvider(CONFIG, fetchImpl as unknown as typeof fetch),
  };
}

function endpoint(call: Call | undefined): string {
  return call ? call.url.origin + call.url.pathname : "";
}

function query(call: Call | undefined): Record<string, string> {
  return Object.fromEntries(call?.url.searchParams ?? []);
}

async function failure(promise: Promise<unknown>): Promise<OtpProviderError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(OtpProviderError);
  return error as OtpProviderError;
}

async function expectKind(promise: Promise<unknown>, kind: OtpProviderErrorKind) {
  expect((await failure(promise)).kind).toBe(kind);
}

function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

const INVALID_AUTHKEY = {
  status: 401,
  body: { code: "201", type: "error", message: "Invalid authkey" },
};

describe("Msg91MobileOtpProvider", () => {
  describe("sendOtp", () => {
    it("posts to /api/v5/otp with the template, number and code settings", async () => {
      const { provider, calls } = stubFetch({ body: { type: "success", request_id: REQ_ID } });

      await expect(provider.sendOtp(PHONE)).resolves.toEqual({ requestId: REQ_ID });

      const [call] = calls;
      expect(call?.method).toBe("POST");
      expect(endpoint(call)).toBe("https://msg91.test/api/v5/otp");
      expect(query(call)).toEqual({
        template_id: "template-abc",
        mobile: MOBILE,
        otp_length: "6",
        otp_expiry: "15",
        invisible: "0",
        realTimeResponse: "1",
      });
      expect(call?.headers).toMatchObject({
        authkey: "auth-key-xyz",
        "content-type": "application/json",
      });
      expect(call?.body).toBe("{}");
      expect(call?.redirect).toBe("error");
      // The auth key travels in the header, never in this URL.
      expect(call?.url.href).not.toContain("auth-key-xyz");
    });

    it("never sends an OTP of its own", async () => {
      const { provider, calls } = stubFetch({ body: { type: "success", request_id: REQ_ID } });
      await provider.sendOtp(PHONE);
      expect(query(calls[0])).not.toHaveProperty("otp");
    });

    it.each([
      ["missing", { type: "success" }],
      ["malformed", { type: "success", request_id: "bad id!" }],
    ])("fails closed on a success without a usable request_id (%s)", async (_label, body) => {
      const { provider } = stubFetch({ body });
      await expectKind(provider.sendOtp(PHONE), "unavailable");
    });

    it.each<[string, Reply, OtpProviderErrorKind]>([
      ["invalid auth key (401)", INVALID_AUTHKEY, "misconfigured"],
      [
        "auth key missing",
        { status: 401, body: { type: "error", message: "Auth Key missing" } },
        "misconfigured",
      ],
      [
        "invalid template",
        { body: { type: "error", message: "The provided flow ID or template ID is invalid." } },
        "misconfigured",
      ],
      [
        "IP not whitelisted",
        { body: { type: "error", code: "418", message: "IP not whitelisted" } },
        "misconfigured",
      ],
      ["HTTP 429", { status: 429, raw: "Too Many Requests" }, "throttled"],
      [
        "rate limit message",
        { body: { type: "error", message: "Too many requests" } },
        "throttled",
      ],
      ["HTTP 503", { status: 503, raw: "<html>down</html>" }, "unavailable"],
      ["non-JSON body", { raw: "<html>oops</html>" }, "unavailable"],
      ["unknown type", { body: { type: "pending" } }, "unavailable"],
      ["array body", { body: [] }, "unavailable"],
      ["unrecognised error", { body: { type: "error", message: "Something odd" } }, "unavailable"],
      [
        "success with error code",
        { body: { type: "success", code: "201", request_id: REQ_ID } },
        "misconfigured",
      ],
      ["network error", new TypeError("fetch failed"), "unavailable"],
    ])("maps %s", async (_label, reply, kind) => {
      const { provider } = stubFetch(reply);
      await expectKind(provider.sendOtp(PHONE), kind);
    });

    it("reports timeouts", async () => {
      const { provider } = stubFetch(timeoutError());
      const error = await failure(provider.sendOtp(PHONE));
      expect(error.kind).toBe("unavailable");
      expect(error.reason).toContain("timeout");
    });
  });

  describe("resendOtp", () => {
    it("asks /api/v5/otp/retry to resend the same code by text", async () => {
      const { provider, calls } = stubFetch({
        body: { type: "success", message: "retry send successfully" },
      });

      await expect(provider.resendOtp(PHONE)).resolves.toBeUndefined();

      const [call] = calls;
      expect(call?.method).toBe("GET");
      expect(endpoint(call)).toBe("https://msg91.test/api/v5/otp/retry");
      expect(query(call)).toEqual({
        mobile: MOBILE,
        retrytype: "text",
        authkey: "auth-key-xyz",
      });
      expect(call?.headers).toMatchObject({ authkey: "auth-key-xyz" });
      expect(call?.body).toBeUndefined();
    });

    it.each<[string, Reply, OtpProviderErrorKind]>([
      [
        "no pending OTP",
        { body: { type: "error", message: "No OTP request found to retryotp" } },
        "expired",
      ],
      [
        "retry limit",
        { body: { type: "error", message: "OTP retry count maxed out" } },
        "exhausted",
      ],
      [
        "already verified",
        { body: { type: "error", message: "Mobile no. already verified" } },
        "expired",
      ],
      ["invalid auth key", INVALID_AUTHKEY, "misconfigured"],
      ["HTTP 429", { status: 429, raw: "" }, "throttled"],
      [
        "unrecognised error",
        { body: { type: "error", message: "Mobile number empty or not numeric" } },
        "unavailable",
      ],
      ["malformed", { raw: "ok" }, "unavailable"],
    ])("maps %s", async (_label, reply, kind) => {
      const { provider } = stubFetch(reply);
      await expectKind(provider.resendOtp(PHONE), kind);
    });

    it("reports timeouts", async () => {
      const { provider } = stubFetch(timeoutError());
      await expectKind(provider.resendOtp(PHONE), "unavailable");
    });
  });

  describe("verifyOtp", () => {
    it("checks the code with /api/v5/otp/verify, auth key in the header", async () => {
      const { provider, calls } = stubFetch({
        body: { type: "success", message: "OTP verified success" },
      });

      await expect(provider.verifyOtp(PHONE, "123456")).resolves.toBeUndefined();

      const [call] = calls;
      expect(call?.method).toBe("GET");
      expect(endpoint(call)).toBe("https://msg91.test/api/v5/otp/verify");
      expect(query(call)).toEqual({ mobile: MOBILE, otp: "123456" });
      expect(call?.headers).toMatchObject({ authkey: "auth-key-xyz" });
      expect(call?.url.href).not.toContain("auth-key-xyz");
    });

    it.each<[string, Reply, OtpProviderErrorKind]>([
      ["wrong code", { body: { type: "error", message: "OTP not match" } }, "invalid_code"],
      ["expired code", { body: { type: "error", message: "OTP expired" } }, "expired"],
      [
        "already verified",
        { body: { type: "error", message: "Mobile no. already verified" } },
        "expired",
      ],
      [
        "attempt limit",
        { body: { type: "error", message: "Max limit reached for this otp verification" } },
        "exhausted",
      ],
      ["invalid auth key (401)", INVALID_AUTHKEY, "misconfigured"],
      [
        "invalid auth key (HTTP 200)",
        { body: { code: "201", type: "error", message: "Invalid authkey" } },
        "misconfigured",
      ],
      ["HTTP 429", { status: 429, raw: "" }, "throttled"],
      [
        "HTTP 500",
        { status: 500, body: { type: "success", message: "OTP verified success" } },
        "unavailable",
      ],
      [
        "unrecognised error",
        { body: { type: "error", message: "Mobile no. empty or not numeric" } },
        "unavailable",
      ],
      ["non-JSON body", { raw: "verified" }, "unavailable"],
      ["missing type", { body: { message: "OTP verified success" } }, "unavailable"],
      ["network error", new TypeError("fetch failed"), "unavailable"],
    ])("rejects %s", async (_label, reply, kind) => {
      const { provider } = stubFetch(reply);
      await expectKind(provider.verifyOtp(PHONE, "123456"), kind);
    });

    // HTTP 200 + type "success" is not enough on its own.
    it.each([
      ["no message", { type: "success" }],
      ["unexpected message", { type: "success", message: "request accepted" }],
      ["already verified", { type: "success", message: "Mobile no. already verified" }],
      ["error code on success", { type: "success", code: "201", message: "OTP verified success" }],
    ])("fails closed on an unconfirmed success (%s)", async (_label, body) => {
      const { provider } = stubFetch({ body });
      await expect(provider.verifyOtp(PHONE, "123456")).rejects.toBeInstanceOf(OtpProviderError);
    });

    it("rejects malformed codes without calling MSG91", async () => {
      const { provider, calls } = stubFetch();
      await expectKind(provider.verifyOtp(PHONE, "12a456"), "invalid_code");
      expect(calls).toHaveLength(0);
    });

    it("reports timeouts", async () => {
      const { provider } = stubFetch(timeoutError());
      const error = await failure(provider.verifyOtp(PHONE, "123456"));
      expect(error.kind).toBe("unavailable");
      expect(error.reason).toContain("timeout");
    });

    it("never puts codes, numbers or credentials in error reasons", async () => {
      const { provider } = stubFetch({
        body: { type: "error", message: `OTP 987654 for ${MOBILE} not match` },
      });
      const error = await failure(provider.verifyOtp(PHONE, "987654"));
      for (const secret of ["987654", MOBILE, "auth-key-xyz", "template-abc"]) {
        expect(error.message).not.toContain(secret);
      }
    });
  });

  it.each(["authKey", "templateId"] as const)("refuses to start without %s", (key) => {
    expect(() => new Msg91MobileOtpProvider({ ...CONFIG, [key]: " " })).toThrow(key);
  });

  it.each([
    ["otpLength", 3],
    ["otpLength", 10],
    ["otpExpiryMinutes", 0],
    ["otpExpiryMinutes", 10_081],
    ["otpExpiryMinutes", 1.5],
  ] as const)("refuses %s = %s", (key, value) => {
    expect(() => new Msg91MobileOtpProvider({ ...CONFIG, [key]: value })).toThrow();
  });
});

describe("environment validation", () => {
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    JWT_ACCESS_SECRET: "x".repeat(32),
    MSG91_AUTH_KEY: "key-value-3",
    MSG91_OTP_TEMPLATE_ID: "template-value-4",
  };

  it("accepts a complete configuration", () => {
    const env = parseEnv(base);
    expect(env.MSG91_OTP_TEMPLATE_ID).toBe("template-value-4");
    expect(env.AUTH_OTP_TTL_SECONDS).toBe(900);
  });

  it.each(["MSG91_AUTH_KEY", "MSG91_OTP_TEMPLATE_ID"] as const)(
    "names a missing %s without printing any values",
    (name) => {
      let message = "";
      try {
        parseEnv({ ...base, [name]: "" });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(name);
      for (const value of Object.values(base)) {
        expect(message).not.toContain(value);
      }
    },
  );

  it("requires the OTP lifetime in whole minutes", () => {
    expect(() => parseEnv({ ...base, AUTH_OTP_TTL_SECONDS: "90" })).toThrow("AUTH_OTP_TTL_SECONDS");
    expect(parseEnv({ ...base, AUTH_OTP_TTL_SECONDS: "600" }).AUTH_OTP_TTL_SECONDS).toBe(600);
  });
});
