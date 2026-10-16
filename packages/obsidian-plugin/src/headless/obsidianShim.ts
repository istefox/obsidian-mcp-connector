/**
 * Runtime stand-in for the `obsidian` package in the headless bundle.
 *
 * The real package is declarations only; the desktop build leaves it
 * external and Obsidian supplies it. The headless build aliases the name
 * to this file, so it exports just what the retained tool graph touches
 * at runtime. The file classes are the ones the headless vault creates,
 * which is what makes the tools' `instanceof TFile` checks hold.
 */

import moment from "moment";

export { moment };
export { resolveSubpath } from "./linkResolution";
export {
  parseFrontMatterAliases,
  prepareFuzzySearch,
  sortSearchResults,
} from "./fuzzySearch";

export class TAbstractFile {
  parent: TFolder | null = null;
  name: string;

  constructor(
    readonly vault: unknown,
    public path: string,
  ) {
    this.name = path.slice(path.lastIndexOf("/") + 1);
  }

  /** Re-derive the name after the path changed. */
  syncName(): void {
    this.name = this.path.slice(this.path.lastIndexOf("/") + 1);
  }
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  stat: { ctime: number; mtime: number; size: number };

  constructor(
    vault: unknown,
    path: string,
    stat: { ctime: number; mtime: number; size: number },
  ) {
    super(vault, path);
    this.stat = stat;
    const dot = this.name.lastIndexOf(".");
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
  }

  override syncName(): void {
    super.syncName();
    const dot = this.name.lastIndexOf(".");
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === "/";
  }
}

/** Splits `Note#Heading` into the file part and the `#`-prefixed subpath. */
export function parseLinktext(linktext: string): {
  path: string;
  subpath: string;
} {
  const hash = linktext.indexOf("#");
  if (hash < 0) return { path: linktext, subpath: "" };
  return { path: linktext.slice(0, hash), subpath: linktext.slice(hash) };
}

/** Desktop-only feedback; a headless server has nobody to show it to. */
export class Notice {
  constructor(_message?: string | DocumentFragment, _duration?: number) {}
  setMessage(): this {
    return this;
  }
  hide(): void {}
}
