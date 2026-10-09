import { config } from "../../../config/index.js";
import type { IdentityVerifier } from "./identity-verifier.js";
import { Msg91WidgetVerifier } from "./msg91-widget-verifier.js";

export * from "./identity-verifier.js";
export { Msg91WidgetVerifier } from "./msg91-widget-verifier.js";

export function createIdentityVerifier(): IdentityVerifier {
  return new Msg91WidgetVerifier({
    apiBaseUrl: config.msg91.apiBaseUrl,
    authKey: config.msg91.authKey,
    timeoutMs: config.msg91.timeoutMs,
  });
}
