import type { CollisionPeer, CollisionsReport } from "../shared/report";
import { MAX_FILES_PER_PEER, MAX_PEERS, NOT_A_GIT_REPOSITORY } from "../shared/report";
import { createScratch, mergeTree, repoInfo, snapshotWorktree, type RepoInfo } from "./git";
import { parseMergeTreeZ } from "./merge-tree";

export interface PeerAgent {
  agentId: string;
  title: string;
  cwd: string;
}

interface Worktree {
  info: RepoInfo;
  agents: PeerAgent[];
}

/** Groups peer agents by worktree, keeping only worktrees of the same repository other than `self`. */
export async function peerWorktrees(self: RepoInfo, peers: readonly PeerAgent[]): Promise<Worktree[]> {
  const byTop = new Map<string, Worktree>();
  const infos = await Promise.all(peers.map(async (peer) => ({ peer, info: await repoInfo(peer.cwd) })));
  for (const { peer, info } of infos) {
    if (!info || info.commonDir !== self.commonDir || info.toplevel === self.toplevel) continue;
    const existing = byTop.get(info.toplevel);
    if (existing) existing.agents.push(peer);
    else byTop.set(info.toplevel, { info, agents: [peer] });
  }
  return [...byTop.values()].slice(0, MAX_PEERS);
}

export type CollisionResult = CollisionsReport & { checkedAgentIds: string[] };

export async function detectCollisions(selfCwd: string, peers: readonly PeerAgent[]): Promise<CollisionResult> {
  const started = Date.now();
  const self = await repoInfo(selfCwd);
  if (!self) return { state: "skipped", peersChecked: 0, items: [], durationMs: 0, note: NOT_A_GIT_REPOSITORY, checkedAgentIds: [] };
  const worktrees = await peerWorktrees(self, peers);
  if (worktrees.length === 0) {
    return { state: "done", peersChecked: 0, items: [], durationMs: Date.now() - started, note: "no other live agents in this repository", checkedAgentIds: [] };
  }
  const scratch = await createScratch(self);
  try {
    const selfSnap = await snapshotWorktree(scratch, self, "self");
    const items: CollisionPeer[] = [];
    let index = 0;
    for (const wt of worktrees) {
      const peerSnap = await snapshotWorktree(scratch, wt.info, `peer-${index++}`);
      const merged = await mergeTree(scratch, self.toplevel, selfSnap, peerSnap);
      if (merged.code === 0) continue;
      if (merged.code !== 1) throw new Error(`merge-tree failed (${merged.code}): ${merged.stderr.trim().slice(0, 200)}`);
      const { conflicts } = parseMergeTreeZ(merged.stdout);
      if (conflicts.length === 0) continue;
      for (const agent of wt.agents) {
        items.push({
          agentId: agent.agentId,
          agentTitle: agent.title,
          branch: wt.info.branch,
          files: conflicts.slice(0, MAX_FILES_PER_PEER),
          moreFiles: Math.max(0, conflicts.length - MAX_FILES_PER_PEER),
        });
      }
    }
    return { state: "done", peersChecked: worktrees.length, items, durationMs: Date.now() - started, note: null, checkedAgentIds: worktrees.flatMap((wt) => wt.agents.map((a) => a.agentId)) };
  } finally {
    await scratch.dispose();
  }
}
