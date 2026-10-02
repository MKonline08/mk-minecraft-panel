import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { noSymlinks } from "./core.js";

export const EDITOR_LIMIT = 16 * 1024 ** 2;
export function decodeText(buffer: Buffer) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer,
    );
  } catch {
    return null;
  }
}

export async function replaceFile(
  root: string,
  relative: string,
  source: string | Readable,
  overwrite: boolean,
) {
  const destination = await noSymlinks(root, relative);
  if (destination === path.resolve(root)) throw new Error("Choose a filename");
  const previous = await fs.stat(destination).catch((e) => {
    if (e.code !== "ENOENT") throw e;
    return null;
  });
  if (previous && !previous.isFile()) throw new Error("This path is a folder");
  if (previous && !overwrite)
    throw Object.assign(
      new Error("A file with this name already exists. Confirm replacement."),
      { statusCode: 409 },
    );
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    ".mk-upload-" + randomUUID(),
  );
  try {
    if (typeof source === "string")
      await fs.writeFile(temporary, source, { flag: "wx" });
    else {
      await pipeline(source, createWriteStream(temporary, { flags: "wx" }));
      if ((source as any).truncated)
        throw new Error(
          "Upload was incomplete; the original file was preserved",
        );
    }
    if (previous) await fs.chmod(temporary, previous.mode);
    await noSymlinks(root, relative);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
