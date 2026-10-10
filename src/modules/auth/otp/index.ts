import { config } from "../../../config/index.js";
import type { MobileOtpProvider } from "./mobile-otp-provider.js";
import { Msg91MobileOtpProvider } from "./msg91-mobile-otp-provider.js";

export * from "./challenge-store.js";
export * from "./mobile-otp-provider.js";
export { Msg91MobileOtpProvider } from "./msg91-mobile-otp-provider.js";

export function createMobileOtpProvider(): MobileOtpProvider {
  return new Msg91MobileOtpProvider(config.msg91);
}
