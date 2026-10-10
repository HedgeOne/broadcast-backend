import { toMsg91Mobile } from "../../../lib/phone.js";
import {
  OtpProviderError,
  type MobileOtpProvider,
  type OtpProviderErrorKind,
} from "./mobile-otp-provider.js";

export interface Msg91MobileOtpConfig {
  apiBaseUrl: string;
  authKey: string;
  templateId: string;
  // Digits in the generated code (MSG91: 4–9).
  otpLength: number;
  // Lifetime of the generated code (MSG91: 1–10080 minutes).
  otpExpiryMinutes: number;
  timeoutMs: number;
}

interface Msg91Response {
  type?: unknown;
  message?: unknown;
  code?: unknown;
  request_id?: unknown;
}

type Operation = "send" | "resend" | "verify";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,200}$/;
const OTP_PATTERN = /^\d{4,9}$/;

// MSG91 classic SendOTP V5 API (https://docs.msg91.com/otp), called only
// from the backend:
//   POST /api/v5/otp?template_id&mobile&otp_length&otp_expiry&invisible=0&realTimeResponse=1
//        header authkey, JSON body                   → {type: "success", request_id}
//   GET  /api/v5/otp/retry?mobile&retrytype=text&authkey → {type: "success", message}
//   GET  /api/v5/otp/verify?mobile&otp, header authkey  → {type: "success", message: "OTP verified success"}
// MSG91 generates the code and keys it by mobile number (digits with country
// code, no "+"). Most failures arrive as HTTP 200 with
// {type: "error", message, code?}, so the HTTP status never implies success.
export class Msg91MobileOtpProvider implements MobileOtpProvider {
  readonly name = "msg91";

  constructor(
    private readonly config: Msg91MobileOtpConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const missing = (["authKey", "templateId"] as const).filter((key) => config[key].trim() === "");
    if (missing.length > 0) {
      throw new Error(`MSG91 mobile OTP provider is missing configuration: ${missing.join(", ")}`);
    }
    if (!Number.isInteger(config.otpLength) || config.otpLength < 4 || config.otpLength > 9) {
      throw new Error("MSG91 OTP length must be an integer from 4 to 9");
    }
    if (
      !Number.isInteger(config.otpExpiryMinutes) ||
      config.otpExpiryMinutes < 1 ||
      config.otpExpiryMinutes > 10_080
    ) {
      throw new Error("MSG91 OTP expiry must be a whole number of minutes from 1 to 10080");
    }
  }

  async sendOtp(phoneNumber: string): Promise<{ requestId: string }> {
    const payload = await this.call("send", "POST", "/api/v5/otp", {
      template_id: this.config.templateId,
      mobile: toMsg91Mobile(phoneNumber),
      otp_length: String(this.config.otpLength),
      otp_expiry: String(this.config.otpExpiryMinutes),
      // Invisible verification would mark the number verified without a
      // code being entered; it must stay off for server-side sign-in.
      invisible: "0",
      // Without it MSG91 may answer from cache and hide the real error.
      realTimeResponse: "1",
    });

    if (typeof payload.request_id !== "string" || !REQUEST_ID_PATTERN.test(payload.request_id)) {
      throw this.error("unavailable", "send: success response without a request_id");
    }
    return { requestId: payload.request_id };
  }

  async resendOtp(phoneNumber: string): Promise<void> {
    await this.call("resend", "GET", "/api/v5/otp/retry", {
      mobile: toMsg91Mobile(phoneNumber),
      // MSG91 defaults to a voice call.
      retrytype: "text",
      // Documented as a query parameter for this endpoint only; it is also
      // sent as a header like every other call.
      authkey: this.config.authKey,
    });
  }

