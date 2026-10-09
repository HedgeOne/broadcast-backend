import { describe, expect, it, vi } from "vitest";

import {
  IdentityProviderUnavailableError,
  IdentityTokenRejectedError,
  Msg91WidgetVerifier,
} from "../src/modules/auth/verification/index.js";

const CONFIG = {
  apiBaseUrl: "https://control.msg91.com",
  authKey: "secret-auth-key",
  timeoutMs: 1000,
};

function respond(status: number, body: unknown) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected rejection");
}

describe("Msg91WidgetVerifier", () => {
  it("calls verifyAccessToken with the auth key and token in the body", async () => {
    const fetchMock = respond(200, { type: "success", message: "user@example.com" });
    const verifier = new Msg91WidgetVerifier(CONFIG, fetchMock);

    await verifier.verifyAccessToken("widget-jwt");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect((url as URL).href).toBe("https://control.msg91.com/api/v5/widget/verifyAccessToken");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      authkey: "secret-auth-key",
      "access-token": "widget-jwt",
    });
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("returns the verified email from the success response", async () => {
    const verifier = new Msg91WidgetVerifier(
      CONFIG,
      respond(200, { type: "success", message: " User@Example.com " }),
    );

    await expect(verifier.verifyAccessToken("t")).resolves.toEqual({
      channel: "email",
      identifier: "user@example.com",
    });
  });

  it("recognises a verified mobile number as the sms channel", async () => {
    const verifier = new Msg91WidgetVerifier(
      CONFIG,
      respond(200, { type: "success", message: "919999999999" }),
    );

    await expect(verifier.verifyAccessToken("t")).resolves.toEqual({
      channel: "sms",
      identifier: "919999999999",
    });
  });

  it("treats an error response as a rejected token", async () => {
    const verifier = new Msg91WidgetVerifier(
      CONFIG,
      respond(200, { type: "error", message: "access token expired", code: 702 }),
    );

    const error = await captureError(verifier.verifyAccessToken("t"));
    expect(error).toBeInstanceOf(IdentityTokenRejectedError);
    expect(error.message).toContain("access token expired");
  });

  it("treats a non-whitelisted server IP (code 418) as our misconfiguration", async () => {
    const verifier = new Msg91WidgetVerifier(
      CONFIG,
      respond(200, { type: "error", message: "AuthenticationFailure", code: "418" }),
    );

    const error = await captureError(verifier.verifyAccessToken("t"));
    expect(error).toBeInstanceOf(IdentityProviderUnavailableError);
    expect(error.message).toContain("IP not whitelisted");
  });

  it("treats an auth key rejection (code 201) as our misconfiguration, not the user's", async () => {
    const verifier = new Msg91WidgetVerifier(
      CONFIG,
      respond(200, { type: "error", message: "AuthenticationFailure", code: "201" }),
    );

    const error = await captureError(verifier.verifyAccessToken("t"));
    expect(error).toBeInstanceOf(IdentityProviderUnavailableError);
    expect(error.message).toContain("auth key rejected");
  });

  it("treats 4xx responses as a rejected token", async () => {
    const verifier = new Msg91WidgetVerifier(
      CONFIG,
      respond(401, { type: "error", message: "invalid authkey" }),
    );

    expect(await captureError(verifier.verifyAccessToken("t"))).toBeInstanceOf(
      IdentityTokenRejectedError,
    );
  });

  it("treats 5xx and 429 responses as provider unavailability", async () => {
    for (const status of [500, 503, 429]) {
      const verifier = new Msg91WidgetVerifier(CONFIG, respond(status, { message: "busy" }));
      expect(await captureError(verifier.verifyAccessToken("t"))).toBeInstanceOf(
        IdentityProviderUnavailableError,
      );
    }
  });

  it("treats a success without a usable identifier as unavailability, not success", async () => {
    const verifier = new Msg91WidgetVerifier(
      CONFIG,
      respond(200, { type: "success", message: "verified" }),
    );

    expect(await captureError(verifier.verifyAccessToken("t"))).toBeInstanceOf(
      IdentityProviderUnavailableError,
    );
  });

  it("maps network failures and timeouts to unavailability", async () => {
    const network = new Msg91WidgetVerifier(
      CONFIG,
      vi.fn<typeof fetch>(() => Promise.reject(new TypeError("fetch failed"))),
    );
    const timeout = new Msg91WidgetVerifier(
      CONFIG,
      vi.fn<typeof fetch>(() =>
        Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
      ),
    );

    const networkError = await captureError(network.verifyAccessToken("t"));
    const timeoutError = await captureError(timeout.verifyAccessToken("t"));
    expect(networkError).toBeInstanceOf(IdentityProviderUnavailableError);
    expect(timeoutError.message).toContain("timeout");
  });

  it("never includes the token or auth key in error messages", async () => {
    const verifier = new Msg91WidgetVerifier(
      CONFIG,
      respond(400, { type: "error", message: "bad request" }),
    );

    const error = await captureError(verifier.verifyAccessToken("super-secret-widget-token"));
    expect(error.message).not.toContain("super-secret-widget-token");
    expect(error.message).not.toContain("secret-auth-key");
  });
});
