// Parser for `git merge-tree --write-tree --name-only -z <a> <b>` (git >= 2.38).
// Layout: <tree>\0 <conflicted path>\0 ... \0 then informational messages, each
// <path count>\0 <path>\0 ... <machine type>\0 <human message>\0.
// The machine type says "CONFLICT (contents)" for both content and add/add conflicts,
// so the kind comes from the human message ("CONFLICT (add/add): ...").

export interface MergeConflict {
  path: string;
  kind: string;
}

export interface MergeTreeResult {
  tree: string;
  conflicts: MergeConflict[];
}

export function parseMergeTreeZ(stdout: string): MergeTreeResult {
  const fields = stdout.split("\0");
  const tree = fields[0]?.trim() ?? "";
  let i = 1;
  const conflicted: string[] = [];
  while (i < fields.length && fields[i] !== "") conflicted.push(fields[i++]);
  i++; // the empty field that ends the conflicted-file section

  const kinds = new Map<string, string>();
  while (i < fields.length) {
    const count = Number.parseInt(fields[i] ?? "", 10);
    if (!Number.isFinite(count) || count < 1) break;
    const paths = fields.slice(i + 1, i + 1 + count);
    const machineType = fields[i + 1 + count] ?? "";
    const message = fields[i + 2 + count] ?? "";
    i += count + 3;
    if (!machineType.startsWith("CONFLICT")) continue;
    const kind = conflictKind(message) ?? conflictKind(machineType) ?? "conflict";
    for (const path of paths) if (!kinds.has(path)) kinds.set(path, kind);
  }

  return { tree, conflicts: conflicted.map((path) => ({ path, kind: kinds.get(path) ?? "conflict" })) };
}

function conflictKind(text: string): string | null {
  const match = /CONFLICT \(([^)]+)\)/.exec(text);
  if (!match) return null;
  return match[1] === "contents" ? "content" : match[1];
}
