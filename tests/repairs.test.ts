import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import yazl from "yazl";
import { Store } from "../server/store.js";
import { Engine } from "../server/docker.js";
import { Jobs } from "../server/jobs.js";
import { defaults, type Server } from "../server/core.js";
import {
  diagnose,
  repair,
  rollbackRepair,
  identifyFailure,
  inventory,
} from "../server/repairs.js";
import { createApp } from "../server/app.js";
process.env.NODE_ENV = "test";
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-repair-")),
    store = new Store(root),
    engine = new Engine(root, root);
  const s: Server = {
    id: "repair-test",
    name: "Repair",
    type: "NEOFORGE",
    version: "1.21.1",
    loaderVersion: "21.1.249",
    java: 21,
    memory: 1,
    port: 25565,
    motd: "Test",
    seed: "",
    created: new Date().toISOString(),
    image: "test",
    settings: { ...defaults },
    banner: false,
    icon: false,
    backupHours: 0,
    retention: 5,
    lastBackup: null,
  };
  store.save(s);
  await engine.configure(s);
  await fs.mkdir(path.join(engine.dir(s), "mods"));
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from('[[mods]]\nmodId="particle_effects"\nversion="1.0.1"\n'),
    "META-INF/neoforge.mods.toml",
  );
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(Buffer.from(c));
  await fs.writeFile(
    path.join(engine.dir(s), "mods/particle.jar"),
    Buffer.concat(chunks),
  );
  await fs.mkdir(path.join(engine.dir(s), "logs"));
  await fs.writeFile(
    path.join(engine.dir(s), "logs/latest.log"),
    "[main/ERROR] Mod 'particle_effects' encountered an error in a deferred task:\nCannot get config value before config is loaded.\n[main/FATAL] Mod loading has failed",
  );
  engine.stop = async () => {};
  engine.state = async () => ({
    status: "stopped",
    cpu: 0,
    memory: 0,
    players: null,
  });
  engine.container = async () => null as any;
  engine.start = async () => {};
  engine.ready = async () => {};
  engine.command = async () => "0 players";
  engine.logs = async () => "test failure";
  const jobs = new Jobs(store, engine);
  jobs.close();
  return {
    root,
    store,
    engine,
    jobs,
    s,
    close: async () => {
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
test("diagnosis requires explicit blame and never guesses from ordinary warnings", () => {
  const rows = [
    { name: "particle.jar", hash: "hash", ids: ["particle_effects"] },
  ];
  assert.equal(
    identifyFailure("Mod 'particle_effects' encountered an error", rows).file
      ?.name,
    "particle.jar",
  );
  assert.equal(identifyFailure("WARN missing optional class", rows).file, null);
  assert.match(
    identifyFailure("java.lang.OutOfMemoryError", rows).explanation,
    /memory/,
  );
});

test("diagnosis proposes an exact compatible update without changing installed files", async (t) => {
  const f = await fixture();
  try {
    const rows = await inventory(path.join(f.engine.dir(f.s), "mods"));
    const updated = {
      id: "RepairUpdate",
      project_id: "RepairProject",
      version_number: "1.0.2",
      game_versions: [f.s.version],
      loaders: ["neoforge"],
      dependencies: [],
      files: [
        {
          primary: true,
          filename: "particle-1.0.2.jar",
          url: "https://cdn.modrinth.com/fixture.jar",
          hashes: { sha512: "a".repeat(128) },
        },
      ],
    };
    t.mock.method(globalThis, "fetch", async (url: any) => {
      const text = String(url);
      const data = text.endsWith("/version_files")
        ? {
            [rows[0].hash]: {
              id: "old",
              project_id: "RepairProject",
              dependencies: [],
            },
          }
        : text.includes("/update?") || text.endsWith("/version/RepairUpdate")
          ? updated
          : {
              id: "RepairProject",
              title: "Particle Effects",
              server_side: "required",
              client_side: "required",
            };
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    });
    const report = await diagnose(f.jobs, f.s),
      proposal = report.proposals.find((p) => p.kind === "update");
    assert.ok(proposal);
    assert.equal(proposal.files[0].old, "particle.jar");
    assert.equal(proposal.files[0].name, "particle-1.0.2.jar");
    assert.equal(proposal.clientRequired, true);
    assert.deepEqual(
      await inventory(path.join(f.engine.dir(f.s), "mods")),
      rows,
    );
  } finally {
    await f.close();
  }
});
test("confirmed disable creates a backup, verifies startup and can restore the original world and mods", async (t) => {
  const f = await fixture();
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("{}", { status: 404 }),
  );
  try {
    const report = await diagnose(f.jobs, f.s);
    assert.equal(report.proposals.length, 1);
    assert.equal(report.proposals[0].kind, "disable");
    assert.equal(
      (await inventory(path.join(f.engine.dir(f.s), "mods"))).length,
      1,
    );
    await repair(f.jobs, f.s, report.id, "disable", () => {});
    await fs.access(path.join(f.engine.dir(f.s), "mods/particle.jar.disabled"));
    assert.equal(
      JSON.parse(f.store.get("repair-result:" + f.s.id)!).status,
      "verified",
    );
    assert.ok(
      (await fs.readdir(path.join(f.root, "backups", f.s.id))).some((n) =>
        n.endsWith(".zip"),
      ),
    );
    await rollbackRepair(f.jobs, f.store.server(f.s.id), () => {});
    await fs.access(path.join(f.engine.dir(f.s), "mods/particle.jar"));
    assert.equal(f.store.get("repair-rollback:" + f.s.id), undefined);
  } finally {
    await f.close();
  }
});
test("stale plans and cross-server plans are rejected before backup or mod changes", async (t) => {
  const f = await fixture();
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("{}", { status: 404 }),
  );
  try {
    const report = await diagnose(f.jobs, f.s);
    await fs.writeFile(
      path.join(f.engine.dir(f.s), "mods/particle.jar"),
      "changed",
    );
    await assert.rejects(
      repair(f.jobs, f.s, report.id, "disable", () => {}),
      /changed/,
    );
    await assert.rejects(
      repair(f.jobs, { ...f.s, id: "another" }, report.id, "disable", () => {}),
      /does not match/,
    );
    await assert.rejects(fs.access(path.join(f.root, "backups", f.s.id)));
  } finally {
    await f.close();
  }
});
test("failed startup automatically restores complete pre-repair files and stops", async (t) => {
  const f = await fixture();
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("{}", { status: 404 }),
  );
  f.engine.ready = async () => {
    await fs.writeFile(
      path.join(f.engine.dir(f.s), "changed-by-startup"),
      "changed",
    );
    throw new Error("still broken");
  };
  try {
    const report = await diagnose(f.jobs, f.s);
    await assert.rejects(
      repair(f.jobs, f.s, report.id, "disable", () => {}),
      /original files restored/,
    );
    await fs.access(path.join(f.engine.dir(f.s), "mods/particle.jar"));
    await assert.rejects(
      fs.access(path.join(f.engine.dir(f.s), "changed-by-startup")),
    );
    assert.equal(
      JSON.parse(f.store.get("repair-result:" + f.s.id)!).status,
      "failed",
    );
  } finally {
    await f.close();
  }
});
test("restart recovery blocks startup until repair rollback completes", async (t) => {
  const f = await fixture();
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("{}", { status: 404 }),
  );
  try {
    const report = await diagnose(f.jobs, f.s);
    await repair(f.jobs, f.s, report.id, "disable", () => {});
    const key = "repair-rollback:" + f.s.id,
      journal = JSON.parse(f.store.get(key)!);
    journal.phase = "verifying";
    f.store.set(key, JSON.stringify(journal));
    const recovered = new Jobs(f.store, f.engine);
    recovered.close();
    assert.equal(f.store.server(f.s.id).recoveryRequired, true);
    await rollbackRepair(recovered, f.store.server(f.s.id), () => {});
    assert.equal(!!f.store.server(f.s.id).recoveryRequired, false);
  } finally {
    await f.close();
  }
});
test("repair endpoints require authentication and explicit confirmation; Stop interrupts readiness", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-repair-api-")),
    engine = new Engine(root, root);
  let stopped = false;
  engine.stop = async () => {
    stopped = true;
  };
  const { app, store, jobs } = await createApp({
    root,
    engine,
    scheduling: false,
  });
  try {
    assert.equal(
      (await app.inject({ url: "/api/servers/unknown/repairs" })).statusCode,
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
    const sample = await fixture();
    const s = sample.s;
    store.save(s);
    await sample.close();
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/servers/${s.id}/repairs/apply`,
          headers,
          payload: { diagnosisId: "test", proposalId: "disable" },
        })
      ).statusCode,
      400,
    );
    store.newJob(s.id, "start");
    engine.waitingReady.add(s.id);
    const stop = await app.inject({
      method: "POST",
      url: `/api/servers/${s.id}/actions`,
      headers,
      payload: { action: "stop" },
    });
    assert.equal(stop.statusCode, 200);
    assert.equal(stopped, true);
    assert.equal(engine.cancelledStartup.has(s.id), true);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
