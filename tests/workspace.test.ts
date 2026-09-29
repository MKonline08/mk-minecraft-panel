import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { defaults, type Server } from "../server/core.js";
import { Engine } from "../server/docker.js";
process.env.NODE_ENV = "test";
test("workspace settings, credentials, content and individual backup deletion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-workspace-"));
  const engine = new Engine(root, root);
  engine.state = async () => ({
    status: "stopped",
    memory: 0,
    cpu: 0,
    players: null,
  });
  const { app, store, jobs } = await createApp({
    root,
    engine,
    scheduling: false,
  });
  try {
    const credentials = {
      username: "tester",
      password: "original-long-password",
    };
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "x-mk-request": "1" },
      payload: credentials,
    });
    const cookie = login.cookies.map((c) => c.name + "=" + c.value).join("; ");
    const headers = { cookie, "x-mk-request": "1" };
    const second = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-mk-request": "1" },
      payload: credentials,
    });
    const secondCookie = second.cookies
      .map((c) => c.name + "=" + c.value)
      .join("; ");
    assert.equal((await app.inject("/api/workspace/settings")).statusCode, 401);
    const settings = {
      name: "MK Friends",
      refreshSeconds: 15,
      defaultMemory: 3,
      defaultBackupHours: 24,
      defaultRetention: 7,
    };
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/workspace/settings",
          headers,
          payload: settings,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/api/workspace/settings", headers })).json()
        .name,
      "MK Friends",
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/workspace/settings",
          headers,
          payload: { ...settings, refreshSeconds: 1 },
        })
      ).statusCode,
      400,
    );
    const s: Server = {
      id: randomUUID(),
      name: "Keep world",
      type: "FABRIC",
      version: "1.21.1",
      java: 21,
      memory: 1,
      port: 25565,
      motd: "hello",
      seed: "",
      created: new Date().toISOString(),
      settings: defaults,
      banner: false,
      icon: false,
      backupHours: 0,
      retention: 5,
      lastBackup: null,
      image: "test",
    };
    store.save(s);
    await fs.mkdir(path.join(engine.dir(s), "world"), { recursive: true });
    await fs.writeFile(path.join(engine.dir(s), "world", "level.dat"), "world");
    const backup = path.join(root, "backups", s.id);
    await fs.mkdir(backup, { recursive: true });
    await fs.writeFile(path.join(backup, "one.zip"), "one");
    await fs.writeFile(path.join(backup, "two.zip"), "two");
    await fs.mkdir(path.join(engine.dir(s), "mods"));
    await fs.writeFile(
      path.join(engine.dir(s), "mods", "unknown.jar"),
      "invalid-jar",
    );
    for (const kind of ["worlds", "mods", "backups"]) {
      const result = await app.inject({
        url: `/api/workspace/content?kind=${kind}`,
        headers,
      });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().groups[0].serverName, s.name);
      assert.ok(result.json().groups[0].items.length);
    }
    assert.equal(store.server(s.id).memory, 1);
    assert.equal(store.server(s.id).backupHours, 0);
    const before = await app.inject({
      url: `/api/servers/${s.id}/storage`,
      headers,
    });
    assert.equal(before.json().backupBytes, 6);
    const pending = store.newJob(s.id, "restore", {
      file: path.join(backup, "one.zip"),
    });
    const del = () =>
      app.inject({
        method: "DELETE",
        url: `/api/servers/${s.id}/backup/one.zip`,
        headers,
      });
    assert.equal((await del()).statusCode, 400);
    pending.status = "done";
    store.saveJob(pending);
    const removal = await del();
    assert.equal(removal.statusCode, 200, removal.body);
    jobs.closed = false;
    await jobs.tick();
    jobs.close();
    assert.equal(store.job(removal.json().id).status, "done");
    assert.equal(
      await fs.readFile(path.join(backup, "two.zip"), "utf8"),
      "two",
    );
    assert.equal(
      await fs.readFile(path.join(engine.dir(s), "world", "level.dat"), "utf8"),
      "world",
    );
    assert.equal(
      (
        await app.inject({ url: `/api/servers/${s.id}/storage`, headers })
      ).json().backupBytes,
      3,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/account",
          headers,
          payload: { username: "newadmin", currentPassword: "wrong" },
        })
      ).statusCode,
      400,
    );
    const change = await app.inject({
      method: "PUT",
      url: "/api/account",
      headers,
      payload: {
        username: "newadmin",
        currentPassword: credentials.password,
        password: "replacement-password-long",
      },
    });
    assert.equal(change.statusCode, 200, change.body);
    assert.equal(
      (
        await app.inject({
          url: "/api/workspace/settings",
          headers: { cookie: secondCookie },
        })
      ).statusCode,
      401,
    );
    const nextCookie = change.cookies
      .map((c) => c.name + "=" + c.value)
      .join("; ");
    assert.equal(
      (
        await app.inject({
          url: "/api/workspace/settings",
          headers: { cookie: nextCookie },
        })
      ).json().username,
      "newadmin",
    );
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
