import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream, createReadStream } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
import { z } from "zod";
import { extractZip, verifyZip } from "./archives.js";
import {
  noSymlinks,
  safeName,
  readProperties,
  type Server,
  TYPES,
} from "./core.js";
import { treeBytes } from "./trash.js";
import { javaFor, USER_AGENT } from "./catalog.js";
import { IMAGE_RELEASE } from "./docker.js";
import type { Store } from "./store.js";

function limit(name: string, fallback: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${name}`);
  return n;
}
export const uploadLimit = () => limit("IMPORT_UPLOAD_BYTES", 2 * 1024 ** 3);
export const expandedLimit = () =>
  limit("IMPORT_EXPANDED_BYTES", 8 * 1024 ** 3);
export const runtimeSchema = z.object({
  type: z.enum(TYPES),
  version: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/),
  loaderVersion: z
    .string()
    .regex(/^[a-zA-Z0-9.+_-]{1,100}$/)
    .optional(),
});
export type Runtime = z.infer<typeof runtimeSchema>;
type PackFile = {
  path: string;
  urls: string[];
  hashes: Record<string, string>;
  optional?: boolean;
  projectId?: number;
  fileId?: number;
};
export type ImportRecord = {
  id: string;
  serverId: string;
  kind: "world" | "backup" | "modpack";
  format: string;
  name: string;
  version?: string;
  runtime?: Runtime;
  source: string;
  worlds: string[];
  files: PackFile[];
  warnings: string[];
  state: "ready" | "installing" | "installed" | "failed";
  created: string;
};
const allowedHosts = new Set([
  "cdn.modrinth.com",
  "api.modrinth.com",
  "api.curseforge.com",
  "edge.forgecdn.net",
  "mediafilez.forgecdn.net",
  "media.forgecdn.net",
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "gitlab.com",
]);
export function publicAddress(address: string) {
  if (isIP(address) !== 4) return false; // DNS requests below explicitly use IPv4.
  const [a, b] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
const downloadAgent = new Agent({
  connect: {
    lookup: ((hostname: string, options: any, callback: any) => {
      lookup(hostname, { family: 4, all: true }).then((addresses) => {
        if (
          !addresses.length ||
          addresses.some((a) => !publicAddress(a.address))
        )
          return callback(new Error("Private-network downloads are forbidden"));
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, 4);
      }, callback);
    }) as any,
  },
});
export async function remote(url: string, cf = false): Promise<Response> {
  for (let redirect = 0; redirect <= 5; redirect++) {
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      (u.port && u.port !== "443") ||
      !allowedHosts.has(u.hostname)
    )
      throw new Error("Unsupported download host");
    const addresses = await lookup(u.hostname, { family: 4, all: true });
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw new Error("Private-network downloads are forbidden");
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (cf && u.hostname === "api.curseforge.com") {
      if (!process.env.CURSEFORGE_API_KEY)
        throw new Error(
          "Set CURSEFORGE_API_KEY on the panel to resolve CurseForge exports",
        );
      headers["x-api-key"] = process.env.CURSEFORGE_API_KEY;
    }
    const response = await fetch(u, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
      dispatcher: downloadAgent,
    } as any);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Download redirect has no destination");
      url = new URL(location, u).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Download service returned ${response.status}`);
    }
    return response;
  }
  throw new Error("Too many download redirects");
}
export async function remoteJSON(url: string, cf = false) {
  const response = await remote(url, cf);
  let text = "",
    bytes = 0;
  for await (const chunk of Readable.fromWeb(response.body as any)) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 ** 2) throw new Error("Remote metadata is too large");
    text += chunk.toString();
  }
  return JSON.parse(text);
}
export async function diskSpace(dir: string, bytes: number) {
  const stat = await fs.statfs(dir);
  if (stat.bavail * stat.bsize < bytes + 256 * 1024 ** 2)
    throw new Error("Not enough free disk space for import and recovery");
}
export async function boundedWrite(
  stream: NodeJS.ReadableStream,
  dest: string,
  max: number,
) {
  let bytes = 0;
  await pipeline(
    stream,
    new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        done(
          bytes > max
            ? new Error("Upload or download exceeds the configured size limit")
            : null,
          chunk,
        );
      },
    }),
    createWriteStream(dest, { flags: "wx" }),
  );
  if ((stream as any).truncated) throw new Error("Upload was truncated");
}
async function jsonFile(file: string) {
  if ((await fs.stat(file)).size > 16 * 1024 ** 2)
    throw new Error("Archive metadata is too large");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function exists(file: string) {
  return fs.stat(file).then(
    () => true,
    (e) => {
      if (e.code !== "ENOENT") throw e;
      return false;
    },
  );
}
export async function normalizedRoot(dir: string) {
  for (let depth = 0; depth < 5; depth++) {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).filter(
      (e) => e.name !== "__MACOSX",
    );
    if (
      entries.some((e) =>
        [
          "mods",
          "config",
          "server.properties",
          "level.dat",
          "modrinth.index.json",
          "manifest.json",
        ].includes(e.name),
      )
    )
      return dir;
    if (entries.length !== 1 || !entries[0].isDirectory()) return dir;
    dir = path.join(dir, entries[0].name);
  }
  return dir;
}
export async function findWorlds(
  dir: string,
  prefix = "",
  depth = 0,
): Promise<string[]> {
  if (await exists(path.join(dir, "level.dat"))) return [prefix];
  if (depth >= 3) return [];
  const result: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory())
      result.push(
        ...(await findWorlds(
          path.join(dir, entry.name),
          [prefix, entry.name].filter(Boolean).join("/"),
          depth + 1,
        )),
      );
  }
  return result;
}
export async function worldName(dir: string) {
  const props = readProperties(
    await fs
      .readFile(path.join(dir, "server.properties"), "utf8")
      .catch(() => ""),
  );
  const name = props["level-name"] || "world";
  await noSymlinks(dir, name);
  if (
    !name ||
    name === "." ||
    name.split("/").some((p) => p === ".." || p.startsWith(".mk-"))
  )
    throw new Error("Invalid configured world name");
  return name;
}
export class Imports {
  constructor(public store: Store) {}
  async dir(id: string) {
    return noSymlinks(this.store.root, `imports/${safeName(id)}`);
  }
  get(id: string, serverId: string): ImportRecord {
    const raw = this.store.get(`import:${safeName(id)}`);
    if (!raw) throw new Error("Import not found");
    const record: ImportRecord = JSON.parse(raw);
    if (record.serverId !== serverId)
      throw new Error("Import belongs to another server");
    return record;
  }
  save(record: ImportRecord) {
    this.store.set(`import:${record.id}`, JSON.stringify(record));
  }
  async inspect(
    serverId: string,
    kind: ImportRecord["kind"],
    stream: NodeJS.ReadableStream,
    name: string,
  ) {
    const id = randomUUID(),
      dir = await this.dir(id);
    await fs.mkdir(dir, { recursive: true });
    try {
      await boundedWrite(stream, path.join(dir, "archive.zip"), uploadLimit());
      const expanded = await verifyZip(
        path.join(dir, "archive.zip"),
        () => {},
        expandedLimit(),
      );
      await diskSpace(dir, expanded);
      const unpacked = path.join(dir, "unpacked");
      await extractZip(
        path.join(dir, "archive.zip"),
        unpacked,
        expandedLimit(),
      );
      const source = await normalizedRoot(unpacked);
      const record: ImportRecord = {
        id,
        serverId,
        kind,
        format: "server-zip",
        name,
        source: path.relative(dir, source).split(path.sep).join("/"),
        worlds: [],
        files: [],
        warnings: [],
        state: "ready",
        created: new Date().toISOString(),
      };
      if (kind === "world") {
        record.worlds = await findWorlds(source);
        if (!record.worlds.length)
          throw new Error(
            "Choose a Java world ZIP containing level.dat. Bedrock worlds are not supported.",
          );
      } else if (
        kind === "modpack" &&
        (await exists(path.join(source, "modrinth.index.json")))
      ) {
        const m = await jsonFile(path.join(source, "modrinth.index.json"));
        if (
          m.formatVersion !== 1 ||
          m.game !== "minecraft" ||
          !Array.isArray(m.files) ||
          m.files.length > 100000
        )
          throw new Error("Unsupported Modrinth pack format");
        record.format = "mrpack";
        record.name = String(m.name);
        record.version = String(m.versionId);
        const loaders: Record<string, Runtime["type"]> = {
          "fabric-loader": "FABRIC",
          "quilt-loader": "QUILT",
          forge: "FORGE",
          neoforge: "NEOFORGE",
        };
        const deps = Object.keys(m.dependencies || {});
        if (
          deps.some((k) => k !== "minecraft" && !loaders[k]) ||
          deps.filter((k) => loaders[k]).length !== 1
        )
          throw new Error("Unsupported or ambiguous pack loader");
        const loader = deps.find((k) => loaders[k])!;
        record.runtime = runtimeSchema.parse({
          type: loaders[loader],
          version: m.dependencies.minecraft,
          loaderVersion: m.dependencies[loader],
        });
        const seen = new Set<string>();
        for (const f of m.files) {
          await noSymlinks(source, f.path);
          if (
            !f.path ||
            f.path.split("/").some((p: string) => p.startsWith(".mk-")) ||
            seen.has(f.path.toLowerCase())
          )
            throw new Error("Invalid or duplicate pack path");
          seen.add(f.path.toLowerCase());
          if (f.env?.server === "unsupported") continue;
          if (f.env?.server && !["required", "optional"].includes(f.env.server))
            throw new Error("Invalid server environment");
          if (
            !/^[a-f0-9]{128}$/i.test(f.hashes?.sha512) ||
            !/^[a-f0-9]{40}$/i.test(f.hashes?.sha1) ||
            !Array.isArray(f.downloads)
          )
            throw new Error("Pack file is missing checksums or downloads");
          record.files.push({
            path: f.path,
            hashes: f.hashes,
            urls: f.downloads,
            optional: f.env?.server === "optional",
          });
        }
      } else if (
        kind === "modpack" &&
        (await exists(path.join(source, "manifest.json")))
      ) {
        const m = await jsonFile(path.join(source, "manifest.json"));
        if (
          m.manifestType !== "minecraftModpack" ||
          m.manifestVersion !== 1 ||
          !Array.isArray(m.files)
        )
          throw new Error("Unsupported CurseForge export");
        record.format = "curseforge";
        record.name = String(m.name);
        record.version = String(m.version);
        const loaders = m.minecraft?.modLoaders || [];
        const loader =
          loaders.find((v: any) => v.primary) ||
          (loaders.length === 1 ? loaders[0] : null);
        const match = /^(forge|neoforge|fabric|quilt)-(.+)$/.exec(
          loader?.id || "",
        );
        if (!match) throw new Error("Unsupported CurseForge loader");
        record.runtime = runtimeSchema.parse({
          type: match[1].toUpperCase(),
          version: m.minecraft.version,
          loaderVersion: match[2],
        });
        for (const item of m.files) {
          if (
            !Number.isSafeInteger(item.projectID) ||
            !Number.isSafeInteger(item.fileID)
          )
            throw new Error("Invalid CurseForge file ID");
          const data = (
            await remoteJSON(
              `https://api.curseforge.com/v1/mods/${item.projectID}/files/${item.fileID}`,
              true,
            )
          ).data;
          const hashes: Record<string, string> = {};
          for (const h of data.hashes || [])
            if (h.algo === 1 || h.algo === 2)
              hashes[h.algo === 1 ? "sha1" : "md5"] = h.value;
          record.files.push({
            path: `mods/${safeName(data.fileName)}`,
            urls: data.downloadUrl ? [data.downloadUrl] : [],
            hashes,
            projectId: item.projectID,
            fileId: item.fileID,
            optional: item.required === false,
          });
        }
        record.warnings.push(
          "CurseForge exports may include client-only mods. Review startup logs and use the author's server pack when supplied.",
        );
        if (m.overrides) {
          await noSymlinks(source, m.overrides);
          this.store.set(`import-overrides:${id}`, m.overrides);
        }
      } else {
        const metadata = path.join(source, ".mk-settings.json");
        if (await exists(metadata)) {
          const saved = await jsonFile(metadata);
          if (saved.runtime)
            record.runtime = runtimeSchema.parse(saved.runtime);
        }
        if (
          kind === "backup" &&
          !(await exists(path.join(source, "server.properties")))
        ) {
          if ((await findWorlds(source)).length)
            throw new Error(
              "This is a world archive. Use Upload world instead.",
            );
          throw new Error(
            "A full server backup must contain server.properties",
          );
        }
        if (kind === "modpack" && !(await exists(path.join(source, "mods"))))
          throw new Error(
            "A server-pack ZIP must contain a mods folder or a supported pack manifest",
          );
        record.warnings.push(
          "Custom startup/install scripts are not executed. Select the exact runtime if it could not be detected.",
        );
      }
      this.save(record);
      return record;
    } catch (e) {
      await fs.rm(dir, { recursive: true, force: true });
      throw e;
    }
  }
  async missing(record: ImportRecord) {
    const dir = await this.dir(record.id);
    return record.files
      .filter((f) => !f.urls.length && !f.optional)
      .map((f) => ({ path: f.path, projectId: f.projectId, fileId: f.fileId }));
  }
  async manual(
    record: ImportRecord,
    relative: string,
    stream: NodeJS.ReadableStream,
  ) {
    if (record.state !== "ready")
      throw new Error("Import is no longer editable");
    const file = record.files.find((f) => f.path === relative);
    if (!file || !Object.keys(file.hashes).length)
      throw new Error("No verifiable missing file matches this upload");
    const folder = path.join(await this.dir(record.id), "manual");
    const dest = await noSymlinks(folder, relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const temporary = dest + "." + randomUUID();
    try {
      await boundedWrite(stream, temporary, uploadLimit());
      await checkHashes(temporary, file.hashes);
      await fs.rename(temporary, dest);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async prepare(
    record: ImportRecord,
    runtime: Runtime,
    optional: string[],
    progress: (s: string) => void,
  ) {
    const dir = await this.dir(record.id),
      source = await noSymlinks(dir, record.source),
      dest = path.join(dir, "prepared");
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(dest);
    if (
      record.runtime &&
      JSON.stringify(runtimeSchema.parse(runtime)) !==
        JSON.stringify(record.runtime)
    )
      throw new Error("Runtime must match the pack manifest");
    const java = await javaFor(runtime.version);
    if (![8, 11, 16, 17, 21, 25].includes(java))
      throw new Error(`Java ${java} is not supported by this panel image`);
    if (
      ["FABRIC", "FORGE", "NEOFORGE", "QUILT"].includes(runtime.type) &&
      !runtime.loaderVersion
    )
      throw new Error("Choose the exact loader version");
    if (["mrpack", "curseforge"].includes(record.format)) {
      let downloaded = 0;
      for (const file of record.files) {
        if (file.optional && !optional.includes(file.path)) continue;
        const target = await noSymlinks(dest, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        progress(`Downloading ${file.path}`);
        const manual = await noSymlinks(path.join(dir, "manual"), file.path);
        if (await exists(manual)) await fs.copyFile(manual, target);
        else {
          if (!file.urls.length)
            throw new Error(`Upload the missing file: ${file.path}`);
          let complete = false;
          for (const url of file.urls) {
            try {
              const r = await remote(url);
              await boundedWrite(
                Readable.fromWeb(r.body as any),
                target,
                expandedLimit() - downloaded,
              );
              await checkHashes(target, file.hashes);
              complete = true;
              break;
            } catch {
              await fs.rm(target, { force: true });
            }
          }
          if (!complete)
            throw new Error(
              `Could not download and verify ${file.path}. Upload it manually or retry.`,
            );
        }
        await checkHashes(target, file.hashes);
        downloaded += (await fs.stat(target)).size;
        if (downloaded > expandedLimit())
          throw new Error("Pack exceeds expanded size limit");
      }
      const overrides =
        record.format === "curseforge"
          ? [this.store.get(`import-overrides:${record.id}`) || "overrides"]
          : ["overrides", "server-overrides"];
      for (const folder of overrides) {
        const from = await noSymlinks(source, folder);
        if (await exists(from)) await fs.cp(from, dest, { recursive: true });
      }
    } else await fs.cp(source, dest, { recursive: true });
    if ((await treeBytes(dest)) > expandedLimit())
      throw new Error("Pack exceeds expanded size limit");
    // Runtime-generated state must never be imported from another machine.
    for (const entry of await fs.readdir(dest))
      if (entry.startsWith(".mk-"))
        await fs.rm(path.join(dest, entry), { recursive: true, force: true });
    return {
      dest,
      runtime: {
        ...runtime,
        java,
        image: `itzg/minecraft-server:${IMAGE_RELEASE}-java${java}`,
      },
    };
  }
}
export async function checkHashes(
  file: string,
  hashes: Record<string, string>,
) {
  const entries = Object.entries(hashes).filter(([key]) =>
    ["sha512", "sha1", "md5"].includes(key),
  );
  if (!entries.length) throw new Error("Download has no supported checksum");
  const checks = entries.map(([key]) => createHash(key));
  for await (const chunk of createReadStream(file))
    checks.forEach((hash) => hash.update(chunk));
  entries.forEach(([, expected], i) => {
    if (checks[i].digest("hex").toLowerCase() !== expected.toLowerCase())
      throw new Error("Downloaded file checksum mismatch");
  });
}
