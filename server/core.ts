import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
export const TYPES = [
  "VANILLA",
  "PAPER",
  "SPIGOT",
  "PURPUR",
  "FABRIC",
  "FORGE",
  "NEOFORGE",
  "QUILT",
] as const;
export type ServerType = (typeof TYPES)[number];
export const createSchema = z.object({
  name: z.string().trim().min(1).max(48),
  type: z.enum(TYPES),
  version: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/),
  memory: z.number().int().min(1).max(64),
  port: z.number().int().min(1024).max(65535).optional(),
  eula: z.literal(true),
  seed: z.string().max(100).default(""),
  motd: z.string().max(160).default("§bMK Minecraft §8• §dYour next adventure"),
  autoStart: z.boolean().default(true),
});
export const settingsSchema = z.object({
  difficulty: z.enum(["peaceful", "easy", "normal", "hard"]),
  gamemode: z.enum(["survival", "creative", "adventure", "spectator"]),
  maxPlayers: z.number().int().min(1).max(1000),
  viewDistance: z.number().int().min(2).max(32),
  pvp: z.boolean(),
  whitelist: z.boolean(),
});
export type Settings = z.infer<typeof settingsSchema>;
export type Server = {
  id: string;
  name: string;
  type: ServerType;
  version: string;
  java: number;
  memory: number;
  port: number;
  motd: string;
  seed: string;
  created: string;
  settings: Settings;
  banner: boolean;
  icon: boolean;
  backupHours: number;
  retention: number;
  lastBackup: string | null;
  image: string;
};
export type Job = {
  id: string;
  serverId: string;
  kind: string;
  status: "queued" | "running" | "done" | "failed";
  message: string;
  created: string;
  updated: string;
  payload: Record<string, unknown>;
};
export const defaults: Settings = {
  difficulty: "normal",
  gamemode: "survival",
  maxPlayers: 20,
  viewDistance: 10,
  pvp: true,
  whitelist: false,
};
export function pluginType(t: string) {
  return ["PAPER", "SPIGOT", "PURPUR"].includes(t);
}
export function contentFolder(t: string) {
  if (t === "VANILLA")
    throw new Error(
      "Vanilla does not support mods or plugins. Create a modded or plugin server.",
    );
  return pluginType(t) ? "plugins" : "mods";
}
export function safeName(s: string) {
  if (
    !s ||
    s === "." ||
    s === ".." ||
    /[\\/:\x00-\x1f]/.test(s) ||
    s.length > 180
  )
    throw new Error("Invalid filename");
  return s;
}
export function safePath(root: string, relative: string) {
  if (
    relative.includes("\\") ||
    relative.includes("\0") ||
    relative.includes(":") ||
    path.isAbsolute(relative)
  )
    throw new Error("Invalid path");
  const p = path.resolve(root, relative);
  if (p !== path.resolve(root) && !p.startsWith(path.resolve(root) + path.sep))
    throw new Error("Path escapes server folder");
  return p;
}
export async function noSymlinks(root: string, relative: string) {
  const p = safePath(root, relative);
  let current = path.resolve(root);
  for (const part of path.relative(root, p).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error("Symbolic links are not allowed");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return p;
}
export function properties(s: Server) {
  return {
    motd: s.motd,
    "level-name": "world",
    "level-seed": s.seed,
    difficulty: s.settings.difficulty,
    gamemode: s.settings.gamemode,
    "max-players": s.settings.maxPlayers,
    "view-distance": s.settings.viewDistance,
    pvp: s.settings.pvp,
    "white-list": s.settings.whitelist,
    "enforce-whitelist": s.settings.whitelist,
    "online-mode": true,
    "server-port": 25565,
    "enable-rcon": false,
  };
}
export function escapeProperty(v: unknown) {
  return String(v)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "")
    .replace(
      /[^\x20-\x7e]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    );
}
export function patchProperties(
  original: string,
  values: Record<string, unknown>,
) {
  const pending = new Map(Object.entries(values));
  const lines = original.split(/\r?\n/).map((line) => {
    const m = /^([^#!\s][^=:\s]*)\s*[=:]/.exec(line);
    if (m && pending.has(m[1])) {
      const v = pending.get(m[1]);
      pending.delete(m[1]);
      return m[1] + "=" + escapeProperty(v);
    }
    return line;
  });
  return (
    lines.join("\n") +
    "\n" +
    [...pending].map(([k, v]) => k + "=" + escapeProperty(v)).join("\n") +
    "\n"
  );
}
