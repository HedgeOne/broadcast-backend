export type ErrorDetails = Record<string, unknown>;

// Errors safe to expose to clients. Anything else becomes a generic 500.
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    details?: ErrorDetails;
  };
}

export function errorBody(
  code: string,
  message: string,
  details?: ErrorDetails,
): ErrorResponseBody {
  return { error: details ? { code, message, details } : { code, message } };
}