  async verifyOtp(phoneNumber: string, code: string): Promise<void> {
    if (!OTP_PATTERN.test(code)) {
      throw this.error("invalid_code", "verify: code is not 4-9 digits");
    }

    const payload = await this.call("verify", "GET", "/api/v5/otp/verify", {
      mobile: toMsg91Mobile(phoneNumber),
      otp: code,
    });

    // `type: "success"` alone is not trusted: the documented confirmation
    // is "OTP verified success". Anything else fails closed.
    const message = typeof payload.message === "string" ? payload.message.toLowerCase() : "";
    if (!/\bverified\b/.test(message) || /already/.test(message)) {
      throw this.error(
        "unavailable",
        `verify: unrecognised success response: ${describe(payload)}`,
      );
    }
  }

  private async call(
    operation: Operation,
    method: "GET" | "POST",
    path: string,
    query: Record<string, string>,
  ): Promise<Msg91Response> {
    const url = new URL(path, this.config.apiBaseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          authkey: this.config.authKey,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        // The template needs no variables besides the generated ##OTP##.
        ...(method === "POST" ? { body: "{}" } : {}),
        // Never forward the auth key to another host.
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw this.error("unavailable", `${operation}: ${timedOut ? "timeout" : "network error"}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const body: Msg91Response =
      typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};

    if (response.status === 429) {
      throw this.error("throttled", `${operation}: HTTP 429`);
    }
    if (response.status >= 500) {
      throw this.error("unavailable", `${operation}: HTTP ${response.status}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw this.error("misconfigured", `${operation}: auth key rejected: ${describe(body)}`);
    }

    if (body.type === "success" && codeOf(body) === "") return body;
    if (body.type === "error" || body.type === "success") {
      throw this.error(classify(body, operation), `${operation}: ${describe(body)}`);
    }
    throw this.error("unavailable", `${operation}: malformed response (HTTP ${response.status})`);
  }

  private error(kind: OtpProviderErrorKind, reason: string): OtpProviderError {
    return new OtpProviderError(this.name, kind, reason);
  }
}

// MSG91 documents its OTP failures by message text, e.g. "OTP not match",
// "OTP expired", "No OTP request found to retryotp", "OTP retry count maxed
// out", "Invalid authkey" (code 201). Unrecognised errors are "unavailable"
// so they never look like a usable answer.
function classify(payload: Msg91Response, operation: Operation): OtpProviderErrorKind {
  const code = codeOf(payload);
  const text = typeof payload.message === "string" ? payload.message.toLowerCase() : "";

  // 201 = invalid auth key; 418 = calling IP not whitelisted for the key.
  if (code === "201" || code === "418" || /auth ?key|whitelist/.test(text)) {
    return "misconfigured";
  }
  if (/template|flow id|sender|dlt/.test(text)) return "misconfigured";

  if (operation === "verify") {
    if (/already verified|expire|no otp|not found|request/.test(text)) return "expired";
    if (/not match|mismatch|invalid otp|incorrect|wrong/.test(text)) return "invalid_code";
    if (/max|limit|attempt|exceed|too many|blocked/.test(text)) return "exhausted";
    return "unavailable";
  }

  if (operation === "resend") {
    if (/already verified|expire|no otp|not found/.test(text)) return "expired";
    if (/retry count|maxed|max retry/.test(text)) return "exhausted";
    if (/too many|limit|exceed|blocked/.test(text)) return "throttled";
    return "unavailable";
  }

  if (/too many|limit|exceed|blocked/.test(text)) return "throttled";
  return "unavailable";
}

function codeOf(payload: Msg91Response): string {
  return typeof payload.code === "string" || typeof payload.code === "number"
    ? String(payload.code)
    : "";
}

// Provider error text for logs. Digit runs are masked in case MSG91 echoes a
// number or code back.
function describe(payload: Msg91Response): string {
  const detail = typeof payload.message === "string" ? payload.message : "no details";
  const code = codeOf(payload);
  return `${detail.slice(0, 200).replace(/\d{4,}/g, "[digits]")}${code ? ` (code ${code})` : ""}`;
}
