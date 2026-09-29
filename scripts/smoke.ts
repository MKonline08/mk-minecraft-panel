import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Engine, IMAGE_RELEASE } from "../server/docker.js";
import { defaults, type Server, type ServerType } from "../server/core.js";
import { Store } from "../server/store.js";
import { Jobs } from "../server/jobs.js";
const root =
  process.env.SMOKE_ROOT ||
  (await fs.mkdtemp(path.join(os.tmpdir(), "mk-live-")));
const engine = new Engine(root, root);
const store = new Store(root);
const jobs = new Jobs(store, engine);
jobs.close();
const type = (process.env.SERVER_TYPE || "VANILLA") as ServerType;
const make = (name: string, port: number): Server => ({
  id: randomUUID(),
  name,
  type,
  version: "1.21.1",
  java: 21,
  memory: 1,
  port,
  motd: "§bMK live smoke test",
  seed: "123",
  created: new Date().toISOString(),
  settings: { ...defaults, viewDistance: 3 },
  banner: false,
  icon: false,
  backupHours: 0,
  retention: 3,
  lastBackup: null,
  image: `itzg/minecraft-server:${IMAGE_RELEASE}-java21`,
});
const server = make("Smoke", 25680);
const second = make("Concurrent", 25681);
const log = (m: string) => console.log(type, m);
try {
  await fs.mkdir(root, { recursive: true });
  store.save(server);
  store.save(second);
  await engine.start(server, log);
  await engine.ready(server, log);
  assert.equal((await engine.state(server)).status, "running");
  assert.match(await engine.command(server, "list"), /players|online/i);
  await assert.rejects(engine.ensurePort(server.port));
  await fs.writeFile(
    path.join(engine.dir(server), "mk-persistence.txt"),
    "keep-me",
  );
  await engine.stop(server);
  assert.equal((await engine.state(server)).memory, 0);
  await engine.start(server, log);
  await engine.ready(server, log);
  assert.equal(
    await fs.readFile(
      path.join(engine.dir(server), "mk-persistence.txt"),
      "utf8",
    ),
    "keep-me",
  );
  if (type === "VANILLA") {
    await engine.stop(server);
    await engine.reconfigureMemory(server, 2);
    server.memory = 2;
    store.save(server);
    await engine.start(server, log);
    await engine.ready(server, log);
    const inspected = await (await engine.container(server))!.inspect();
    assert.equal(inspected.HostConfig.Memory, 2 * 1024 ** 3 + 768 * 1024 ** 2);
    assert.ok(inspected.Config.Env?.includes("MEMORY=2G"));
    assert.equal(
      await fs.readFile(path.join(engine.dir(server), "mk-persistence.txt"), "utf8"),
      "keep-me",
    );
  }
  if (["VANILLA", "PAPER", "FABRIC"].includes(type)) {
    await engine.start(second, log);
    await engine.ready(second, log);
    assert.equal((await engine.state(server)).status, "running");
    assert.equal((await engine.state(second)).status, "running");
    await engine.stop(second);
    const backup = await jobs.backup(server, log, false);
    await fs.writeFile(
      path.join(engine.dir(server), "mk-persistence.txt"),
      "changed",
    );
    await jobs.replace(
      server,
      path.join(root, "backups", server.id, backup),
      false,
      log,
    );
    assert.equal(
      await fs.readFile(
        path.join(engine.dir(server), "mk-persistence.txt"),
        "utf8",
      ),
      "keep-me",
    );
    await engine.start(server, log);
    await engine.ready(server, log);
  }
  console.log(
    `PASS ${type}: real Minecraft readiness, command, port conflict, restart and persistence`,
  );
} catch (e) {
  console.error(await engine.logs(server).catch(() => ""));
  throw e;
} finally {
  for (const s of [server, second]) {
    await engine.stop(s).catch(() => {});
    const c = await engine.container(s).catch(() => null);
    if (c) await c.remove().catch(() => {});
  }
  store.close();
}
