import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { noSymlinks, safeName } from "./core.js";

export async function treeBytes(dir: string): Promise<number> {
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed");
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory())
    throw new Error("Only regular files and folders are supported");
  let bytes = 0;
  for (const name of await fs.readdir(dir))
    bytes += await treeBytes(path.join(dir, name));
  return bytes;
}
export class Trash {
  constructor(
    public root: string,
    public serverId: string,
    public live: string,
  ) {}
  async folder() {
    return noSymlinks(this.root, `trash/${safeName(this.serverId)}`);
  }
  async list() {
    const folder = await this.folder();
    const result = [];
    for (const id of await fs.readdir(folder).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return [];
    })) {
      const dir = await noSymlinks(folder, id);
      const entry = JSON.parse(
        await fs.readFile(path.join(dir, "entry.json"), "utf8"),
      );
      const present = await fs
        .lstat(path.join(dir, "content"))
        .catch(() => null);
      if (present)
        result.push({
          ...entry,
          id,
          bytes: await treeBytes(path.join(dir, "content")),
        });
    }
    return result;
  }
  async remove(paths: string[]) {
    const checked: { relative: string; source: string; bytes: number }[] = [];
    for (const relative of [...new Set(paths)]) {
      const source = await noSymlinks(this.live, relative);
      const canonical = path
        .relative(this.live, source)
        .split(path.sep)
        .join("/");
      if (!canonical || canonical.split("/").some((p) => p.startsWith(".mk-")))
        throw new Error("Cannot delete the server root or panel metadata");
      checked.push({
        relative: canonical,
        source,
        bytes: await treeBytes(source),
      });
    }
    const selected = checked.filter(
      (v) =>
        !checked.some(
          (p) => p !== v && v.relative.startsWith(p.relative + "/"),
        ),
    );
    const moved: { source: string; dir: string }[] = [];
    try {
      for (const item of selected) {
        const dir = path.join(await this.folder(), randomUUID());
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, "entry.json"),
          JSON.stringify({
            path: item.relative,
            bytes: item.bytes,
            deletedAt: new Date().toISOString(),
          }),
        );
        await noSymlinks(this.live, item.relative);
        await fs.rename(item.source, path.join(dir, "content"));
        moved.push({ source: item.source, dir });
      }
    } catch (e) {
      for (const item of moved.reverse()) {
        await fs.rename(path.join(item.dir, "content"), item.source);
        await fs.rm(item.dir, { recursive: true });
      }
      throw e;
    }
  }
  async restore(id: string) {
    const dir = await noSymlinks(await this.folder(), safeName(id));
    const entry = JSON.parse(
      await fs.readFile(path.join(dir, "entry.json"), "utf8"),
    );
    const dest = await noSymlinks(this.live, entry.path);
    if (
      await fs.lstat(dest).catch((e) => {
        if (e.code !== "ENOENT") throw e;
        return null;
      })
    )
      throw new Error(
        "Restore destination already exists; move or delete it first",
      );
    await treeBytes(path.join(dir, "content"));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(path.join(dir, "content"), dest);
    await fs.rm(dir, { recursive: true });
  }
  async empty() {
    const folder = await this.folder();
    await fs.rm(folder, { recursive: true, force: true });
  }
}
