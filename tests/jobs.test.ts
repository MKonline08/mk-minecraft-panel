import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/store.js";
import { Jobs } from "../server/jobs.js";
import { Engine } from "../server/docker.js";
import { defaults, type Server } from "../server/core.js";
import { zipFolder } from "../server/archives.js";
import { installMods } from "../server/mods.js";
test("world import, safety backup, full restore and persisted interrupted jobs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-job-test-"));
  const store = new Store(root);
  const engine = new Engine(root, root);
  engine.state = async () => ({
    status: "stopped",
    memory: 0,
    cpu: 0,
    players: null,
  });
  engine.stop = async () => {};
  const s: Server = {
    id: "world-test",
    name: "Test",
    type: "VANILLA",
    version: "1.21.1",
    java: 21,
    memory: 1,
    port: 25565,
    motd: "original",
    seed: "",
    settings: defaults,
    created: new Date().toISOString(),
    banner: false,
    icon: false,
    backupHours: 0,
    retention: 5,
    lastBackup: null,
    image: "test",
  };
  store.save(s);
  await engine.configure(s);
  const jobs = new Jobs(store, engine);
  jobs.close();
  try {
    await fs.mkdir(path.join(engine.dir(s), "world"));
    await fs.writeFile(
      path.join(engine.dir(s), "world", "level.dat"),
      "original-world",
    );
    const incoming = path.join(root, "new-world");
    await fs.mkdir(incoming);
    await fs.writeFile(path.join(incoming, "level.dat"), "new-world");
    const upload = path.join(root, "upload.zip");
    await zipFolder(incoming, upload);
    await jobs.replace(s, upload, true, () => {});
    assert.equal(
      await fs.readFile(path.join(engine.dir(s), "world", "level.dat"), "utf8"),
      "new-world",
    );
    const backups = await fs.readdir(path.join(root, "backups", s.id));
    assert.equal(backups.length, 1);
    await jobs.replace(
      s,
      path.join(root, "backups", s.id, backups[0]),
      false,
      () => {},
    );
    assert.equal(
      await fs.readFile(path.join(engine.dir(s), "world", "level.dat"), "utf8"),
      "original-world",
    );
    assert.equal(store.server(s.id).motd, "original");
    const interrupted = store.newJob(s.id, "world");
    interrupted.status = "running";
    store.saveJob(interrupted);
    const restart = store.newJob(s.id, "start");
    restart.status = "running";
    store.saveJob(restart);
    const resumed = new Jobs(store, engine);
    resumed.close();
    assert.equal(store.job(interrupted.id).status, "failed");
    assert.equal(store.job(restart.id).status, "queued");
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("failed mod download/checksum leaves installed files unchanged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-download-"));
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("failure", { status: 503 });
    const item = {
      project: "test",
      title: "Test",
      version: "1",
      file: {
        url: "https://cdn.modrinth.com/test.jar",
        filename: "test.jar",
        hashes: { sha512: "not-a-hash" },
      },
      dependencies: [],
    };
    await assert.rejects(
      installMods([item], root, { type: "FABRIC" } as Server),
      /download failed/,
    );
    assert.deepEqual(await fs.readdir(path.join(root, "mods")), []);
    globalThis.fetch = async () => new Response("wrong content");
    await assert.rejects(
      installMods([item], root, { type: "FABRIC" } as Server),
      /checksum/,
    );
    assert.deepEqual(await fs.readdir(path.join(root, "mods")), []);
  } finally {
    globalThis.fetch = original;
    await fs.rm(root, { recursive: true, force: true });
  }
});
