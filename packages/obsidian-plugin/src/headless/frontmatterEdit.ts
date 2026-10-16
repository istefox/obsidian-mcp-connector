/**
 * The text edit behind `fileManager.processFrontMatter`: parse the YAML
 * block, let the caller mutate the object, write the block back, and
 * leave the body byte for byte as it was.
 */

import { stringify as stringifyYaml } from "yaml";
import { parseFrontmatterBlock } from "./parseMetadata";

/**
 * Apply `fn` to the note's frontmatter and return the new note text.
 *
 * A note without a block gets one when `fn` leaves keys behind. A block
 * that `fn` empties stays as an empty `---` pair rather than vanishing,
 * the less destructive reading of "no properties". Text is returned
 * unchanged when `fn` changed nothing, so comments in the YAML survive a
 * no-op edit.
 */
export function editFrontmatter(
  content: string,
  fn: (frontmatter: Record<string, unknown>) => void,
): string {
  const block = parseFrontmatterBlock(content);
  if (block !== null && block.data === null) {
    throw new Error("The frontmatter is not valid YAML");
  }
  const data: Record<string, unknown> = block?.data ?? {};
  const before = JSON.stringify(data);
  fn(data);
  if (JSON.stringify(data) === before) return content;

  const eol = block?.eol ?? "\n";
  const yaml =
    Object.keys(data).length === 0
      ? ""
      : stringifyYaml(data, { lineWidth: 0 }).replace(/\n/g, eol);

  if (block === null) {
    return yaml === "" ? content : `---${eol}${yaml}---${eol}${content}`;
  }
  return (
    content.slice(0, block.openEnd) + yaml + content.slice(block.closeStart)
  );
}
