import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import yazl from "yazl";
import {
  Imports,
  publicAddress,
  checkHashes,
  boundedWrite,
  findWorlds,
} from "../server/imports.js";
import { Trash } from "../server/trash.js";
import { Store } from "../server/store.js";
import { Engine } from "../server/docker.js";
import { Jobs } from "../server/jobs.js";
import { defaults, type Server } from "../server/core.js";
import { runImport, rollbackImport } from "../server/import-jobs.js";
import { createApp } from "../server/app.js";
process.env.NODE_ENV = "test";
async function archive(files: Record<string, string>) {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(files))
    zip.addBuffer(Buffer.from(content), name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function server(id = "sample"): Server {
  return {
    id,
    name: id,
    type: "VANILLA",
    version: "1.21.1",
    java: 21,
    image: "test",
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
  };
}

test("trash preserves nested files, rejects overwrite, root and metadata, and survives reopening", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-trash-"));
  try {
    const live = path.join(root, "servers", "a");
    await fs.mkdir(path.join(live, "config"), { recursive: true });
    await fs.writeFile(path.join(live, "config", "a.txt"), "saved");
    const trash = new Trash(root, "a", live);
    await assert.rejects(trash.remove([""]), /root/);
    await assert.rejects(trash.remove(["../outside"]), /escapes/);
    await fs.writeFile(path.join(live, ".mk-settings.json"), "{}");
    await assert.rejects(trash.remove([".mk-settings.json"]), /metadata/);
    await trash.remove(["config", "config/a.txt"]);
    const entries = await new Trash(root, "a", live).list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].bytes, 5);
    await fs.mkdir(path.join(live, "config"));
    await assert.rejects(trash.restore(entries[0].id), /already exists/);
    await fs.rmdir(path.join(live, "config"));
    await trash.restore(entries[0].id);
    assert.equal(
      await fs.readFile(path.join(live, "config/a.txt"), "utf8"),
      "saved",
    );
    await trash.remove(["config"]);
    await trash.empty();
    assert.equal((await trash.list()).length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("archive inspection recognizes worlds, wrapper backups, server packs, and filters Modrinth client files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-import-")),
    store = new Store(root),
    imports = new Imports(store);
  try {
    const world = await imports.inspect(
      "a",
      "world",
      Readable.from(
        await archive({
          "save/level.dat": "level",
          "save/region/r.0.0.mca": "region",
        }),
      ),
      "world.zip",
    );
    assert.deepEqual(world.worlds, [""]);
    const backup = await imports.inspect(
      "a",
      "backup",
      Readable.from(
        await archive({
          "server/server.properties": "level-name=custom",
          "server/custom/level.dat": "level",
        }),
      ),
      "backup.zip",
    );
    assert.equal(backup.source, "unpacked/server");
    assert.equal(backup.runtime, undefined);
    await assert.rejects(
      imports.inspect(
        "a",
        "backup",
        Readable.from(await archive({ "level.dat": "world" })),
        "world.zip",
      ),
      /Upload world/,
    );
    const hashes = {
      sha1: createHash("sha1").update("jar").digest("hex"),
      sha512: createHash("sha512").update("jar").digest("hex"),
    };
    const manifest = {
      formatVersion: 1,
      game: "minecraft",
      name: "Fixture",
      versionId: "1",
      dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.10" },
      files: [
        {
          path: "mods/server.jar",
          hashes,
          downloads: [],
          env: { server: "required" },
        },
        {
          path: "mods/client.jar",
          hashes,
          downloads: [],
          env: { server: "unsupported" },
        },
        {
          path: "mods/optional.jar",
          hashes,
          downloads: [],
          env: { server: "optional" },
        },
      ],
    };
    const pack = await imports.inspect(
      "a",
      "modpack",
      Readable.from(
        await archive({ "modrinth.index.json": JSON.stringify(manifest) }),
      ),
      "pack.mrpack",
    );
    assert.equal(pack.files.length, 2);
    assert.equal(pack.runtime?.loaderVersion, "0.16.10");
    assert.equal(pack.files[1].optional, true);
    await assert.rejects(
      imports.manual(pack, "mods/server.jar", Readable.from("wrong")),
      /checksum/,
    );
    await imports.manual(pack, "mods/server.jar", Readable.from("jar"));
    assert.throws(() => imports.get(pack.id, "b"), /another server/);
    manifest.files[0].path = "../escape.jar";
    await assert.rejects(
      imports.inspect(
        "a",
        "modpack",
        Readable.from(
          await archive({ "modrinth.index.json": JSON.stringify(manifest) }),
        ),
        "bad.mrpack",
      ),
      /escapes/,
    );
    assert.equal(
      (await findWorlds(path.join(await imports.dir(world.id), world.source)))
        .length,
      1,
    );
  } finally {
    store.db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("download checks and streamed limits reject invalid content", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.2.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
  ])
    assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress("1.1.1.1"), true);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-limit-"));
  try {
    await assert.rejects(
      boundedWrite(Readable.from("12345"), path.join(root, "limited"), 4),
      /limit/,
    );
    await assert.rejects(
      checkHashes(path.join(root, "limited"), {}),
      /checksum/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("all supported manifest loaders preserve exact versions, and ambiguous loaders fail", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-loaders-")),
    store = new Store(root),
    imports = new Imports(store);
  try {
    for (const [loader, version, type] of [
      ["fabric-loader", "0.16.10", "FABRIC"],
      ["quilt-loader", "0.29.2", "QUILT"],
      ["forge", "47.3.0", "FORGE"],
      ["neoforge", "21.1.80", "NEOFORGE"],
    ]) {
      const manifest = {
        formatVersion: 1,
        game: "minecraft",
        name: "Fixture",
        versionId: "1",
        dependencies: { minecraft: "1.21.1", [loader]: version },
        files: [],
      };
      const r = await imports.inspect(
        "a",
        "modpack",
        Readable.from(
          await archive({ "modrinth.index.json": JSON.stringify(manifest) }),
        ),
        "pack.mrpack",
      );
      assert.equal(r.runtime?.type, type);
      assert.equal(r.runtime?.loaderVersion, version);
    }
    await assert.rejects(
      imports.inspect(
        "a",
        "modpack",
        Readable.from(
          await archive({
            "modrinth.index.json": JSON.stringify({
              formatVersion: 1,
              game: "minecraft",
              files: [],
              dependencies: { minecraft: "1.21.1", forge: "1", neoforge: "2" },
            }),
          }),
        ),
        "bad.mrpack",
      ),
      /ambiguous/,
    );
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("interrupted import blocks startup and rolls back the journaled installation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-recovery-")),
    store = new Store(root),
    engine = new Engine(root, root),
    s = server();
  store.save(s);
  await engine.configure(s);
  const previous = `staging/${s.id}-previous-test`;
  await fs.mkdir(path.dirname(path.join(root, previous)), { recursive: true });
  await fs.rename(engine.dir(s), path.join(root, previous));
  await fs.mkdir(engine.dir(s));
  await fs.writeFile(path.join(engine.dir(s), "partial"), "incomplete");
  store.set(
    `rollback:${s.id}`,
    JSON.stringify({ previous, server: s, stage: "old-moved" }),
  );
  const jobs = new Jobs(store, engine);
  jobs.close();
  engine.stop = async () => {};
  engine.container = async () => null as any;
  try {
    assert.equal(store.server(s.id).recoveryRequired, true);
    await assert.rejects(
      engine.start(store.server(s.id), () => {}),
      /recovery/,
    );
    await rollbackImport(jobs, store.server(s.id), () => {});
    await fs.access(path.join(engine.dir(s), "server.properties"));
    assert.equal(store.server(s.id).recoveryRequired, undefined);
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("world import honors custom names, preserves dimensions, creates backup and supports rollback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-world-import-")),
    store = new Store(root),
    engine = new Engine(root, root),
    s = server();
  store.save(s);
  engine.state = async () => ({
    status: "stopped",
    memory: 0,
    cpu: 0,
    players: null,
  });
  engine.stop = async () => {};
  engine.container = async () => null as any;
  const jobs = new Jobs(store, engine);
  jobs.close();
  try {
    await engine.configure(s);
    await engine.configure(s, { "level-name": "custom" });
    await fs.mkdir(path.join(engine.dir(s), "custom"));
    await fs.writeFile(path.join(engine.dir(s), "custom/level.dat"), "old");
    await fs.mkdir(path.join(engine.dir(s), "custom_nether"));
    await fs.writeFile(
      path.join(engine.dir(s), "custom_nether/level.dat"),
      "old nether",
    );
    const imports = new Imports(store),
      record = await imports.inspect(
        s.id,
        "world",
        Readable.from(
          await archive({
            "world/level.dat": "new",
            "world_nether/region/r.0.0.mca": "nether",
          }),
        ),
        "world.zip",
      );
    const job = store.newJob(s.id, "import", {
      importId: record.id,
      world: "world",
    });
    await runImport(jobs, s, job, () => {});
    assert.equal(
      await fs.readFile(path.join(engine.dir(s), "custom/level.dat"), "utf8"),
      "new",
    );
    assert.equal(
      await fs.readFile(
        path.join(engine.dir(s), "custom_nether/region/r.0.0.mca"),
        "utf8",
      ),
      "nether",
    );
    assert.ok(
      (await fs.readdir(path.join(root, "backups", s.id))).some((n) =>
        n.endsWith(".zip"),
      ),
    );
    await rollbackImport(jobs, store.server(s.id), () => {});
    assert.equal(
      await fs.readFile(path.join(engine.dir(s), "custom/level.dat"), "utf8"),
      "old",
    );
    assert.equal(store.get(`rollback:${s.id}`), undefined);
  } finally {
    jobs.close();
    store.db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("trash routes require authentication, stopped state, and an idle server", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-trash-api-")),
    engine = new Engine(root, root);
  let status = "stopped";
  engine.state = async () => ({ status, memory: 0, cpu: 0, players: null });
  const { app, store, jobs } = await createApp({
    root,
    engine,
    scheduling: false,
  });
  const s = server();
  store.save(s);
  await engine.configure(s);
  try {
    assert.equal(
      (await app.inject({ url: `/api/servers/${s.id}/trash` })).statusCode,
      401,
    );
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "x-mk-request": "1" },
      payload: { username: "test", password: "long-test-password" },
    });
    const headers = {
      "x-mk-request": "1",
      cookie: setup.cookies.map((c) => c.name + "=" + c.value).join("; "),
    };
    const remove = () =>
      app.inject({
        method: "POST",
        url: `/api/servers/${s.id}/trash`,
        headers,
        payload: { paths: ["server.properties"] },
      });
    status = "running";
    assert.equal((await remove()).statusCode, 400);
    status = "stopped";
    jobs.fileMutations.add(s.id);
    assert.equal((await remove()).statusCode, 400);
    jobs.fileMutations.delete(s.id);
    assert.equal((await remove()).statusCode, 200);
    const entries = (
      await app.inject({ url: `/api/servers/${s.id}/trash`, headers })
    ).json();
    assert.equal(entries.length, 1);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
