import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExpoPushProvider,
  PushProviderError,
  type PushMessage,
} from "../src/modules/notifications/notifications.provider.js";

const provider = new ExpoPushProvider({
  apiUrl: "https://push.example.invalid/--/api/v2/push/",
  accessToken: "test-expo-access-token",
  requestTimeoutMs: 5000,
});

function message(to: string): PushMessage {
  return {
    to,
    body: "New message",
    data: { type: "direct_message", chatId: "c", messageId: "m", notificationId: "n" },
    sound: "default",
    priority: "high",
    channelId: "messages",
    ttl: 60,
  };
}

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function rejection(promise: Promise<unknown>): Promise<PushProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PushProviderError) return error;
    throw error;
  }
  throw new Error("expected a PushProviderError");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Expo push provider", () => {
  it("posts the batch with the access token and maps tickets in order", async () => {
    const fetchMock = stubFetch(
      json(200, {
        data: [
          { status: "ok", id: "ticket-1" },
          { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
          { status: "error", message: "?" },
        ],
      }),
    );
    const tickets = await provider.send([message("a"), message("b"), message("c")]);
    expect(tickets).toEqual([
      { status: "ok", id: "ticket-1" },
      { status: "error", code: "DeviceNotRegistered" },
      { status: "error", code: "UNKNOWN" },
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://push.example.invalid/--/api/v2/push/send");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer test-expo-access-token",
    );
    expect(JSON.parse(init?.body as string)).toHaveLength(3);
  });

  it("classifies request failures", async () => {
    stubFetch(json(429, {}, { "retry-after": "30" }));
    expect(await rejection(provider.send([message("a")]))).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterSeconds: 30,
    });

    stubFetch(json(503, {}));
    expect(await rejection(provider.send([message("a")]))).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });

    stubFetch(json(400, { errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] }));
    expect(await rejection(provider.send([message("a")]))).toMatchObject({
      code: "PUSH_TOO_MANY_EXPERIENCE_IDS",
      retryable: false,
    });

    stubFetch(json(401, {}));
    expect(await rejection(provider.send([message("a")]))).toMatchObject({
      code: "HTTP_401",
      retryable: false,
    });

    stubFetch(new TypeError("fetch failed"));
    expect(await rejection(provider.send([message("a")]))).toMatchObject({
      code: "NETWORK",
      retryable: true,
    });

    stubFetch(json(200, { data: [] }));
    expect(await rejection(provider.send([message("a")]))).toMatchObject({
      code: "MALFORMED_RESPONSE",
      retryable: true,
    });
  });

  it("refuses batches over Expo's limit", async () => {
    stubFetch(json(200, { data: [] }));
    await expect(
      provider.send(Array.from({ length: 101 }, (_, i) => message(String(i)))),
    ).rejects.toThrow("too many");
  });

  it("returns only the receipts that are ready", async () => {
    const fetchMock = stubFetch(
      json(200, {
        data: {
          "ticket-1": { status: "ok" },
          "ticket-2": { status: "error", details: { error: "MessageRateExceeded" } },
        },
      }),
    );
    const receipts = await provider.receipts(["ticket-1", "ticket-2", "ticket-3"]);
    expect([...receipts]).toEqual([
      ["ticket-1", { status: "ok" }],
      ["ticket-2", { status: "error", code: "MessageRateExceeded" }],
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://push.example.invalid/--/api/v2/push/getReceipts",
    );
  });
});
