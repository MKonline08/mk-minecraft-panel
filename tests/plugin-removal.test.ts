import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import { Engine } from "../server/docker.js";
import { defaults, type Server } from "../server/core.js";
process.env.NODE_ENV = "test";

test("plugin removal is authenticated, stopped, locked, path restricted and preserves data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-remove-"));
  const engine = new Engine(root, root);
  let status = "stopped";
  engine.state = async () => ({ status, memory: 0, cpu: 0, players: null });
  const { app, store, jobs } = await createApp({
    root,
    engine,
    scheduling: false,
  });
  await app.ready();
  try {
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "x-mk-request": "1" },
      payload: { username: "admin", password: "remove-test-password-123" },
    });
    const headers = {
      cookie: setup.cookies.map((c) => c.name + "=" + c.value).join("; "),
      "x-mk-request": "1",
    };
    const s: Server = {
      id: "remove-server",
      name: "Remove",
      type: "PAPER",
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
    };
    store.save(s);
    await engine.configure(s);
    const dir = path.join(engine.dir(s), "plugins");
    await fs.mkdir(path.join(dir, "AuthMe"), { recursive: true });
    for (const name of [
      "AuthMe.jar",
      "Other.jar",
      "Disabled.jar.disabled",
      "AuthMe/config.yml",
    ])
      await fs.writeFile(path.join(dir, name), "preserve");
    await fs.writeFile(path.join(engine.dir(s), "outside.jar"), "outside");
    const url = (name: string) =>
      `/api/servers/${s.id}/mods?name=${encodeURIComponent(name)}`;
    const remove = (name: string) =>
      app.inject({ method: "DELETE", url: url(name), headers });
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: url("AuthMe.jar"),
          headers: { "x-mk-request": "1" },
        })
      ).statusCode,
      401,
    );
    status = "running";
    assert.notEqual((await remove("AuthMe.jar")).statusCode, 200);
    status = "stopped";
    jobs.fileMutations.add(s.id);
    assert.notEqual((await remove("AuthMe.jar")).statusCode, 200);
    jobs.fileMutations.delete(s.id);
    for (const name of [
      "../outside.jar",
      "AuthMe/config.yml",
      "server.properties",
      "/outside.jar",
    ])
      assert.notEqual((await remove(name)).statusCode, 200);
    await fs.mkdir(path.join(dir, "directory.jar"));
    assert.notEqual((await remove("directory.jar")).statusCode, 200);
    if (process.platform !== "win32") {
      await fs.symlink(
        path.join(engine.dir(s), "outside.jar"),
        path.join(dir, "link.jar"),
      );
      assert.notEqual((await remove("link.jar")).statusCode, 200);
    }
    assert.equal((await remove("AuthMe.jar")).statusCode, 200);
    assert.equal((await remove("Disabled.jar.disabled")).statusCode, 200);
    await assert.rejects(fs.access(path.join(dir, "AuthMe.jar")));
    assert.equal(
      await fs.readFile(path.join(dir, "AuthMe/config.yml"), "utf8"),
      "preserve",
    );
    assert.equal(
      await fs.readFile(path.join(dir, "Other.jar"), "utf8"),
      "preserve",
    );
    assert.equal(
      await fs.readFile(path.join(engine.dir(s), "outside.jar"), "utf8"),
      "outside",
    );
    assert.equal(jobs.fileMutations.has(s.id), false);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
