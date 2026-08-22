import { describe, expect, test } from "bun:test";
import {
  DENY_ALL_POLICY,
  EMPTY_POLICY,
  MAX_POLICY_FOLDERS,
  compilePolicy,
  isUnderFolder,
  normalizeFolderEntry,
  normalizeFolderList,
} from "./pathPolicy";

// Vault paths are NFC on Windows/Linux and typically NFD on macOS, while
// anything typed into a settings field arrives NFC. These two spell the
// same folder and must compare unequal as raw strings.
//
// Written as escapes on purpose: as literal characters they look
// identical, and one stray editor normalisation would collapse them into
// the same string, leaving the tests below passing while proving nothing.
const CAFE_NFC = "Caf\u00E9"; // e-acute as a single code point
const CAFE_NFD = "Cafe\u0301"; // plain e plus a combining acute

test("the NFC and NFD fixtures really are different strings", () => {
  // Guards every Unicode assertion below. If this fails, the fixtures were
  // normalised and those assertions are comparing a string with itself.
  expect(CAFE_NFC).not.toBe(CAFE_NFD);
  expect(CAFE_NFD.normalize("NFC")).toBe(CAFE_NFC);
});

describe("normalizeFolderEntry", () => {
  test("rejects every non-string, without throwing", () => {
    for (const junk of [
      undefined,
      null,
      42,
      true,
      {},
      [],
      Symbol("x"),
      () => "Journal",
    ]) {
      expect(normalizeFolderEntry(junk)).toBeUndefined();
    }
  });

  test("passes a plain vault-relative path through unchanged", () => {
    expect(normalizeFolderEntry("Journal/Therapy")).toBe("Journal/Therapy");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeFolderEntry("  Journal  ")).toBe("Journal");
  });

  test("folds backslashes so a pasted Windows path still matches", () => {
    expect(normalizeFolderEntry("Journal\\Therapy")).toBe("Journal/Therapy");
  });

  test("collapses repeated slashes and strips leading and trailing ones", () => {
    expect(normalizeFolderEntry("/Journal//Therapy/")).toBe("Journal/Therapy");
  });

  test("normalises to NFC so a decomposed entry matches a composed one", () => {
    expect(normalizeFolderEntry(CAFE_NFD)).toBe(CAFE_NFC);
    expect(normalizeFolderEntry(CAFE_NFC)).toBe(CAFE_NFC);
  });

  // Every spelling of "the vault root". Excluding the root would hide the
  // whole vault from every client while the server stayed up, which is an
  // incomprehensible failure mode; the settings UI refuses it with a
  // message rather than letting the entry vanish silently.
  test("rejects every spelling of the vault root", () => {
    for (const root of ["", "   ", "/", "//", "\\", ".", "./", "/./"]) {
      expect(normalizeFolderEntry(root)).toBeUndefined();
    }
  });

  // Dropped, never resolved: a resolved traversal entry would match
  // nothing while still looking configured, which is false security.
  test("drops traversal entries instead of resolving them", () => {
    for (const bad of [
      "../secrets",
      "Journal/../secrets",
      "..",
      "Journal/./Therapy",
      "/../",
    ]) {
      expect(normalizeFolderEntry(bad)).toBeUndefined();
    }
  });

  test("a folder legitimately containing dots in a name is kept", () => {
    expect(normalizeFolderEntry("Journal/2026.01")).toBe("Journal/2026.01");
    expect(normalizeFolderEntry(".obsidian")).toBe(".obsidian");
    expect(normalizeFolderEntry("..hidden")).toBe("..hidden");
  });
});

