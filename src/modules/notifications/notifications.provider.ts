// Expo Push Service client. Expo forwards to APNs (iOS) and FCM (Android).
// https://docs.expo.dev/push-notifications/sending-notifications/
//
// Nothing here logs: callers record outcomes by delivery id and error code,
// never tokens or payloads.

// Expo's documented request limits.
export const SEND_BATCH_LIMIT = 100;
export const RECEIPT_BATCH_LIMIT = 1000;

export type PushChatType = "direct" | "group";

// Routing data only: the app validates it and loads the conversation
// through the authenticated API. No message text, names or URLs.
export interface PushData extends Record<string, string> {
  type: "direct_message" | "group_message";
  chatId: string;
  messageId: string;
  // Stable per message (the notification job id), for duplicate
  // suppression on the device.
  notificationId: string;
}

export interface PushMessage {
  to: string;
  body: string;
  data: PushData;
  sound: "default";
  priority: "high";
  // Android channel created by the app before it registers its token.
  channelId: string;
  // Seconds the provider keeps trying to reach an offline device.
  ttl: number;
  badge?: number;
}

export type PushTicket = { status: "ok"; id: string } | { status: "error"; code: string };
export type PushReceipt = { status: "ok" } | { status: "error"; code: string };

// The whole request failed. `retryable` errors (network, timeout, 429,
// 5xx) are retried with backoff; others fail the batch.
export class PushProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(`push provider request failed: ${code}`);
    this.name = "PushProviderError";
  }
}

export interface PushProvider {
  // One ticket per message, in order.
  send(messages: readonly PushMessage[]): Promise<PushTicket[]>;
  // Receipts that are ready; ids without one yet are absent.
  receipts(ids: readonly string[]): Promise<Map<string, PushReceipt>>;
}

// Ticket and receipt errors worth another attempt.
export const RETRYABLE_PUSH_ERRORS = new Set(["MessageRateExceeded", "ExpoError"]);
// The token will never work again; the device registration is revoked.
export const INVALID_TOKEN_ERRORS = new Set(["DeviceNotRegistered"]);

export interface ExpoPushSettings {
  apiUrl: string;
  accessToken?: string | undefined;
  requestTimeoutMs: number;
}

interface ExpoErrorBody {
  errors?: { code?: unknown }[];
}

function errorCodeOf(value: unknown): string {
  if (typeof value !== "object" || value === null) return "UNKNOWN";
  const details = (value as { details?: { error?: unknown } }).details;
  return typeof details?.error === "string" ? details.error : "UNKNOWN";
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

export class ExpoPushProvider implements PushProvider {
  constructor(private readonly settings: ExpoPushSettings) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "accept-encoding": "gzip, deflate",
      "content-type": "application/json",
    };
    if (this.settings.accessToken) headers.authorization = `Bearer ${this.settings.accessToken}`;

    let response: Response;
    try {
      response = await fetch(`${this.settings.apiUrl.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.settings.requestTimeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new PushProviderError(timedOut ? "TIMEOUT" : "NETWORK", true);
    }

    const parsed: unknown = await response.json().catch(() => null);

    if (response.status === 429) {
      throw new PushProviderError(
        "RATE_LIMITED",
        true,
        retryAfter(response.headers.get("retry-after")),
      );
    }
    if (response.status >= 500) throw new PushProviderError("PROVIDER_UNAVAILABLE", true);
    if (!response.ok) {
      const code = (parsed as ExpoErrorBody | null)?.errors?.[0]?.code;
      throw new PushProviderError(
        typeof code === "string" ? code : `HTTP_${response.status}`,
        false,
      );
    }
    return parsed;
  }

  async send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    if (messages.length === 0) return [];
    if (messages.length > SEND_BATCH_LIMIT) throw new Error("too many push messages in one batch");
    const body = (await this.post("/send", messages)) as { data?: unknown } | null;
    const data = body?.data;
    if (!Array.isArray(data) || data.length !== messages.length) {
      throw new PushProviderError("MALFORMED_RESPONSE", true);
    }
    return data.map((ticket: unknown): PushTicket => {
      const value = ticket as { status?: unknown; id?: unknown };
      if (value.status === "ok" && typeof value.id === "string") {
        return { status: "ok", id: value.id };
      }
      return { status: "error", code: errorCodeOf(ticket) };
    });
  }

  async receipts(ids: readonly string[]): Promise<Map<string, PushReceipt>> {
    const result = new Map<string, PushReceipt>();
    if (ids.length === 0) return result;
    if (ids.length > RECEIPT_BATCH_LIMIT) throw new Error("too many receipt ids in one request");
    const body = (await this.post("/getReceipts", { ids })) as { data?: unknown } | null;
    const data = body?.data;
    if (typeof data !== "object" || data === null) {
      throw new PushProviderError("MALFORMED_RESPONSE", true);
    }
    for (const [id, receipt] of Object.entries(data as Record<string, unknown>)) {
      const status = (receipt as { status?: unknown } | null)?.status;
      if (status === "ok") result.set(id, { status: "ok" });
      else if (status === "error") result.set(id, { status: "error", code: errorCodeOf(receipt) });
    }
    return result;
  }
}
