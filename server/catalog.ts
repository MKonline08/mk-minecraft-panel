import { TYPES, type ServerType } from "./core.js";
export const USER_AGENT =
  "MK-Minecraft-Panel/1.0 (github.com/MKonline08/mk-minecraft-panel)";
const cache = new Map<string, { until: number; data: any }>();
export async function json(url: string): Promise<any> {
  const c = cache.get(url);
  if (c && c.until > Date.now()) return c.data;
  const r = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok)
    throw new Error(
      `Upstream service returned ${r.status}. Try again shortly.`,
    );
  const data = await r.json();
  cache.set(url, { until: Date.now() + 300000, data });
  return data;
}
export async function minecraftVersions() {
  const m = await json(
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
  );
  return m.versions
    .filter(
      (v: any) => v.type === "release" && /^\d+\.\d+(?:\.\d+)?$/.test(v.id),
    )
    .map((v: any) => ({ id: v.id, url: v.url }));
}
export async function javaFor(version: string) {
  const versions = await minecraftVersions();
  const v = versions.find((v: any) => v.id === version);
  if (!v) throw new Error("Unknown Minecraft release");
  const detail = await json(v.url);
  if (!detail.downloads?.server)
    throw new Error("This release has no Java server download");
  return detail.javaVersion?.majorVersion ?? 8;
}
export async function available(type: ServerType, version: string) {
  if (type === "VANILLA") return true;
  if (type === "PAPER")
    return Object.values(
      (await json("https://fill.papermc.io/v3/projects/paper")).versions,
    )
      .flat()
      .includes(version);
  if (type === "PURPUR")
    return (await json("https://api.purpurmc.org/v2/purpur")).versions.includes(
      version,
    );
  if (type === "FABRIC" || type === "QUILT") {
    const base =
      type === "FABRIC"
        ? "https://meta.fabricmc.net/v2"
        : "https://meta.quiltmc.org/v3";
    return (await json(base + "/versions/game")).some(
      (v: any) => v.version === version,
    );
  }
  if (type === "FORGE")
    return Object.keys(
      (
        await json(
          "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
        )
      ).promos,
    ).some((k) => k.startsWith(version + "-"));
  if (type === "NEOFORGE") {
    if (!version.startsWith("1.")) return false;
    const [_, minor, patch = "0"] = version.split(".");
    const r = await fetch(
      "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
      { signal: AbortSignal.timeout(30000) },
    );
    if (!r.ok) throw new Error("Cannot check NeoForge releases");
    return (await r.text()).includes(`<version>${minor}.${patch}.`);
  }
  if (type === "SPIGOT") {
    const r = await fetch(`https://hub.spigotmc.org/versions/${version}.json`, {
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  }
  return false;
}
export async function choices(version: string) {
  return Promise.all(
    TYPES.map(async (type) => {
      try {
        return { type, available: await available(type, version), note: "" };
      } catch {
        return {
          type,
          available: false,
          note: "Version service unavailable; retry later",
        };
      }
    }),
  );
}