describe("normalizeFolderList", () => {
  test("a non-array yields an empty list, whatever it is", () => {
    for (const junk of [undefined, null, "Journal", 42, {}]) {
      expect(normalizeFolderList(junk)).toEqual([]);
    }
  });

  test("drops unusable entries and keeps the rest", () => {
    expect(
      normalizeFolderList([null, "Journal", 42, "", "../x", "Therapy"]),
    ).toEqual(["Journal", "Therapy"]);
  });

  test("dedupes after normalisation, preserving first-seen order", () => {
    expect(
      normalizeFolderList(["/Journal/", "Therapy", "Journal", "Journal//"]),
    ).toEqual(["Journal", "Therapy"]);
  });

  test("does not sort — the list stays in the user's order", () => {
    expect(normalizeFolderList(["Zeta", "Alpha", "Mu"])).toEqual([
      "Zeta",
      "Alpha",
      "Mu",
    ]);
  });

  // Pruning `a/b` because `a` covers it is a matching no-op but a
  // data-loss action: removing `a` later would silently unprotect `a/b`.
  test("keeps a nested entry even when a parent already covers it", () => {
    expect(normalizeFolderList(["Journal", "Journal/Therapy"])).toEqual([
      "Journal",
      "Journal/Therapy",
    ]);
  });

  test("caps the list rather than rejecting an oversized one", () => {
    const huge = Array.from({ length: MAX_POLICY_FOLDERS + 50 }, (_, i) =>
      String(i),
    );
    expect(normalizeFolderList(huge)).toHaveLength(MAX_POLICY_FOLDERS);
  });

  test("the cap counts usable entries, not raw ones", () => {
    const padded = [...Array.from({ length: 20 }, () => null), "Journal"];
    expect(normalizeFolderList(padded, 3)).toEqual(["Journal"]);
  });
});

describe("isUnderFolder", () => {
  // The classic prefix bypass. `startsWith("Therapy")` alone would hide
  // TherapyNotes/ too, which is a folder the user never named.
  test("does not match a sibling that merely shares the prefix", () => {
    expect(isUnderFolder("TherapyNotes/a.md", "Therapy")).toBe(false);
    expect(isUnderFolder("Therapy2/a.md", "Therapy")).toBe(false);
  });

  test("matches the folder itself and anything beneath it", () => {
    expect(isUnderFolder("Therapy", "Therapy")).toBe(true);
    expect(isUnderFolder("Therapy/a.md", "Therapy")).toBe(true);
    expect(isUnderFolder("Therapy/deep/nested/a.md", "Therapy")).toBe(true);
  });

  test("matches a nested folder entry", () => {
    expect(isUnderFolder("Journal/Therapy/a.md", "Journal/Therapy")).toBe(true);
    expect(isUnderFolder("Journal/Other/a.md", "Journal/Therapy")).toBe(false);
  });

  test("is case-sensitive, per ADR-0020 D13", () => {
    expect(isUnderFolder("therapy/a.md", "Therapy")).toBe(false);
    expect(isUnderFolder("Therapy/a.md", "therapy")).toBe(false);
  });

  test("a parent of the folder is not under it", () => {
    expect(isUnderFolder("Journal", "Journal/Therapy")).toBe(false);
  });
});

