import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import semver from "semver";
import { jarFiles } from "./archives.js";
import { json, USER_AGENT } from "./catalog.js";
import { contentFolder, pluginType, safeName, type Server } from "./core.js";
export type Compatibility = {
  status: "Compatible metadata" | "Incompatible" | "Unknown";
  reasons: string[];
  clientRequired: boolean;
};
export function versionCheck(
  v: any,
  s: Pick<Server, "version" | "type">,
): Compatibility {
  const reasons: string[] = [];
  if (!v.game_versions?.includes(s.version))
    reasons.push(
      `Requires Minecraft ${v.game_versions?.join(", ") || "an unspecified version"}`,
    );
  const loaders = pluginType(s.type)
    ? [
        s.type.toLowerCase(),
        "bukkit",
        "spigot",
        ...(s.type === "PURPUR" ? ["paper"] : []),
      ]
    : [s.type.toLowerCase()];
  if (!v.loaders?.some((l: string) => loaders.includes(l)))
    reasons.push(`Requires loader ${v.loaders?.join(", ") || "unknown"}`);
  if (v.server_side === "unsupported")
    reasons.push("Client-only mod; do not install on a server");
  return {
    status: reasons.length ? "Incompatible" : "Compatible metadata",
    reasons,
    clientRequired: v.client_side === "required",
  };
}
export async function inspectJar(
  buffer: Buffer,
  s: Server,
): Promise<Compatibility> {
  const m = await jarFiles(buffer, [
    "fabric.mod.json",
    "quilt.mod.json",
    "META-INF/mods.toml",
    "META-INF/neoforge.mods.toml",
    "plugin.yml",
    "paper-plugin.yml",
  ]);
  const bad = (reason: string): Compatibility => ({
    status: "Incompatible",
    reasons: [reason],
    clientRequired: false,
  });
  if (s.type === "VANILLA") return bad("Vanilla cannot load mods or plugins");
  if (m["fabric.mod.json"]) {
    if (s.type !== "FABRIC" && s.type !== "QUILT")
      return bad("This file requires Fabric");
    const f = JSON.parse(m["fabric.mod.json"]);
    if (f.environment === "client") return bad("This is a client-only mod");
    const requirement = f.depends?.minecraft;
    const requirements = Array.isArray(requirement)
      ? requirement
      : [requirement];
    if (
      requirement &&
      requirements.every((r: string) => semver.validRange(r)) &&
      !requirements.some((r: string) =>
        semver.satisfies(semver.coerce(s.version)!, r),
      )
    )
      return bad(`Requires Minecraft ${requirements.join(" or ")}`);
    return {
      status: "Unknown",
      reasons: [
        "Fabric metadata found. Loader version and dependency compatibility must still be verified.",
        ...Object.keys(f.depends || {})
          .filter((k) => !["minecraft", "java", "fabricloader"].includes(k))
          .map((k) => `Required dependency: ${k}`),
      ],
      clientRequired: f.environment !== "server",
    };
  }
  if (m["quilt.mod.json"] && s.type !== "QUILT")
    return bad("This file requires Quilt");
  if (m["META-INF/neoforge.mods.toml"] && s.type !== "NEOFORGE")
    return bad("This file requires NeoForge");
  if (m["META-INF/mods.toml"] && !["FORGE", "NEOFORGE"].includes(s.type))
    return bad("This file requires Forge or NeoForge");
  if ((m["plugin.yml"] || m["paper-plugin.yml"]) && !pluginType(s.type))
    return bad("This is a plugin, not a mod");
  if (m["paper-plugin.yml"] && s.type === "SPIGOT")
    return bad("This plugin requires Paper or Purpur");
  return {
    status: "Unknown",
    reasons: [
      "Uploaded file metadata cannot fully confirm version and dependencies. Check the author’s requirements.",
    ],
    clientRequired: !pluginType(s.type),
  };
}
export async function searchMods(query: string, s: Server) {
  contentFolder(s.type);
  const loaders = pluginType(s.type)
    ? ["bukkit", "spigot", ...(s.type !== "SPIGOT" ? ["paper"] : [])]
    : [s.type.toLowerCase()];
  const facets = JSON.stringify([
    [`versions:${s.version}`],
    loaders.map((l) => `categories:${l}`),
    ["server_side:required", "server_side:optional"],
  ]);
  return json(
    `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&limit=18`,
  );
}
export async function resolveMods(project: string, s: Server) {
  const items: any[] = [];
  const visited = new Set<string>();
  async function visit(id: string, versionId?: string) {
    if (items.length >= 50) throw new Error("Too many dependencies");
    const p = await json(
      `https://api.modrinth.com/v2/project/${encodeURIComponent(id)}`,
    );
    if (visited.has(p.id)) return;
    visited.add(p.id);
    const versions = versionId
      ? [
          await json(
            `https://api.modrinth.com/v2/version/${encodeURIComponent(versionId)}`,
          ),
        ]
      : await json(
          `https://api.modrinth.com/v2/project/${encodeURIComponent(id)}/version?game_versions=${encodeURIComponent(JSON.stringify([s.version]))}`,
        );
    const v = versions.find(
      (v: any) =>
        versionCheck({ ...v, server_side: p.server_side }, s).status !==
        "Incompatible",
    );
    if (!v)
      throw new Error(
        `No compatible version of ${p.title} for ${s.type} ${s.version}`,
      );
    const file = v.files.find((f: any) => f.primary) || v.files[0];
    if (!file) throw new Error("Mod version has no downloadable file");
    items.push({
      project: p.id,
      title: p.title,
      version: v.id,
      file,
      dependencies: v.dependencies,
      clientRequired: p.client_side === "required",
    });
    for (const dep of v.dependencies || []) {
      if (dep.dependency_type === "required") {
        if (!dep.project_id && !dep.version_id)
          throw new Error(
            "A required external dependency must be installed manually",
          );
        if (dep.project_id)
          await visit(dep.project_id, dep.version_id || undefined);
        else {
          const dv = await json(
            `https://api.modrinth.com/v2/version/${encodeURIComponent(dep.version_id)}`,
          );
          await visit(dv.project_id, dep.version_id);
        }
      }
    }
  }
  await visit(project);
  const ids = new Set(items.map((i) => i.project));
  for (const i of items)
    for (const dep of i.dependencies || [])
      if (dep.dependency_type === "incompatible" && ids.has(dep.project_id))
        throw new Error("Selected mods declare an incompatibility");
  return items;
}
export async function installMods(items: any[], dir: string, s: Server) {
  const folder = path.join(dir, contentFolder(s.type));
  await fs.mkdir(folder, { recursive: true });
  const manifestPath = path.join(folder, ".mk-modrinth.json");
  const installed = JSON.parse(
    await fs.readFile(manifestPath, "utf8").catch(() => "[]"),
  );
  for (const i of items) {
    if (installed.some((x: any) => x.project === i.project))
      throw new Error(
        `${i.title} is already installed. Remove its JAR before changing versions.`,
      );
    for (const dep of i.dependencies || [])
      if (
        dep.dependency_type === "incompatible" &&
        installed.some((x: any) => x.project === dep.project_id)
      )
        throw new Error(`${i.title} conflicts with an installed mod`);
  }
  const downloaded = [];
  for (const i of items) {
    const url = new URL(i.file.url);
    if (url.protocol !== "https:" || url.hostname !== "cdn.modrinth.com")
      throw new Error("Unexpected download source");
    const r = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok || Number(r.headers.get("content-length")) > 100 * 1024 ** 2)
      throw new Error("Mod download failed or is too large");
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of r.body as any) {
      size += chunk.length;
      if (size > 100 * 1024 ** 2)
        throw new Error("Mod download exceeds 100 MB");
      parts.push(chunk);
    }
    const b = Buffer.concat(parts);
    if (
      !i.file.hashes?.sha512 ||
      createHash("sha512").update(b).digest("hex") !== i.file.hashes.sha512
    )
      throw new Error("Downloaded mod checksum does not match");
    const name = safeName(i.file.filename);
    if (!name.endsWith(".jar"))
      throw new Error("Only JAR files can be installed");
    await fs
      .access(path.join(folder, name))
      .then(() => {
        throw new Error(`${name} already exists`);
      })
      .catch((e: any) => {
        if (e.code !== "ENOENT") throw e;
      });
    downloaded.push({ name, b, item: i });
  }
  const added: string[] = [];
  try {
    for (const d of downloaded) {
      await fs.writeFile(path.join(folder, d.name), d.b, { flag: "wx" });
      added.push(d.name);
    }
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        [
          ...installed,
          ...downloaded.map((d) => ({
            project: d.item.project,
            file: d.name,
            title: d.item.title,
            version: d.item.version,
            dependencies: d.item.dependencies,
          })),
        ],
        null,
        2,
      ),
    );
  } catch (e) {
    for (const name of added)
      await fs.rm(path.join(folder, name), { force: true });
    throw e;
  }
}
