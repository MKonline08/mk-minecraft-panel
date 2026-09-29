import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Store } from "../server/store.js";
import { Engine } from "../server/docker.js";
import { defaults, type Server } from "../server/core.js";
import { PlayerTracker, onlineNames } from "../server/players.js";
import { Storage, workspaceSettings } from "../server/workspace.js";
import { Jobs } from "../server/jobs.js";

export const fixture = (): Server => ({
  id: randomUUID(),
  name: "Test",
  type: "VANILLA",
  version: "1.21.1",
  java: 21,
  memory: 1,
  port: 25565,
  motd: "Hi",
  seed: "",
  created: new Date().toISOString(),
  settings: { ...defaults },
  banner: false,
  icon: false,
  backupHours: 0,
  retention: 5,
  lastBackup: null,
  image: "test",
});

test("player history imports real records, survives restart, deduplicates UUIDs, tracks live changes and distinguishes failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-players-"));
  let store = new Store(root);
  const s = fixture();
  store.save(s);
  const engine = new Engine(root, root);
  let running = true;
  let fail = false;
  let response = "There are 1 of a max of 20 players online: Alex";
  engine.container = async () =>
    ({ inspect: async () => ({ State: { Running: running } }) }) as any;
  engine.command = async () => {
    if (fail) throw new Error("Connection failed");
    return response;
  };
  let tracker = new PlayerTracker(store, engine, false);
  try {
    const alex = randomUUID(),
      sam = randomUUID(),
      phantom = randomUUID();
    await fs.mkdir(path.join(engine.dir(s), "world", "playerdata"), {
      recursive: true,
    });
    await fs.mkdir(path.join(engine.dir(s), "logs"), { recursive: true });
    await fs.writeFile(
      path.join(engine.dir(s), "world", "playerdata", sam + ".dat"),
      "saved",
    );
    await fs.writeFile(
      path.join(engine.dir(s), "usercache.json"),
      JSON.stringify([
        { name: "Alex", uuid: alex },
        { name: "Sam", uuid: sam },
        { name: "NeverJoined", uuid: phantom },
      ]),
    );
    await fs.writeFile(
      path.join(engine.dir(s), "logs", "old.log.gz"),
      gzipSync("[10:00:00] [Server thread/INFO]: OldFriend joined the game\n"),
    );
    await fs.writeFile(
      path.join(engine.dir(s), "logs", "latest.log"),
      "[10:01:00] [Server thread/INFO]: Alex joined the game\n",
    );
    await tracker.refresh(s);
    let data = await tracker.get(s);
    assert.equal(data.status, "ready");
    assert.equal(data.online[0].name, "Alex");
    assert.equal(data.history.length, 3);
    assert.equal(
      data.history.some((p: any) => p.name === "NeverJoined"),
      false,
    );
    assert.equal(
      data.history.find((p: any) => p.name === "Sam").firstObserved,
      null,
    );
    response = "There are 0 of a max of 20 players online: ";
    await tracker.refresh(s);
    assert.equal((await tracker.get(s)).online.length, 0);
    fail = true;
    await tracker.refresh(s);
    assert.equal((await tracker.get(s)).status, "unavailable");
    running = false;
    await tracker.refresh(s);
    assert.equal((await tracker.get(s)).status, "stopped");
    await fs.appendFile(
      path.join(engine.dir(s), "logs", "latest.log"),
      "[10:02:00] [Server thread/INFO]: BriefVisitor joined the game\n",
    );
    await tracker.refresh(s);
    assert.ok(store.playerHistory(s.id).some((p) => p.name === "BriefVisitor"));
    await tracker.close();
    store.close();
    store = new Store(root);
    tracker = new PlayerTracker(store, engine, false);
    assert.equal(store.playerHistory(s.id).length, 4);
    await fs.writeFile(
      path.join(engine.dir(s), "usercache.json"),
      JSON.stringify([
        { name: "RenamedAlex", uuid: alex },
        { name: "Sam", uuid: sam },
      ]),
    );
    await tracker.refresh(s);
    assert.equal(store.playerHistory(s.id).length, 4);
    assert.ok(store.playerHistory(s.id).some((p) => p.name === "RenamedAlex"));
    await fs.writeFile(
      path.join(engine.dir(s), "logs", "bad.log.gz"),
      "broken archive",
    );
    await fs.appendFile(
      path.join(engine.dir(s), "logs", "latest.log"),
      "[10:04:00] [Server thread/INFO]: Alex joined the game\n[10:05:00] [Server thread/INFO]: NewFriend joined the game\n",
    );
    await tracker.refresh(s);
    assert.equal(store.playerHistory(s.id).length, 5);
    assert.ok(store.playerHistory(s.id).some((p) => p.name === "RenamedAlex"));
    assert.ok((await tracker.get(s)).historyWarning);
    assert.throws(() => onlineNames("Something went wrong"));
  } finally {
    await tracker.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("storage separates world and backup bytes, caches scans, and skips symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-storage-"));
  const s = fixture();
  const storage = new Storage(root);
  try {
    const dir = path.join(root, "servers", s.id, "world");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "level.dat"), Buffer.alloc(100));
    await fs.mkdir(path.join(root, "backups", s.id), { recursive: true });
    await fs.writeFile(
      path.join(root, "backups", s.id, "saved.zip"),
      Buffer.alloc(40),
    );
    if (process.platform !== "win32")
      await fs.symlink(path.join(root, "backups"), path.join(dir, "external"));
    let result = await storage.get(s);
    assert.equal(result.serverBytes, 100);
    assert.equal(result.backupBytes, 40);
    assert.equal(result.worlds[0].bytes, 100);
    await fs.writeFile(path.join(dir, "new"), Buffer.alloc(20));
    assert.equal((await storage.get(s)).serverBytes, 100);
    storage.invalidate(s.id);
    result = await storage.get(s);
    assert.equal(result.serverBytes, 120);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed stop leaves data intact and interrupted delete resumes safely", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-delete-job-"));
  const store = new Store(root);
  const s = fixture();
  store.save(s);
  const engine = new Engine(root, root);
  engine.container = async () => null;
  engine.stop = async () => {
    throw new Error("Stop failed");
  };
  let jobs = new Jobs(store, engine);
  jobs.close();
  try {
    await fs.mkdir(engine.dir(s), { recursive: true });
    await fs.writeFile(path.join(engine.dir(s), "marker"), "keep");
    const job = store.newJob(s.id, "delete", { server: s });
    jobs.closed = false;
    await jobs.tick();
    jobs.close();
    assert.equal(store.job(job.id).status, "failed");
    assert.equal(
      await fs.readFile(path.join(engine.dir(s), "marker"), "utf8"),
      "keep",
    );
    engine.stop = async () => {};
    job.status = "running";
    store.saveJob(job);
    jobs = new Jobs(store, engine);
    jobs.close();
    assert.equal(store.job(job.id).status, "queued");
    jobs.closed = false;
    await jobs.tick();
    jobs.close();
    assert.equal(store.job(job.id).status, "done");
    assert.throws(() => store.server(s.id));
    assert.equal(workspaceSettings(store).defaultMemory, 2);
  } finally {
    jobs.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
