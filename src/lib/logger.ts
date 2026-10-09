import { pino, type LoggerOptions } from "pino";

import { config } from "../config/index.js";

const options: LoggerOptions = {
  level: config.isTest ? "silent" : config.log.level,
  base: { service: "broadcast-backend" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "*.password",
      "*.token",
      "*.accessToken",
      "*.refreshToken",
      "*.otp",
      "*.ciphertext",
    ],
    censor: "[REDACTED]",
  },
};

if (config.isDevelopment) {
  options.transport = {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname,service",
    },
  };
}

export const logger = pino(options);
