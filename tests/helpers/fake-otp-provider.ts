import { randomInt, randomUUID } from "node:crypto";

import {
  OtpProviderError,
  type MobileOtpProvider,
  type OtpProviderErrorKind,
} from "../../src/modules/auth/otp/index.js";

type Operation = "send" | "resend" | "verify";

// Stands in for MSG91's SendOTP V5 API: one pending code per phone number,
// replaced by every send, re-delivered unchanged by resend and spent by a
// successful verify. Codes are readable through `latestCode`, the way a user
// would read them from the SMS.
export class FakeMobileOtpProvider implements MobileOtpProvider {
  readonly name = "fake";

  readonly calls: { operation: Operation; phoneNumber: string; requestId?: string }[] = [];
  delayMs = 0;

  private readonly pending = new Map<string, string>();
  private readonly latest = new Map<string, string>();
  private readonly failures: { operation: Operation; kind: OtpProviderErrorKind }[] = [];

  reset(): void {
    this.calls.length = 0;
    this.pending.clear();
    this.latest.clear();
    this.failures.length = 0;
    this.delayMs = 0;
  }

  failNext(operation: Operation, kind: OtpProviderErrorKind): void {
    this.failures.push({ operation, kind });
  }

  latestCode(phoneNumber: string): string {
    const code = this.latest.get(phoneNumber);
    if (!code) throw new Error(`no code was sent to ${phoneNumber}`);
    return code;
  }

  sendCount(phoneNumber: string): number {
    return this.calls.filter(
      (call) =>
        (call.operation === "send" || call.operation === "resend") &&
        call.phoneNumber === phoneNumber,
    ).length;
  }

  async sendOtp(phoneNumber: string): Promise<{ requestId: string }> {
    await this.prepare("send");
    const requestId = randomUUID().replaceAll("-", "");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pending.set(phoneNumber, code);
    this.latest.set(phoneNumber, code);
    this.calls.push({ operation: "send", phoneNumber, requestId });
    return { requestId };
  }

  async resendOtp(phoneNumber: string): Promise<void> {
    await this.prepare("resend");
    this.calls.push({ operation: "resend", phoneNumber });
    if (!this.pending.has(phoneNumber)) {
      throw new OtpProviderError(this.name, "expired", "no pending otp");
    }
  }

  async verifyOtp(phoneNumber: string, code: string): Promise<void> {
    await this.prepare("verify");
    this.calls.push({ operation: "verify", phoneNumber });
    const current = this.pending.get(phoneNumber);
    if (!current) throw new OtpProviderError(this.name, "expired", "no pending otp");
    if (current !== code) throw new OtpProviderError(this.name, "invalid_code", "mismatch");
    this.pending.delete(phoneNumber);
  }

  private async prepare(operation: Operation): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const index = this.failures.findIndex((failure) => failure.operation === operation);
    if (index >= 0) {
      const [failure] = this.failures.splice(index, 1);
      throw new OtpProviderError(this.name, failure!.kind, `simulated ${failure!.kind}`);
    }
  }
}
