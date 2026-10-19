import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMergeTreeZ } from "../server/merge-tree";

describe("parseMergeTreeZ", () => {
  it("reads conflicted paths and their kinds from real git 2.54 output", () => {
    // Captured from: content conflict f.txt, add/add new.txt, modify/delete del.txt, clean keep.txt.
    const raw = readFileSync(new URL("./fixtures-merge-tree-z.bin", import.meta.url), "utf8");
    const result = parseMergeTreeZ(raw);
    expect(result.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(result.conflicts).toEqual([
      { path: "del.txt", kind: "modify/delete" },
      { path: "f.txt", kind: "content" },
      { path: "new.txt", kind: "add/add" },
    ]);
  });

  it("returns no conflicts for a clean merge", () => {
    expect(parseMergeTreeZ("3f020bd14de61520913a9c96656b60b5f7710eb5\0")).toEqual({ tree: "3f020bd14de61520913a9c96656b60b5f7710eb5", conflicts: [] });
  });

  it("falls back to the machine type, then to 'conflict'", () => {
    const raw = ["t", "a.txt", "b.txt", "", "1", "a.txt", "CONFLICT (rename/delete)", "", "1", "b.txt", "CONFLICT (weird)", "no kind here", ""].join("\0");
    expect(parseMergeTreeZ(raw).conflicts).toEqual([
      { path: "a.txt", kind: "rename/delete" },
      { path: "b.txt", kind: "weird" },
    ]);
  });

  it("handles paths with spaces and unicode", () => {
    const raw = ["t", "docs/my file é.md", "", "1", "docs/my file é.md", "CONFLICT (contents)", "CONFLICT (content): Merge conflict in docs/my file é.md\n", ""].join("\0");
    expect(parseMergeTreeZ(raw).conflicts).toEqual([{ path: "docs/my file é.md", kind: "content" }]);
  });
});
