import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { defaults } from "../server/core.js";
import { Engine } from "../server/docker.js";
process.env.NODE_ENV = "test";

test("delete requires login and exact name, stops running server and removes only its owned data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-delete-"));
  const engine = new Engine(root, root);
  let status = "running";
  let removed = 0;
  engine.state = async () => ({ status, memory: 0, cpu: 0, players: null });
  engine.container = async () =>
    ({
      inspect: async () => ({ State: { Running: status === "running" } }),
      remove: async () => {
        removed++;
      },
    }) as any;
  engine.stop = async () => {
    status = "stopped";
  };
  const { app, store, jobs } = await createApp({
    root,
    engine,
    scheduling: false,
  });
  try {
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "x-mk-request": "1" },
      payload: { username: "tester", password: "correct-horse-panel-123" },
    });
    const cookie = setup.cookies.map((c) => c.name + "=" + c.value).join("; ");
    const headers = { cookie, "x-mk-request": "1" };
    const id = randomUUID();
    const otherId = randomUUID();
    const make = (id: string, name: string) => ({
      id,
      name,
      type: "VANILLA" as const,
      version: "1.21.1",
      java: 21,
      memory: 1,
      port: 25565,
      motd: "Hello",
      seed: "",
      created: new Date().toISOString(),
      settings: defaults,
      banner: false,
      icon: false,
      backupHours: 0,
      retention: 5,
      lastBackup: null,
      image: "test",
    });
    store.save(make(id, "Delete me"));
    store.save(make(otherId, "Keep me"));
    for (const folder of ["servers", "backups", "images"]) {
      await fs.mkdir(path.join(root, folder, id), { recursive: true });
      await fs.writeFile(path.join(root, folder, id, "marker"), "delete");
      await fs.mkdir(path.join(root, folder, otherId), { recursive: true });
      await fs.writeFile(path.join(root, folder, otherId, "marker"), "keep");
    }
    const request = (name: string, h = headers) =>
      app.inject({
        method: "DELETE",
        url: "/api/servers/" + id,
        headers: h,
        payload: { name },
      });
    assert.equal(
      (await request("Delete me", { "x-mk-request": "1" } as any)).statusCode,
      401,
    );
    assert.equal((await request("wrong")).statusCode, 400);
    assert.equal(removed, 0);
    const pending = store.newJob(id, "backup");
    assert.equal((await request("Delete me")).statusCode, 400);
    pending.status = "done";
    store.saveJob(pending);
    if (process.platform !== "win32") {
      const backupDir = path.join(root, "backups", id);
      await fs.rm(backupDir, { recursive: true });
      await fs.symlink(path.join(root, "backups", otherId), backupDir);
      assert.equal((await request("Delete me")).statusCode, 400);
      assert.equal(removed, 0);
      await fs.rm(backupDir);
      await fs.mkdir(backupDir);
      await fs.writeFile(path.join(backupDir, "marker"), "delete");
    }
    const result = await request("Delete me");
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().status, "queued");
    jobs.closed = false;
    await jobs.tick();
    jobs.close();
    assert.equal(store.job(result.json().id).status, "done");
    assert.equal(status, "stopped");
    assert.equal(removed, 1);
    assert.equal(
      (await app.inject({ url: "/api/servers/" + id, headers })).statusCode,
      404,
    );
    assert.equal(store.jobs().filter((j) => j.serverId === id).length, 1);
    assert.equal(store.server(otherId).name, "Keep me");
    for (const folder of ["servers", "backups", "images"]) {
      await assert.rejects(fs.stat(path.join(root, folder, id)), {
        code: "ENOENT",
      });
      assert.equal(
        await fs.readFile(path.join(root, folder, otherId, "marker"), "utf8"),
        "keep",
      );
    }
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
