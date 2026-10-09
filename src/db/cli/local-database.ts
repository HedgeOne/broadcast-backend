import { config } from "../../config/index.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function describeDatabase(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

export function assertLocalDatabase(connectionString: string, action: string): void {
  if (config.isProduction) {
    throw new Error(`Refusing to ${action} with NODE_ENV=production.`);
  }

  const { hostname } = new URL(connectionString);
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(`Refusing to ${action} on non-local host "${hostname}".`);
  }
}
