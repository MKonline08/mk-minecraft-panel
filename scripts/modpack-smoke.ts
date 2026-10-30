import { repair, rollbackRepair, inventory } from "../server/repairs.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import yazl from "yazl";
import { Engine, IMAGE_RELEASE } from "../server/docker.js";
import { Store } from "../server/store.js";
import { Jobs } from "../server/jobs.js";
import { Imports } from "../server/imports.js";
import { runImport, rollbackImport } from "../server/import-jobs.js";
import { defaults, type Server } from "../server/core.js";
const fixtures = {
  fabric: {
    minecraft: "1.21.1",
    loader: "fabric-loader",
    version: "0.16.10",
    mod: "sOzRw3CG",
    sha512:
      "3ad31620fac4ff44327dc7dedbe162b2d978f3f246dc16255a6e400ce9592a0d326fe36a626f3c1bf30a11f813093cbb4dcc107af039cff724d0cdf648541fdf",
  },
  forge: {
    minecraft: "1.20.1",
    loader: "forge",
    version: "47.3.0",
    mod: "DG5Fn9Sz",
    sha512:
      "a1960a7c03dc32d4ccaccaf28afdd9b078758bbd62d15a91d4039a83fa9397a098e89b69591f6bd5190254d9ee97e502504154b9aec764adb8c65f000b75ba2c",
  },
  neoforge: {
    minecraft: "1.21.1",
    loader: "neoforge",
    version: "21.1.218",
    mod: "x7kQWVju",
    sha512:
      "19af89a2075bb10a63884fa853ebf84b02c79dc3242430ecdad056fd764fdcde367a7303276b329df01b0736e2ef264c5d80c7dc92c6aebd244f556a230bb417",
  },
};
const key = (process.env.PACK_LOADER || "fabric") as keyof typeof fixtures;
const fixture = fixtures[key];
if (!fixture) throw new Error("Unknown pack fixture");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-pack-live-"));
const store = new Store(root),
  engine = new Engine(root, root),
  jobs = new Jobs(store, engine),
  imports = new Imports(store);
jobs.close();
let s: Server = {
  id: randomUUID(),
  name: `MK ${key} integration pack`,
  type: "VANILLA",
  version: fixture.minecraft,
  java: 21,
  image: `itzg/minecraft-server:${IMAGE_RELEASE}-java21`,
  memory: 2,
  port: 25690,
  motd: "Pack test",
  seed: "123",
  created: new Date().toISOString(),
  settings: { ...defaults, viewDistance: 3 },
  banner: false,
  icon: false,
  backupHours: 0,
  retention: 5,
  lastBackup: null,
};
const log = (text: string) => console.log(key, text);
try {
  store.save(s);
  await engine.configure(s);
  await fs.writeFile(
    path.join(engine.dir(s), "original.txt"),
    "previous installation",
  );
  const response = await fetch(
    `https://api.modrinth.com/v2/version/${fixture.mod}`,
  );
  assert.ok(response.ok);
  const version = (await response.json()) as any,
    file = version.files.find((f: any) => f.primary) || version.files[0];
  assert.equal(file.hashes.sha512, fixture.sha512);
  const manifest = {
    formatVersion: 1,
    game: "minecraft",
    name: `MK ${key} smoke pack`,
    versionId: "1",
    dependencies: {
      minecraft: fixture.minecraft,
      [fixture.loader]: fixture.version,
    },
    files: [
      {
        path: `mods/${file.filename}`,
        hashes: file.hashes,
        downloads: [file.url],
        fileSize: file.size,
        env: { server: "required", client: "required" },
      },
    ],
  };
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "modrinth.index.json");
  zip.addBuffer(
    Buffer.from("view-distance=3\nsimulation-distance=3\n"),
    "server-overrides/server.properties",
  );
  zip.end();
  const record = await imports.inspect(
    s.id,
    "modpack",
    zip.outputStream,
    "smoke.mrpack",
  );
  await runImport(
    jobs,
    s,
    store.newJob(s.id, "import", { importId: record.id }),
    log,
  );
  s = store.server(s.id);
  assert.equal(s.pack?.status, "verified");
  assert.match(await engine.command(s, "list"), /players|online/i);
  await engine.stop(s);
  await fs.access(path.join(engine.dir(s), "world/level.dat"));
  await fs.writeFile(
    path.join(engine.dir(s), "world/mk-pack-marker"),
    "persistent",
  );
  await engine.start(s, log);
  await engine.ready(s, log);
  await engine.stop(s);
  assert.equal(
    await fs.readFile(path.join(engine.dir(s), "world/mk-pack-marker"), "utf8"),
    "persistent",
  );
  const repairId = randomUUID();
  store.set(
    `diagnosis:${repairId}`,
    JSON.stringify({
      id: repairId,
      serverId: s.id,
      created: new Date().toISOString(),
      runtime: JSON.stringify([s.type, s.version, s.loaderVersion]),
      inventory: await inventory(path.join(engine.dir(s), "mods")),
      evidence: [
        "Integration fixture: explicitly selected FerriteCore disable trial",
      ],
      explanation: "Integration fixture",
      warnings: [],
      proposals: [
        {
          id: "disable",
          kind: "disable",
          title: "Disable integration mod",
          files: [{ old: file.filename, name: file.filename + ".disabled" }],
          clientRequired: false,
        },
      ],
    }),
  );
  await repair(jobs, s, repairId, "disable", log);
  assert.equal(
    JSON.parse(store.get(`repair-result:${s.id}`)!).status,
    "verified",
  );
  await fs.access(
    path.join(engine.dir(s), "mods", file.filename + ".disabled"),
  );
  await rollbackRepair(jobs, store.server(s.id), log);
  s = store.server(s.id);
  await fs.access(path.join(engine.dir(s), "mods", file.filename));
  await engine.start(s, log);
  await engine.ready(s, log);
  await engine.stop(s);
  const backup = await jobs.backup(s, log, false);
  await fs.writeFile(
    path.join(engine.dir(s), "world/mk-pack-marker"),
    "changed",
  );
  await jobs.replace(s, path.join(root, "backups", s.id, backup), false, log);
  assert.equal(
    await fs.readFile(path.join(engine.dir(s), "world/mk-pack-marker"), "utf8"),
    "persistent",
  );
  await engine.start(s, log);
  await engine.ready(s, log);
  await engine.command(s, "list");
  await rollbackImport(jobs, s, log);
  s = store.server(s.id);
  assert.equal(s.type, "VANILLA");
  assert.equal(
    await fs.readFile(path.join(engine.dir(s), "original.txt"), "utf8"),
    "previous installation",
  );
  console.log(
    `PASS ${key}: verified pack download, exact loader, readiness, RCON, restart, world persistence, backup/restore and rollback`,
  );
} catch (e) {
  console.error(await engine.logs(s).catch(() => ""));
  throw e;
} finally {
  await engine.stop(s).catch(() => {});
  const c = await engine.container(s).catch(() => null);
  if (c) await c.remove();
  store.close();
}
