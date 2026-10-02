import { type } from "arktype";

export const PortNumber = type("1024<=number.integer<=65535");
export type PortNumber = typeof PortNumber.infer;

export type ServerState =
  | { status: "stopped" }
  | { status: "starting" }
  | { status: "listening"; port: PortNumber }
  | { status: "error"; error: string };
