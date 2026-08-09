import { toWebRequest } from "@modelcontextprotocol/node";
import { isLegacyRequest } from "@modelcontextprotocol/server";
import type { IncomingMessage } from "node:http";
import { ERROR_CODES, SUPPORTED_PROTOCOL_VERSIONS } from "../constants";
import {
  buildProtocolVersionErrorBody,
  getHeader,
  isModernProtocolVersion,
  type JsonRpcErrorBody,
  type RequestHeaders,
} from "./middleware";

/**
 * Which protocol era serves a request: the `initialize`-handshake era every
 * currently configured client speaks, or the 2026-07-28 revision reached by
 * probing `server/discover` (ADR-0016).
 */
export type Era = "legacy" | "modern";

/**
 * Classify a request into its protocol era, from the body the caller has
 * already read.
 *
 * `isLegacyRequest` is the SDK entry's own classification step exported as a
 * predicate — it runs the code `createMcpHandler` runs to make the same
 * decision, so this hand-wired router cannot disagree with the handler it
 * routes to.
 *
 * Both arguments are passed to it on purpose. Given only a `Request`, the
 * predicate reads the body from an internal clone; cloning a `Request` whose
 * body has already been read throws a `TypeError`, and `toWebRequest(req,
 * parsedBody)` produces exactly such a request (it serializes the parsed
 * value instead of touching the Node stream). Passing `parsedBody` as well
 * makes the predicate classify from the value directly, cloning nothing. The
 * SDK documents this as needed, not merely faster, for a body already read —
 * which is this transport's case, since `readBodyWithCap` drained the stream
 * before anything here runs (R-08).
 *
 * The `parsedBody === undefined` short-circuit returns before any `Request`
 * is constructed. `undefined` means the body was empty or failed
 * `JSON.parse`, and `toWebRequest(req, undefined)` would then try to read the
 * stream that is already drained, yielding an empty body and a spurious parse
 * error. The SDK classifies an unparseable body as legacy anyway, so the
 * short-circuit is both safe and identical to the entry's own answer.
 */
export async function classifyEra(
  req: IncomingMessage,
  parsedBody: unknown,
): Promise<Era> {
  if (parsedBody === undefined) return "legacy";
  const probe = await toWebRequest(req, parsedBody);
  return (await isLegacyRequest(probe, parsedBody)) ? "legacy" : "modern";
}

/** A deferred protocol-version header answered after classification. */
export type DeferredVersionRejection = {
  status: (typeof ERROR_CODES)["PROTOCOL_VERSION_UNSUPPORTED"];
  body: JsonRpcErrorBody;
};

/**
 * The deferred half of the protocol-version rung (ADR-0016 §3), applied to a
 * request that classified legacy.
 *
 * `checkProtocolVersion` lets a 2026-era header through the middleware chain
 * rather than rejecting it at 400, because only classification can tell
 * whether the SDK's validation ladder owns the answer. A request whose header
 * names a 2026-era revision this server does not serve, and which then
 * classifies legacy, has no such owner — nothing downstream would answer it —
 * so it is rejected here instead, with the same body the middleware would
 * have produced before the rung was split. That keeps the conformance suite's
 * `unsupported-version-400` answer intact.
 *
 * Returns `null` for everything else: an absent header, a revision this
 * server serves, and a pre-2026 revision it does not (`runMiddleware` already
 * rejected that one, before auth, and this function is never reached).
 */
export function applyDeferredVersionRung(
  headers: RequestHeaders,
  parsedBody: unknown,
): DeferredVersionRejection | null {
  const version = getHeader(headers, "mcp-protocol-version");
  if (version === undefined) return null;
  if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return null;
  }
  if (!isModernProtocolVersion(version)) return null;
  return {
    status: ERROR_CODES.PROTOCOL_VERSION_UNSUPPORTED,
    body: buildProtocolVersionErrorBody(parsedBody),
  };
}
