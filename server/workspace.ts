import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import { noSymlinks, contentFolder, type Server } from "./core.js";
import { inspectJar } from "./mods.js";

export const workspaceSchema = z.object({
  name: z.string().trim().min(1).max(60).default("MK Minecraft Panel"),
  refreshSeconds: z
    .union([z.literal(5), z.literal(15), z.literal(30)])
    .default(5),
  defaultMemory: z.number().int().min(1).max(16).default(2),
  defaultBackupHours: z
    .union([
      z.literal(0),
      z.literal(6),
      z.literal(12),
      z.literal(24),
      z.literal(48),
      z.literal(168),
    ])
    .default(0),
  defaultRetention: z.number().int().min(1).max(50).default(5),
});
export function workspaceSettings(store: Store) {
  return workspaceSchema.parse(JSON.parse(store.get("workspace") || "{}"));
}
export async function directoryBytes(dir: string): Promise<number> {
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch (e: any) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let bytes = 0;
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (!item.isSymbolicLink())
      bytes += await directoryBytes(path.join(dir, item.name));
  }
  return bytes;
}
export class Storage {
  cache = new Map<string, { value: any; expires: number }>();
  pending = new Map<string, Promise<any>>();
  revisions = new Map<string, number>();
  constructor(public root: string) {}
  invalidate(id: string) {
    this.cache.delete(id);
    this.revisions.set(id, (this.revisions.get(id) || 0) + 1);
  }
  async get(s: Server) {
    const cached = this.cache.get(s.id);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (this.pending.has(s.id)) return this.pending.get(s.id)!;
    const revision = this.revisions.get(s.id) || 0;
    const task = this.scan(s)
      .then((value) => {
        if ((this.revisions.get(s.id) || 0) === revision)
          this.cache.set(s.id, { value, expires: Date.now() + 60000 });
        return value;
      })
      .finally(() => this.pending.delete(s.id));
    this.pending.set(s.id, task);
    return task;
  }
  async scan(s: Server) {
    const serverDir = await noSymlinks(this.root, `servers/${s.id}`);
    const backupDir = await noSymlinks(this.root, `backups/${s.id}`);
    const worlds = [];
    for (const name of ["world", "world_nether", "world_the_end"]) {
      const dir = await noSymlinks(this.root, `servers/${s.id}/${name}`);
      if (
        await fs
          .stat(dir)
          .then((st) => st.isDirectory())
          .catch(() => false)
      )
        worlds.push({ name, bytes: await directoryBytes(dir) });
    }
    return {
      serverBytes: await directoryBytes(serverDir),
      backupBytes: await directoryBytes(backupDir),
      worlds,
      updatedAt: new Date().toISOString(),
    };
  }
}
export async function backupList(root: string, s: Server) {
  const dir = await noSymlinks(root, `backups/${s.id}`);
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch((e: any) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
  const list = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".zip")) continue;
    const st = await fs.stat(path.join(dir, entry.name));
    list.push({
      name: entry.name,
      size: st.size,
      createdAt: st.mtime.toISOString(),
    });
  }
  return list.sort((a, b) => b.name.localeCompare(a.name));
}
export class ContentIndex {
  mods = new Map<string, { signature: string; check: any }>();
  constructor(public root: string) {}
  async installed(s: Server) {
    if (s.type === "VANILLA") return [];
    const folder = contentFolder(s.type);
    const dir = await noSymlinks(this.root, `servers/${s.id}/${folder}`);
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch((e: any) => {
        if (e.code === "ENOENT") return [];
        throw e;
      });
    const result = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.jar(?:\.disabled)?$/.test(entry.name))
        continue;
      const file = path.join(dir, entry.name);
      const st = await fs.stat(file);
      const signature = `${st.size}:${st.mtimeMs}:${s.type}:${s.version}`;
      let check = this.mods.get(file);
      if (!check || check.signature !== signature) {
        const metadata =
          st.size <= 100 * 1024 ** 2
            ? await inspectJar(await fs.readFile(file), s).catch(() => ({
                status: "Unknown",
                reasons: ["Metadata could not be read"],
              }))
            : {
                status: "Unknown",
                reasons: ["File is too large for metadata inspection"],
              };
        check = { signature, check: metadata };
        this.mods.set(file, check);
      }
      result.push({
        name: entry.name,
        size: st.size,
        kind: folder === "plugins" ? "Plugin" : "Mod",
        enabled: !entry.name.endsWith(".disabled"),
        compatibility: check.check.status,
        reasons: check.check.reasons,
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
}
