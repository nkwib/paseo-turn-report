import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { REPORT_SCHEMAS, REPORT_VERSION, type TurnReport } from "../shared/report";

// Timeline rows live in daemon memory only (InMemoryAgentTimelineStore), so the board keeps its own copy.
// The SDK passes no data directory to a plugin, so this follows the convention $PASEO_HOME/plugin-data/<id>.
// Without PASEO_HOME it uses the user's state folder, never the shared temp dir: check approvals live here.
export function dataDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const paseoHome = env.PASEO_HOME?.replace(/^~(?=$|\/)/, home);
  if (paseoHome && isAbsolute(paseoHome)) return join(paseoHome, "plugin-data", "turn-report");
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state"), "paseo-turn-report");
}

/** Creates `dir` with mode 0700, or checks an existing one: a real directory owned by this user, tightened to 0700. */
export async function ensurePrivateDirectory(dir: string, uid = process.getuid?.()): Promise<void> {
  await mkdir(dirname(dir), { recursive: true });
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} is not owned by the current user`);
  if ((stat.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

const FILE = "reports.json";
const FileSchema = z.object({ version: z.number().int().nonnegative(), reports: z.array(z.unknown()) });

/**
 * Reads the stored reports. A file it cannot read, or one from a newer version, is moved aside first
 * (`reports.json.bad`, `reports.json.v3`), so the next save cannot overwrite it. Throws if it cannot be moved:
 * the caller then keeps reports in memory.
 */
export async function loadReports(dir: string): Promise<TurnReport[]> {
  let text: string;
  try {
    text = await readFile(join(dir, FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return setAside(dir, "bad", error);
  }
  let file: z.infer<typeof FileSchema>;
  try {
    file = FileSchema.parse(JSON.parse(text));
  } catch (error) {
    return setAside(dir, "bad", error);
  }
  if (file.version > REPORT_VERSION) return setAside(dir, `v${file.version}`, `version ${file.version} is newer than this plugin's ${REPORT_VERSION}`);
  const schema = REPORT_SCHEMAS.get(file.version);
  if (!schema) return setAside(dir, "bad", `unknown version ${file.version}`);
  const reports = file.reports.flatMap((data) => {
    const parsed = schema.safeParse(data);
    return parsed.success ? [parsed.data] : [];
  });
  if (reports.length < file.reports.length) console.error(`[turn-report] could not read ${file.reports.length - reports.length} of ${file.reports.length} stored reports`);
  return reports;
}

async function setAside(dir: string, suffix: string, reason: unknown): Promise<TurnReport[]> {
  for (let n = 0; n < 100; n++) {
    const name = `${FILE}.${suffix}${n ? `.${n}` : ""}`;
    const taken = await lstat(join(dir, name)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (taken) continue;
    await rename(join(dir, FILE), join(dir, name));
    console.error(`[turn-report] could not read stored reports (${String(reason).replace(/\s+/g, " ").slice(0, 200)}): moved to ${name}, starting empty`);
    return [];
  }
  throw new Error(`could not move ${FILE} aside: ${FILE}.${suffix} to .99 exist`);
}

export function createSaver(dir: string, delayMs = 500) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: TurnReport[] = [];
  let writing: Promise<void> = Promise.resolve();
  const flush = () => {
    timer = null;
    const reports = latest;
    writing = writing.then(async () => {
      try {
        const tmp = join(dir, `${FILE}.${process.pid}.tmp`);
        await writeFile(tmp, JSON.stringify({ version: REPORT_VERSION, reports }), { mode: 0o600 });
        await rename(tmp, join(dir, FILE));
      } catch (error) {
        console.error(`[turn-report] could not save reports: ${String(error)}`);
      }
    });
  };
  return {
    save(reports: TurnReport[]) {
      latest = reports.slice();
      if (!timer) timer = setTimeout(flush, delayMs);
    },
    async close() {
      if (timer) {
        clearTimeout(timer);
        flush();
      }
      await writing;
    },
  };
}
