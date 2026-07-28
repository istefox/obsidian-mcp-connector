import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { type } from "arktype";

export function formatMcpError(error: unknown) {
  if (error instanceof ProtocolError) {
    return error;
  }

  if (error instanceof type.errors) {
    const message = error.summary;
    return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
  }

  if (type({ message: "string" }).allows(error)) {
    return new ProtocolError(ProtocolErrorCode.InternalError, error.message);
  }

  return new ProtocolError(
    ProtocolErrorCode.InternalError,
    "An unexpected error occurred",
    error,
  );
}
