import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const FILE = "check-approvals.json";
const MAX_APPROVALS = 200;

const FileSchema = z.object({
  version: z.literal(1),
  salt: z.string().min(32),
  approvals: z.array(z.object({ workspace: z.string(), command: z.string(), at: z.number() })),
});
type ApprovalsFile = z.infer<typeof FileSchema>;

/**
 * A paseo.json check is code from the workspace, which an agent can write. It runs only after the user approved
 * that exact command for that workspace from the card. Entries are salted hashes, so the file names no paths or commands.
 */
export interface CheckApprovals {
  isApproved(root: string, command: string): Promise<boolean>;
  approve(root: string, command: string): Promise<void>;
}

/** `dir` must be a private directory (`ensurePrivateDirectory`); null keeps approvals in memory only. */
export function createCheckApprovals(dir: string | null): CheckApprovals {
  let state: Promise<ApprovalsFile> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const load = () =>
    (state ??= (async () => {
      const text = dir ? await readFile(join(dir, FILE), "utf8").catch(() => null) : null;
      if (text !== null) {
        try {
          return FileSchema.parse(JSON.parse(text));
        } catch (error) {
          console.error(`[turn-report] could not read check approvals, starting empty: ${String(error).slice(0, 200)}`);
        }
      }
      return { version: 1 as const, salt: randomBytes(32).toString("hex"), approvals: [] };
    })());

  const keys = async (root: string, command: string) => {
    const { salt } = await load();
    const hash = (kind: string, value: string) => createHash("sha256").update(salt).update(`\0${kind}\0`).update(value).digest("hex");
    const realRoot = await realpath(root).catch(() => root);
    return { workspace: hash("workspace", realRoot), command: hash("command", command) };
  };

  return {
    async isApproved(root, command) {
      const key = await keys(root, command);
      return (await load()).approvals.some((a) => a.workspace === key.workspace && a.command === key.command);
    },
    async approve(root, command) {
      const key = await keys(root, command);
      const file = await load();
      file.approvals = [...file.approvals.filter((a) => a.workspace !== key.workspace || a.command !== key.command), { ...key, at: Date.now() }].slice(-MAX_APPROVALS);
      if (!dir) return;
      const snapshot = JSON.stringify(file);
      const write = writing.catch(() => {}).then(async () => {
        const tmp = join(dir, `${FILE}.${process.pid}.tmp`);
        await writeFile(tmp, snapshot, { mode: 0o600 });
        await rename(tmp, join(dir, FILE));
      });
      writing = write;
      await write;
    },
  };
}
