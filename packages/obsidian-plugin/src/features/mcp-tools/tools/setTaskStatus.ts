import { type } from "arktype";
import type { App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";
import { errorJson, successJson } from "../services/responseBuilders";
import {
  parseTaskLine,
  renderTaskLine,
  taskStatus,
} from "../services/taskLine";
import { withVaultWriteLock } from "../services/vaultWriteLock";

export const setTaskStatusSchema = type({
  name: '"set_task_status"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path of the markdown file.",
    ),
    line: type("number.integer>=0").describe(
      "0-indexed line of the task, as returned by `list_tasks` or a search hit.",
    ),
    status: type('"open" | "done"').describe(
      "`open` writes `[ ]`; `done` writes `[x]`, or the `marker` character when given.",
    ),
    "marker?": type("string==1").describe(
      'Custom single-character status to write instead of `x` when `status` is `done`, e.g. "/" (in progress), "-" (cancelled), ">" (forwarded). Must not be a space.',
    ),
    "expectedText?": type("string").describe(
      "Precondition: the task text currently on that line (what `list_tasks` returned as `text`). The write is refused with `stale_precondition` if it differs, so a note that moved since you listed it is not changed by accident.",
    ),
  },
}).describe(
  "Ticks or unticks one markdown task in place: only the status character inside `[ ]` changes, indentation, list marker and text are kept byte for byte. The line must be a task (`- [ ] ...`, `1. [x] ...`); anything else is refused. Atomic write through Obsidian's `vault.process`. Returns the previous and new marker and the task text.",
);

export type SetTaskStatusContext = {
  arguments: {
    path: string;
    line: number;
    status: "open" | "done";
    marker?: string;
    expectedText?: string;
  };
  app: App;
};

type Outcome =
  | {
      kind: "ok";
      previous: string;
      marker: string;
      text: string;
      changed: boolean;
    }
  | { kind: "line_out_of_range"; lineCount: number }
  | { kind: "not_a_task"; lineText: string }
  | { kind: "stale_precondition"; text: string };

export async function setTaskStatusHandler(ctx: SetTaskStatusContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, line, status, expectedText } = ctx.arguments;

  if (status === "done" && ctx.arguments.marker === " ") {
    return errorJson(
      'A space marker means `open`; pass `status: "open"` instead of `marker: " "`.',
      "invalid_params",
      { marker: " " },
    );
  }
  const marker = status === "open" ? " " : (ctx.arguments.marker ?? "x");

  const resolved = resolveTFile(ctx.app.vault, path);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson(`File not found: ${path}`, "file_not_found", { path })
      : errorJson(`Path is a folder: ${path}`, "not_a_file", { path });
  }
  const file = resolved.file;
  if (file.extension !== "md") {
    return errorJson(`Not a markdown file: ${path}`, "not_markdown", {
      path,
      targetType: "file",
    });
  }

  // Every check runs inside the atomic read-modify-write so the line
  // that is inspected is the line that is written. Returning the input
  // unchanged from the callback is Obsidian's "do not write" path.
  let outcome: Outcome | undefined;
  try {
    await withVaultWriteLock(() =>
      ctx.app.vault.process(file, (current) => {
        const lines = current.split("\n");
        if (line >= lines.length) {
          outcome = { kind: "line_out_of_range", lineCount: lines.length };
          return current;
        }
        const task = parseTaskLine(lines[line]);
        if (!task) {
          outcome = { kind: "not_a_task", lineText: lines[line] };
          return current;
        }
        const text = task.text.trimEnd();
        if (expectedText !== undefined && expectedText.trimEnd() !== text) {
          outcome = { kind: "stale_precondition", text };
          return current;
        }
        if (task.marker === marker) {
          outcome = {
            kind: "ok",
            previous: marker,
            marker,
            text,
            changed: false,
          };
          return current;
        }
        lines[line] = renderTaskLine(task, marker);
        outcome = {
          kind: "ok",
          previous: task.marker,
          marker,
          text,
          changed: true,
        };
        return lines.join("\n");
      }),
    );
  } catch (error) {
    return errorJson(
      `Failed to update ${path}: ${error instanceof Error ? error.message : String(error)}`,
      "write_failed",
      { path, line },
    );
  }

  switch (outcome?.kind) {
    case "ok":
      return successJson({
        path,
        line,
        status: taskStatus(outcome.marker),
        previousMarker: outcome.previous,
        marker: outcome.marker,
        text: outcome.text,
        changed: outcome.changed,
      });
    case "line_out_of_range":
      return errorJson(
        `Line ${line} is past the end of ${path} (${outcome.lineCount} lines, 0-indexed).`,
        "line_out_of_range",
        { path, line, lineCount: outcome.lineCount },
      );
    case "not_a_task":
      return errorJson(
        `Line ${line} of ${path} is not a task: ${JSON.stringify(outcome.lineText)}. A task looks like \`- [ ] text\` or \`1. [x] text\`; use list_tasks to find the right line.`,
        "not_a_task",
        { path, line },
      );
    case "stale_precondition":
      return errorJson(
        `Task text on line ${line} of ${path} is ${JSON.stringify(outcome.text)}, not the expected ${JSON.stringify(expectedText)}. Re-run list_tasks and retry with the current line.`,
        "stale_precondition",
        { path, line, targetType: "task", target: outcome.text },
      );
    default:
      return errorJson(
        `Unexpected state while updating ${path}.`,
        "internal_error",
        {
          path,
          line,
        },
      );
  }
}
