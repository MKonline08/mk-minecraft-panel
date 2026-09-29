import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSchema,
  safePath,
  noSymlinks,
  patchProperties,
  contentFolder,
} from "../server/core.js";
import { zipFolder, extractZip, worldRoot } from "../server/archives.js";
import { versionCheck, inspectJar } from "../server/mods.js";
import { Store } from "../server/store.js";
import yazl from "yazl";
test("creation requires EULA and a real-looking release and bounded memory", () => {
  const b = {
    name: "MK",
    type: "PAPER",
    version: "1.21.1",
    memory: 2,
    eula: true,
  };
  assert.equal(createSchema.parse(b).autoStart, true);
  for (const change of [
    { eula: false },
    { memory: 0 },
    { version: "latest" },
    { type: "OTHER" },
  ])
    assert.throws(() => createSchema.parse({ ...b, ...change }));
});
test("paths cannot escape or use Windows drive/alternate stream paths", () => {
  for (const p of [
    "../secret",
    "/etc/passwd",
    "C:/secret",
    "a\\..\\x",
    "file:stream",
  ])
    assert.throws(() => safePath("/data/servers/id", p));
  assert.equal(
    safePath("/data/servers/id", "world/level.dat"),
    path.resolve("/data/servers/id/world/level.dat"),
  );
});
test("properties retain unrelated settings and safely encode MOTD", () => {
  const r = patchProperties("difficulty=easy\ncustom=true\nmotd=old\n", {
    difficulty: "hard",
    motd: "§bMK\nSecond line",
  });
  assert.match(r, /custom=true/);
  assert.match(r, /difficulty=hard/);
  assert.match(r, /motd=\\u00a7bMK\\nSecond line/);
  assert.doesNotMatch(r, /motd=old/);
});
test("plugin and mod directories are separate", () => {
  assert.equal(contentFolder("PAPER"), "plugins");
  assert.equal(contentFolder("FABRIC"), "mods");
  assert.throws(() => contentFolder("VANILLA"));
});
test("compatibility rejects wrong versions, loaders and client-only files", () => {
  const s = { type: "FABRIC" as const, version: "1.21.1" };
  const v = {
    game_versions: ["1.21.1"],
    loaders: ["fabric"],
    server_side: "required",
  };
  assert.equal(versionCheck(v, s).status, "Compatible metadata");
  for (const b of [
    { game_versions: ["1.20.1"] },
    { loaders: ["forge"] },
    { server_side: "unsupported" },
  ])
    assert.equal(versionCheck({ ...v, ...b }, s).status, "Incompatible");
});
async function jar(name: string, value: string) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(value), name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
test("manual JAR inspection rejects declared mismatch and reports incomplete checks honestly", async () => {
  const s = { type: "FABRIC", version: "1.21.1" } as any;
  assert.equal(
    (
      await inspectJar(
        await jar("fabric.mod.json", JSON.stringify({ environment: "client" })),
        s,
      )
    ).status,
    "Incompatible",
  );
  assert.equal(
    (
      await inspectJar(
        await jar(
          "fabric.mod.json",
          JSON.stringify({ depends: { minecraft: "~1.20.1" } }),
        ),
        s,
      )
    ).status,
    "Incompatible",
  );
  assert.equal(
    (
      await inspectJar(
        await jar(
          "fabric.mod.json",
          JSON.stringify({
            depends: { minecraft: "~1.21.1", "fabric-api": "*" },
          }),
        ),
        s,
      )
    ).status,
    "Unknown",
  );
  await assert.rejects(inspectJar(Buffer.from("bad"), s));
});
test("backup round trip preserves world data and rejects oversized/broken archives", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-archive-"));
  try {
    const input = path.join(root, "in");
    await fs.mkdir(input);
    await fs.writeFile(path.join(input, "level.dat"), "saved-world");
    await fs.mkdir(path.join(input, "region"));
    await fs.writeFile(path.join(input, "region", "r.0.0.mca"), "region-data");
    const zip = path.join(root, "backup.zip");
    await zipFolder(input, zip);
    const dest = path.join(root, "out");
    await extractZip(zip, dest);
    assert.equal(
      await fs.readFile(path.join(dest, "level.dat"), "utf8"),
      "saved-world",
    );
    assert.equal(await worldRoot(dest), dest);
    await assert.rejects(extractZip(zip, path.join(root, "limit"), 1));
    await fs.writeFile(path.join(root, "bad.zip"), "nope");
    await assert.rejects(
      extractZip(path.join(root, "bad.zip"), path.join(root, "broken")),
    );
    await assert.rejects(worldRoot(root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("SQLite job and server state survive reopening", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-store-"));
  try {
    let s = new Store(root);
    const j = s.newJob("id", "start");
    s.close();
    s = new Store(root);
    assert.equal(s.job(j.id).status, "queued");
    s.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test(
  "symlink traversal is blocked",
  { skip: process.platform === "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-link-"));
    try {
      await fs.symlink(os.tmpdir(), path.join(root, "link"));
      await assert.rejects(noSymlinks(root, "link/secret"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
