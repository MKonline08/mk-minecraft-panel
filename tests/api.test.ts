import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { createApp } from "../server/app.js";
import { defaults } from "../server/core.js";
import { Engine } from "../server/docker.js";
process.env.NODE_ENV = "test";
test("API authentication, origin protection, settings, image processing and file boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-api-"));
  const engine = new Engine(root, root);
  engine.state = async () => ({
    status: "stopped",
    memory: 0,
    cpu: 0,
    players: null,
  });
  const { app, store } = await createApp({ root, engine, scheduling: false });
  await app.ready();
  try {
    assert.equal((await app.inject("/api/servers")).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/setup",
          payload: {},
        })
      ).statusCode,
      403,
    );
    const account = { username: "tester", password: "correct-horse-panel-123" };
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "x-mk-request": "1" },
      payload: account,
    });
    assert.equal(setup.statusCode, 200, setup.body);
    const cookie = setup.cookies.map((c) => c.name + "=" + c.value).join("; ");
    const headers = { cookie, "x-mk-request": "1" };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/setup",
          headers,
          payload: account,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { "x-mk-request": "1" },
          payload: { ...account, password: "wrong-password-123" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/logout",
          headers: { ...headers, origin: "https://evil.example" },
        })
      ).statusCode,
      403,
    );
    const s = {
      id: "test-server",
      name: "Test",
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
    };
    store.save(s);
    await engine.configure(s);
    let r = await app.inject({ url: "/api/servers", headers });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json()[0].memory, 0);
    assert.equal(r.json()[0].memoryLimit, 1);
    r = await app.inject({
      method: "PUT",
      url: "/api/servers/test-server/settings",
      headers,
      payload: { ...defaults, difficulty: "hard" },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(store.server(s.id).settings.difficulty, "hard");
    await fs.writeFile(
      path.join(engine.dir(s), "world-marker.txt"),
      "keep this world",
    );
    let removedContainer = false;
    engine.container = async () =>
      ({
        inspect: async () => ({ State: { Running: false } }),
        remove: async () => {
          removedContainer = true;
        },
      }) as any;
    r = await app.inject({
      method: "PUT",
      url: "/api/servers/test-server/settings",
      headers,
      payload: { ...defaults, difficulty: "hard", memory: 2 },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(removedContainer, true);
    assert.equal(store.server(s.id).memory, 2);
    assert.equal(
      await fs.readFile(path.join(engine.dir(s), "world-marker.txt"), "utf8"),
      "keep this world",
    );
    r = await app.inject({
      url:
        "/api/servers/test-server/file?path=" +
        encodeURIComponent("../panel.sqlite"),
      headers,
    });
    assert.equal(r.statusCode, 400);
    r = await app.inject({
      url: "/api/servers/test-server/file?path=server.properties",
      headers,
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().readOnly, false);
    assert.match(r.json().text, /rcon.password=[0-9a-f]+/);
    r = await app.inject({
      method: "PUT",
      url: "/api/servers/test-server/appearance",
      headers,
      payload: { name: "MK", motd: "one\ntwo\nthree" },
    });
    assert.equal(r.statusCode, 400);
    const image = await sharp({
      create: { width: 300, height: 100, channels: 3, background: "#7340ff" },
    })
      .png()
      .toBuffer();
    const boundary = "test-boundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    r = await app.inject({
      method: "POST",
      url: "/api/servers/test-server/image/icon",
      headers: {
        ...headers,
        "content-type": "multipart/form-data; boundary=" + boundary,
      },
      payload: body,
    });
    assert.equal(r.statusCode, 200, r.body);
    const meta = await sharp(
      path.join(root, "images", s.id, "icon.png"),
    ).metadata();
    assert.equal(meta.width, 64);
    assert.equal(meta.height, 64);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers });
    assert.equal(
      (await app.inject({ url: "/api/servers", headers })).statusCode,
      401,
    );
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
