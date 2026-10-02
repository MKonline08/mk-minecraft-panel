import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { createApp } from "../server/app.js";
import { defaults, type Server, readProperties } from "../server/core.js";
import { Engine } from "../server/docker.js";
import { replaceFile } from "../server/files.js";
process.env.NODE_ENV = "test";

test("file manager edits every text extension, streams binary uploads, preserves properties, locks jobs and isolates servers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-files-"));
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
  await app.ready();
  try {
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "x-mk-request": "1" },
      payload: { username: "files", password: "file-test-password-123" },
    });
    const headers = {
      cookie: setup.cookies.map((c) => c.name + "=" + c.value).join("; "),
      "x-mk-request": "1",
    };
    const s: Server = {
      id: "files-server",
      name: "Files",
      type: "VANILLA",
      version: "1.21.1",
      java: 21,
      memory: 1,
      port: 25565,
      motd: "Welcome",
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
    const base = "/api/servers/" + s.id;
    const get = (url: string) => app.inject({ url: base + url, headers });
    const put = (relative: string, text: string, overwrite = true) =>
      app.inject({
        method: "PUT",
        url: base + "/file",
        headers,
        payload: { path: relative, text, overwrite },
      });
    const initial = (await get("/file?path=server.properties")).json().text;
    assert.equal(
      (
        await put(
          "server.properties",
          initial
            .replace("online-mode=true", "online-mode=false")
            .replace("max-players=20", "max-players=42"),
        )
      ).statusCode,
      200,
    );
    assert.equal(store.server(s.id).settings.maxPlayers, 42);
    await engine.configure(store.server(s.id));
    assert.match(
      (await get("/file?path=server.properties")).json().text,
      /online-mode=false/,
    );
    const settings = await app.inject({
      method: "PUT",
      url: base + "/settings",
      headers,
      payload: { ...store.server(s.id).settings, difficulty: "hard" },
    });
    assert.equal(settings.statusCode, 200, settings.body);
    const saved = readProperties(
      (await get("/file?path=server.properties")).json().text,
    );
    assert.equal(saved["online-mode"], "false");
    assert.equal(saved["max-players"], "42");
    assert.equal(saved.difficulty, "hard");
    for (const name of [
      ".hidden",
      "NO_EXTENSION",
      "config/nested/custom.xyz",
      "eula.txt",
    ]) {
      assert.equal((await put(name, "custom=value\n")).statusCode, 200, name);
      assert.equal(
        (await get("/file?path=" + encodeURIComponent(name))).json().text,
        "custom=value\n",
      );
    }
    assert.ok(
      (await get("/files")).json().some((f: any) => f.name === ".hidden"),
    );
    const beforeSize = (await get("/storage")).json().serverBytes;
    async function upload(
      name: string,
      bytes: Buffer,
      overwrite = false,
      folder = "",
    ) {
      const boundary = "mk-file-boundary";
      return app.inject({
        method: "POST",
        url:
          base +
          "/files/upload?path=" +
          encodeURIComponent(folder) +
          "&overwrite=" +
          overwrite,
        headers: {
          ...headers,
          "content-type": "multipart/form-data; boundary=" + boundary,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          ),
          bytes,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    }
    const binary = Buffer.from([0, 255, 3, 17, 0]);
    assert.equal((await upload("plugin.jar", binary)).statusCode, 200);
    assert.deepEqual(
      (await get("/file/download?path=plugin.jar")).rawPayload,
      binary,
    );
    assert.equal((await get("/file?path=plugin.jar")).json().readOnly, true);
    assert.ok((await get("/storage")).json().serverBytes > beforeSize);
    assert.equal(
      (await upload("plugin.jar", Buffer.from("replace"))).statusCode,
      409,
    );
    assert.deepEqual(
      (await get("/file/download?path=plugin.jar")).rawPayload,
      binary,
    );
    assert.equal(
      (await upload("plugin.jar", Buffer.from("replace"), true)).statusCode,
      200,
    );
    assert.equal((await get("/file?path=plugin.jar")).json().text, "replace");
    assert.equal((await put("plugin.jar", "no", false)).statusCode, 409);
    for (const relative of [
      "../other/marker",
      "../../panel.sqlite",
      "/outside",
      "C:/outside",
      "a\\b",
    ]) {
      assert.equal((await put(relative, "escape")).statusCode, 400, relative);
      assert.equal(
        (await upload("test.txt", binary, false, relative)).statusCode,
        400,
        relative,
      );
    }
    jobs.fileMutations.add(s.id);
    assert.equal((await put("x.txt", "busy")).statusCode, 400);
    assert.throws(() => jobs.enqueue(s.id, "start"), /file operation/);
    jobs.fileMutations.delete(s.id);
    store.newJob(s.id, "backup", {});
    assert.equal((await put("x.txt", "busy")).statusCode, 400);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("interrupted upload preserves original bytes and removes temporary files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-upload-"));
  try {
    await fs.writeFile(path.join(root, "world.dat"), "original");
    const broken = Readable.from(
      (async function* () {
        yield Buffer.from("partial");
        throw new Error("connection lost");
      })(),
    );
    await assert.rejects(
      replaceFile(root, "world.dat", broken, true),
      /connection lost/,
    );
    assert.equal(
      await fs.readFile(path.join(root, "world.dat"), "utf8"),
      "original",
    );
    assert.deepEqual(await fs.readdir(root), ["world.dat"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("property parsing handles escapes, continued lines, comments and duplicates", () => {
  const p = readProperties(
    "# header\nmax-players: 5\nmax-players = 42\nmotd=Hello\\u0020world\\nAgain\nfoo=one\\\n  two\nonline-mode false\n",
  );
  assert.equal(p["max-players"], "42");
  assert.equal(p.motd, "Hello world\nAgain");
  assert.equal(p.foo, "onetwo");
  assert.equal(p["online-mode"], "false");
});
