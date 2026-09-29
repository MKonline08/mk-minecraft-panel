import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";
import { safePath } from "./core.js";
export async function extractZip(
  file: string,
  dest: string,
  maxBytes = 8 * 1024 ** 3,
) {
  await fs.mkdir(dest, { recursive: true });
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (e, z) =>
      e ? reject(e) : resolve(z!),
    ),
  );
  let bytes = 0,
    count = 0;
  const seen = new Set<string>();
  return new Promise<void>((resolve, reject) => {
    let failed = false;
    const fail = (e: Error) => {
      if (failed) return;
      failed = true;
      zip.close();
      reject(e);
    };
    zip.on("error", fail);
    zip.on("end", resolve);
    zip.on("entry", async (entry: yauzl.Entry) => {
      try {
        if (++count > 100000)
          throw new Error("Archive contains too many files");
        bytes += entry.uncompressedSize;
        if (bytes > maxBytes)
          throw new Error("Archive expands beyond the size limit");
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (mode === 0xa000)
          throw new Error("Archive symbolic links are not allowed");
        if (entry.generalPurposeBitFlag & 1)
          throw new Error("Encrypted archives are not supported");
        const name = entry.fileName;
        const key = name.toLowerCase();
        if (seen.has(key)) throw new Error("Archive contains duplicate paths");
        seen.add(key);
        const target = safePath(dest, name);
        if (name.endsWith("/")) await fs.mkdir(target, { recursive: true });
        else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
            zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s!))),
          );
          await pipeline(stream, createWriteStream(target, { flags: "wx" }));
        }
        if (!failed) zip.readEntry();
      } catch (e) {
        fail(e as Error);
      }
    });
    zip.readEntry();
  });
}
export async function zipFolder(dir: string, dest: string) {
  const zip = new yazl.ZipFile();
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const writing = pipeline(
    zip.outputStream,
    createWriteStream(dest + ".partial"),
  );
  async function walk(folder: string) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      if (item.isSymbolicLink())
        throw new Error("Cannot back up symbolic links");
      const p = path.join(folder, item.name);
      if (item.isDirectory()) await walk(p);
      else if (item.isFile())
        zip.addFile(p, path.relative(dir, p).replaceAll("\\", "/"));
    }
  }
  try {
    await walk(dir);
    zip.end();
    await writing;
    await fs.rename(dest + ".partial", dest);
  } catch (e) {
    zip.end();
    await writing.catch(() => {});
    await fs.rm(dest + ".partial", { force: true });
    throw e;
  }
}
export async function worldRoot(dir: string) {
  if (
    await fs
      .stat(path.join(dir, "level.dat"))
      .then((s) => s.isFile())
      .catch(() => false)
  )
    return dir;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await fs
        .stat(path.join(dir, entry.name, "level.dat"))
        .then((s) => s.isFile())
        .catch(() => false))
    )
      candidates.push(path.join(dir, entry.name));
  }
  if (candidates.length !== 1)
    throw new Error(
      "Upload a Java world ZIP containing level.dat, directly or inside one world folder.",
    );
  return candidates[0];
}
export async function jarFiles(buffer: Buffer, names: string[]) {
  const zip = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (e, z) =>
      e ? rej(new Error("Not a valid JAR archive")) : res(z!),
    ),
  );
  const result: Record<string, string> = {};
  let count = 0;
  return new Promise<Record<string, string>>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () => resolve(result));
    zip.on("entry", async (e) => {
      try {
        if (++count > 50000) throw new Error("JAR contains too many entries");
        if (names.includes(e.fileName)) {
          if (e.uncompressedSize > 1024 * 1024)
            throw new Error("Mod metadata is too large");
          const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
            zip.openReadStream(e, (err, s) => (err ? rej(err) : res(s!))),
          );
          let text = "";
          for await (const chunk of stream as any) text += chunk.toString();
          result[e.fileName] = text;
        }
        zip.readEntry();
      } catch (e) {
        zip.close();
        reject(e);
      }
    });
    zip.readEntry();
  });
}