describe("compilePolicy", () => {
  test("anything that yields no folders compiles to the empty policy", () => {
    for (const junk of [undefined, null, [], ["", "  ", "../x"], "Journal"]) {
      const policy = compilePolicy(junk);
      expect(policy.isEmpty).toBe(true);
      expect(policy.folders).toEqual([]);
      expect(policy.isExcluded("anything/at/all.md")).toBe(false);
    }
  });

  test("EMPTY_POLICY excludes nothing and is frozen", () => {
    expect(EMPTY_POLICY.isEmpty).toBe(true);
    expect(EMPTY_POLICY.isExcluded("Therapy/a.md")).toBe(false);
    expect(Object.isFrozen(EMPTY_POLICY)).toBe(true);
  });

  // The pre-first-read state (ADR-0020 D7). isEmpty is false on purpose:
  // it is emphatically not inert, and no consumer may treat it as such.
  test("DENY_ALL_POLICY refuses everything and is not inert", () => {
    expect(DENY_ALL_POLICY.isExcluded("Public/a.md")).toBe(true);
    expect(DENY_ALL_POLICY.isExcluded("")).toBe(true);
    expect(DENY_ALL_POLICY.isEmpty).toBe(false);
    expect(DENY_ALL_POLICY.folders).toEqual([]);
    expect(Object.isFrozen(DENY_ALL_POLICY)).toBe(true);
  });

  test("a populated policy reports its canonical folders and is frozen", () => {
    const policy = compilePolicy(["/Journal/Therapy/", "Finances"]);
    expect(policy.isEmpty).toBe(false);
    expect(policy.folders).toEqual(["Journal/Therapy", "Finances"]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.folders)).toBe(true);
  });

  test("excludes the folder itself and everything beneath it", () => {
    const policy = compilePolicy(["Therapy"]);
    expect(policy.isExcluded("Therapy")).toBe(true);
    expect(policy.isExcluded("Therapy/2026-01-02.md")).toBe(true);
    expect(policy.isExcluded("Therapy/sub/deep.md")).toBe(true);
  });

  test("leaves everything else alone, prefix siblings included", () => {
    const policy = compilePolicy(["Therapy"]);
    expect(policy.isExcluded("Public/a.md")).toBe(false);
    expect(policy.isExcluded("TherapyNotes/a.md")).toBe(false);
  });

  test("any one folder in the list is enough to exclude", () => {
    const policy = compilePolicy(["Therapy", "Finances", "Journal/Private"]);
    expect(policy.isExcluded("Finances/2026/tax.md")).toBe(true);
    expect(policy.isExcluded("Journal/Private/a.md")).toBe(true);
    expect(policy.isExcluded("Journal/Public/a.md")).toBe(false);
  });

  // The macOS case: the folder list was typed (NFC), the file path came
  // off the filesystem (NFD). Without folding both, the folder is
  // silently not hidden.
  test("a decomposed path matches a composed entry, and the reverse", () => {
    expect(compilePolicy([CAFE_NFC]).isExcluded(`${CAFE_NFD}/a.md`)).toBe(true);
    expect(compilePolicy([CAFE_NFD]).isExcluded(`${CAFE_NFC}/a.md`)).toBe(true);
  });

  test("a non-string or empty path is never excluded, and never throws", () => {
    const policy = compilePolicy(["Therapy"]);
    for (const junk of [undefined, null, 42, {}, []]) {
      expect(policy.isExcluded(junk as unknown as string)).toBe(false);
    }
    expect(policy.isExcluded("")).toBe(false);
  });

  // The question a recursive delete asks. Getting this wrong destroys
  // exactly the material the feature exists to protect.
  test("containsExcluded looks the other way down the tree", () => {
    const policy = compilePolicy(["Journal/Therapy"]);
    // An ancestor contains it: deleting Journal recursively would take
    // Therapy with it.
    expect(policy.containsExcluded("Journal")).toBe(true);
    expect(policy.containsExcluded("")).toBe(true);
    // The folder itself counts.
    expect(policy.containsExcluded("Journal/Therapy")).toBe(true);
    // A descendant does not: nothing excluded lives below it.
    expect(policy.containsExcluded("Journal/Therapy/2026")).toBe(false);
    // An unrelated sibling does not.
    expect(policy.containsExcluded("Journal/Public")).toBe(false);
    expect(policy.containsExcluded("Finances")).toBe(false);
  });

  test("containsExcluded does not match a mere prefix sibling", () => {
    const policy = compilePolicy(["JournalArchive/Therapy"]);
    expect(policy.containsExcluded("Journal")).toBe(false);
  });

  test("containsExcluded folds Unicode like isExcluded does", () => {
    expect(
      compilePolicy([`${CAFE_NFC}/Notes`]).containsExcluded(CAFE_NFD),
    ).toBe(true);
  });

  test("an inert policy contains nothing, a deny-all policy contains everything", () => {
    expect(EMPTY_POLICY.containsExcluded("")).toBe(false);
    expect(EMPTY_POLICY.containsExcluded("Journal")).toBe(false);
    expect(DENY_ALL_POLICY.containsExcluded("Journal")).toBe(true);
    expect(DENY_ALL_POLICY.containsExcluded("")).toBe(true);
  });

  test("compiling is pure — two policies from one input agree", () => {
    const raw = ["Therapy", "Finances"];
    const a = compilePolicy(raw);
    const b = compilePolicy(raw);
    expect(a.folders).toEqual(b.folders);
    expect(a.isExcluded("Therapy/x.md")).toBe(b.isExcluded("Therapy/x.md"));
  });
});
