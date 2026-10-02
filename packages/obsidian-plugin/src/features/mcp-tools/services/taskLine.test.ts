import { describe, expect, test } from "bun:test";
import { parseTaskLine, renderTaskLine, taskStatus } from "./taskLine";

describe("taskLine", () => {
  test("parses dash, star, plus and ordered markers with any status char", () => {
    expect(parseTaskLine("- [ ] buy milk")).toEqual({
      prefix: "- ",
      marker: " ",
      text: "buy milk",
    });
    expect(parseTaskLine("  * [x] done")).toEqual({
      prefix: "  * ",
      marker: "x",
      text: "done",
    });
    expect(parseTaskLine("\t+ [/] half")).toEqual({
      prefix: "\t+ ",
      marker: "/",
      text: "half",
    });
    expect(parseTaskLine("3. [-] dropped")).toEqual({
      prefix: "3. ",
      marker: "-",
      text: "dropped",
    });
    expect(parseTaskLine("3) [X] shouting")).toEqual({
      prefix: "3) ",
      marker: "X",
      text: "shouting",
    });
  });

  test("an empty task keeps its box", () => {
    expect(parseTaskLine("- [ ]")).toEqual({
      prefix: "- ",
      marker: " ",
      text: "",
    });
    expect(renderTaskLine({ prefix: "- ", marker: " ", text: "" }, "x")).toBe(
      "- [x]",
    );
  });

  test("rejects plain list items, headings, prose and multi-char boxes", () => {
    expect(parseTaskLine("- not a task")).toBeNull();
    expect(parseTaskLine("# [ ] heading")).toBeNull();
    expect(parseTaskLine("[ ] bare box")).toBeNull();
    expect(parseTaskLine("- [xx] two")).toBeNull();
    expect(parseTaskLine("- [] empty box")).toBeNull();
  });

  test("status: space is open, anything else is done", () => {
    expect(taskStatus(" ")).toBe("open");
    expect(taskStatus("x")).toBe("done");
    expect(taskStatus("/")).toBe("done");
  });

  test("render keeps indentation, marker and text byte for byte", () => {
    const line = "    - [ ] call mum  ";
    const task = parseTaskLine(line)!;
    expect(renderTaskLine(task, " ")).toBe(line);
    expect(renderTaskLine(task, "x")).toBe("    - [x] call mum  ");
  });
});
