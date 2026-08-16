import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

/** One `resources/list` entry, as served on the wire. */
export type ResourceListEntry = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

/** A `resources/read` result: one text content block per URI read. */
export type ResourceReadResult = {
  contents: [{ uri: string; mimeType: string; text: string }];
};

type ResourceReader = (uri: string) => Promise<ResourceReadResult>;

/**
 * Registry for the `resources` capability, deliberately shaped like
 * PromptRegistryClass: the transport owns an empty instance and the
 * feature that owns the content fills it at setup time.
 *
 * `list` and `read` are arrow-function properties rather than methods
 * because mcpServer.ts hands them to `setRequestHandler` by reference —
 * a plain method would arrive unbound and lose `this`.
 *
 * Listing is not how a `ui://` resource is discovered: MCP Apps points
 * at it from the tool's own `_meta.ui.resourceUri`, and the extension
 * spec lets a server omit UI-only resources from `resources/list`
 * entirely. The lister exists so the capability answers correctly rather
 * than erroring, and defaults to empty.
 */
export class ResourceRegistryClass {
  private lister: () => Promise<ResourceListEntry[]> = async () => [];
  private reader: ResourceReader | null = null;

  setLister(fn: () => Promise<ResourceListEntry[]>): void {
    this.lister = fn;
  }

  setReader(fn: ResourceReader): void {
    this.reader = fn;
  }

  list = async (): Promise<{ resources: ResourceListEntry[] }> => ({
    resources: await this.lister(),
  });

  read = async (params: { uri: string }): Promise<ResourceReadResult> => {
    if (!this.reader) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Resource not found: ${params.uri}`,
      );
    }
    return this.reader(params.uri);
  };
}

export type ResourceRegistry = ResourceRegistryClass;
