import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, scryptSync } from "node:crypto";
import { Store } from "../server/store.js";
import { Engine } from "../server/docker.js";
import { Jobs } from "../server/jobs.js";
import { defaults, noSymlinks, type Server } from "../server/core.js";
import {
  nextCalendar,
  announcements,
  renderAnnouncement,
} from "../server/backup-settings.js";
import { zipFolder, verifyZip } from "../server/archives.js";
import { backupList } from "../server/workspace.js";
import { logPage, cursorSince } from "../server/console.js";
import { createApp } from "../server/app.js";
process.env.NODE_ENV = "test";

const server = (): Server => ({
  id: randomUUID(),
  name: "Survival",
  type: "VANILLA",
  version: "1.21.1",
  java: 21,
  memory: 1,
  port: 25565,
  motd: "Existing MOTD",
  seed: "existing-seed",
  created: new Date().toISOString(),
  settings: { ...defaults },
  banner: false,
  icon: false,
  backupHours: 24,
  retention: 5,
  lastBackup: null,
  image: "pinned-image",
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-v13-"));
  const store = new Store(root),
    engine = new Engine(root, root),
    s = server();
  store.save(s);
  let running = true;
  const commands: string[] = [];
  let starts = 0;
  engine.state = async () => ({
    status: running ? "running" : "stopped",
    memory: 0,
    cpu: 0,
    players: null,
  });
  engine.stop = async () => {
    running = false;
  };
  engine.start = async () => {
    running = true;
    starts++;
  };
  engine.ready = async () => {};
  engine.command = async (_, command) => {
    commands.push(command);
    return "sent";
  };
  await engine.configure(s);
  await fs.mkdir(await engine.file(s, "world"));
  await fs.writeFile(await engine.file(s, "world/level.dat"), "existing-world");
  const jobs = new Jobs(store, engine);
  clearInterval(jobs.timer);
  return {
    root,
    store,
    engine,
    s,
    jobs,
    commands,
    get starts() {
      return starts;
    },
    setRunning(value: boolean) {
      running = value;
    },
    async close() {
      await jobs.drain();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("calendar schedules choose the first repeated minute and the next valid skipped minute", () => {
  const daily = {
    mode: "daily" as const,
    time: "02:30",
    timezone: "America/Chicago",
    weekday: 0,
  };
  assert.equal(
    new Date(
      nextCalendar(daily, Date.parse("2026-03-08T06:00:00Z"))!,
    ).toISOString(),
    "2026-03-08T08:00:00.000Z",
  );
  const repeated = { ...daily, time: "01:30" };
  assert.equal(
    new Date(
      nextCalendar(repeated, Date.parse("2026-11-01T04:00:00Z"))!,
    ).toISOString(),
    "2026-11-01T06:30:00.000Z",
  );
  assert.equal(
    new Date(
      nextCalendar(repeated, Date.parse("2026-11-01T06:40:00Z"))!,
    ).toISOString(),
    "2026-11-02T07:30:00.000Z",
  );
  assert.equal(
    new Date(
      nextCalendar(
        { ...daily, mode: "weekly", weekday: 1 },
        Date.parse("2026-03-08T06:00:00Z"),
      )!,
    ).toISOString(),
    "2026-03-09T07:30:00.000Z",
  );
  assert.equal(
    renderAnnouncement(
      "{server} in {remaining}, took {duration}",
      "Survival",
      300,
      12,
    ),
    "Survival in 5 minute(s), took 12 seconds",
  );
});

test("incremental console preserves identical lines and resets across container restarts", () => {
  const line = "2026-10-15T12:00:00.123456789Z same line\n";
  const first = logPage(line + line, "container:one", "start");
  assert.equal(first.lines.length, 2);
  assert.equal(
    logPage(line + line, "container:one", first.cursor).lines.length,
    0,
  );
  assert.equal(
    logPage(line + line + line, "container:one", first.cursor).lines.length,
    1,
  );
  const next = logPage(line, "container:two", first.cursor);
  assert.equal(next.reset, true);
  assert.equal(next.lines.length, 1);
  assert.equal(
    cursorSince(first.cursor),
    Date.parse("2026-10-15T12:00:00Z") / 1000 - 1,
  );
  assert.throws(() => logPage(line, "one", "bad"), /Invalid console cursor/);
});

test("countdowns send warnings once, survive reloads, cancel, and leave other servers operable", async (t) => {
  const f = await fixture();
  const now = 1800000000000;
  t.mock.method(Date, "now", () => now);
  try {
    const j = f.store.newJob(f.s.id, "backup", {
      dueAt: now + 300000,
      scheduled: true,
    });
    await f.jobs.countdown(j);
    await f.jobs.countdown(f.store.job(j.id));
    assert.equal(f.commands.length, 1);
    assert.match(f.commands[0], /5 minute/);
    let loaded = f.store.job(j.id);
    loaded.payload.dueAt = now + 60000;
    f.store.saveJob(loaded);
    await f.jobs.countdown(loaded);
    assert.equal(f.commands.length, 2);
    loaded = f.store.job(j.id);
    loaded.payload.dueAt = now + 10000;
    f.store.saveJob(loaded);
    await f.jobs.countdown(loaded);
    assert.equal(f.commands.length, 3);
    const other = { ...server(), port: 25566 };
    f.store.save(other);
    const operation = f.store.newJob(other.id, "stop");
    await f.jobs.tick();
    assert.equal(f.store.job(operation.id).status, "done");
    assert.equal(f.store.job(j.id).status, "queued");
    assert.throws(() => f.jobs.enqueue(f.s.id, "backup"), /already has/);
    f.jobs.cancelCountdown(f.s.id);
    assert.equal(f.store.job(j.id).stage, "cancelled");
  } finally {
    await f.close();
  }
});

test("offline scheduled backups wait until due; manual offline backups skip the warning", async () => {
  const f = await fixture();
  f.setRunning(false);
  try {
    const dueAt = Date.now() + 300000;
    const j = f.store.newJob(f.s.id, "backup", { scheduled: true, dueAt });
    await f.jobs.countdown(j);
    assert.equal(j.payload.dueAt, dueAt);
    assert.equal(f.commands.length, 0);
    f.jobs.cancelCountdown(f.s.id);
    const manual = f.store.newJob(f.s.id, "backup", { dueAt });
    await f.jobs.tick();
    assert.equal(f.store.job(manual.id).status, "done");
    assert.equal(f.starts, 0);
  } finally {
    await f.close();
  }
});

test("verified backups preserve the world and restart; bad CRCs are rejected", async () => {
  const f = await fixture();
  try {
    const j = f.store.newJob(f.s.id, "backup", {
      dueAt: Date.now(),
      prepared: true,
    });
    await f.jobs.tick();
    const saved = f.store.job(j.id);
    assert.equal(saved.status, "done");
    assert.equal(saved.verified, true);
    assert.equal(saved.wasRunning, true);
    assert.equal(f.starts, 1);
    assert.equal(
      (await backupList(f.root, f.s, f.store))[0].verification,
      "verified",
    );
    assert.equal(
      await fs.readFile(await f.engine.file(f.s, "world/level.dat"), "utf8"),
      "existing-world",
    );
    assert.equal(f.commands.filter((c) => c.includes("complete")).length, 1);
    const file = path.join(f.root, "backups", f.s.id, saved.archive!);
    const bytes = await fs.readFile(file),
      central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(
      (bytes.readUInt32LE(central + 16) ^ 123) >>> 0,
      central + 16,
    );
    await fs.writeFile(file, bytes);
    await assert.rejects(verifyZip(file), /verification failed/);
    assert.equal(
      (await backupList(f.root, f.s, f.store))[0].verification,
      "unknown",
    );
  } finally {
    await f.close();
  }
});

test("disk-full failure preserves old archives, recovers a running server and records both errors", async (t) => {
  const f = await fixture();
  try {
    const folder = path.join(f.root, "backups", f.s.id);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "old.zip"), "old backup");
    const original = fs.writeFile;
    t.mock.method(fs, "writeFile", async (...args: any[]) => {
      if (String(args[0]).endsWith(".mk-settings.json"))
        throw Object.assign(new Error("ENOSPC disk full"), { code: "ENOSPC" });
      return (original as any)(...args);
    });
    f.engine.start = async () => {
      throw new Error("Docker unavailable");
    };
    const j = f.store.newJob(f.s.id, "backup", {
      dueAt: Date.now(),
      prepared: true,
    });
    await f.jobs.tick();
    const saved = f.store.job(j.id);
    assert.equal(saved.status, "failed");
    assert.match(saved.error!, /ENOSPC/);
    assert.match(saved.error!, /Docker unavailable/);
    assert.match(saved.recovery!.error!, /Docker unavailable/);
    assert.equal(
      await fs.readFile(path.join(folder, "old.zip"), "utf8"),
      "old backup",
    );
    assert.deepEqual(
      (await fs.readdir(folder)).filter((n) => n.endsWith(".partial")),
      [],
    );
    assert.equal(f.store.server(f.s.id).lastBackup, null);
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test("interrupted backup recovers prior running state without replaying announcements", async () => {
  const f = await fixture();
  try {
    const j = f.store.newJob(f.s.id, "backup");
    j.status = "running";
    j.wasRunning = true;
    j.announcementEvents = [
      { key: "shutdown", at: new Date().toISOString(), status: "sent" },
    ];
    f.store.saveJob(j);
    f.setRunning(false);
    const folder = path.join(f.root, "backups", f.s.id);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "lost.zip.partial"), "partial");
    const resumed = new Jobs(f.store, f.engine);
    clearInterval(resumed.timer);
    await resumed.tick();
    await resumed.drain();
    assert.equal(f.store.job(j.id).status, "failed");
    assert.equal(f.starts, 1);
    assert.equal(
      f.commands.some((c) => c.includes("Saving")),
      false,
    );
    assert.deepEqual(await fs.readdir(folder), []);
  } finally {
    await f.close();
  }
});

test("announcement failures cannot prevent backup or restart", async () => {
  const f = await fixture();
  try {
    f.engine.command = async () => {
      throw new Error("RCON unavailable");
    };
    const j = f.store.newJob(f.s.id, "backup", {
      dueAt: Date.now(),
      prepared: true,
    });
    await f.jobs.tick();
    assert.equal(f.store.job(j.id).status, "done");
    assert.equal(f.starts, 1);
    assert.ok(
      f.store.job(j.id).announcementEvents?.every((e) => e.status === "failed"),
    );
  } finally {
    await f.close();
  }
});

test("v1.2.1 records, account, world and backup survive reopening and new APIs remain compatible", async () => {
  const f = await fixture();
  await f.jobs.drain();
  f.store.set("username", "upgrade-admin");
  f.store.set(
    "password",
    "old-salt:" +
      scryptSync("upgrade-password-123", "old-salt", 64).toString("hex"),
  );
  const playerId = randomUUID();
  f.store.observePlayer(f.s.id, "Alex", playerId, "2026-10-01T00:00:00Z");
  const oldBackup = path.join(f.root, "backups", f.s.id, "old-backup.zip");
  await zipFolder(f.engine.dir(f.s), oldBackup);
  const { app, store } = await createApp({
    root: f.root,
    engine: f.engine,
    scheduling: false,
  });
  try {
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-mk-request": "1" },
      payload: { username: "upgrade-admin", password: "upgrade-password-123" },
    });
    const headers = {
      cookie: setup.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      "x-mk-request": "1",
    };
    const savedPassword = store.get("password");
    assert.equal(setup.statusCode, 200);
    assert.equal(store.playerHistory(f.s.id)[0].uuid, playerId.toLowerCase());
    assert.equal(
      (await backupList(f.root, f.s, store))[0].name,
      "old-backup.zip",
    );
    const response = await app.inject({
      method: "PUT",
      url: `/api/servers/${f.s.id}/backups`,
      headers,
      payload: { backupHours: 12, retention: 4 },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().backupSchedule.mode, "interval");
    assert.equal(response.json().announcements.enabled, true);
    const calendar = await app.inject({
      method: "PUT",
      url: `/api/servers/${f.s.id}/backups`,
      headers,
      payload: {
        backupHours: 12,
        retention: 4,
        backupSchedule: {
          mode: "daily",
          time: "03:00",
          timezone: "America/Chicago",
        },
        announcements: announcements(f.s),
      },
    });
    assert.equal(calendar.statusCode, 200, calendar.body);
    assert.ok(calendar.json().nextBackupAt);
    const invalid = await app.inject({
      method: "PUT",
      url: `/api/servers/${f.s.id}/backups`,
      headers,
      payload: {
        backupHours: 12,
        retention: 4,
        backupSchedule: {
          mode: "daily",
          time: "03:00",
          timezone: "Invalid/Zone",
        },
      },
    });
    assert.equal(invalid.statusCode, 400);
    f.engine.logs = async () => "legacy output";
    assert.equal(
      (await app.inject({ url: `/api/servers/${f.s.id}/logs`, headers })).json()
        .text,
      "legacy output",
    );
    assert.equal(store.get("password"), savedPassword);
    assert.equal(store.server(f.s.id).image, "pinned-image");
    assert.equal(
      await fs.readFile(await f.engine.file(f.s, "world/level.dat"), "utf8"),
      "existing-world",
    );
  } finally {
    await app.close();
    await f.close();
  }
});

test("cancelled countdown cannot be revived by an in-flight server check", async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.engine.state = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ status: "running", memory: 0, cpu: 0, players: null });
      });
    const j = f.store.newJob(f.s.id, "backup", { dueAt: Date.now() + 10000 });
    const waiting = f.jobs.countdown(j);
    f.jobs.cancelCountdown(f.s.id);
    release();
    await waiting;
    assert.equal(f.store.job(j.id).stage, "cancelled");
    assert.equal(f.commands.length, 0);
  } finally {
    await f.close();
  }
});

test("deferred scheduled backups enqueue once after another operation finishes", async () => {
  const f = await fixture();
  try {
    f.s.created = "2020-01-01T00:00:00Z";
    f.s.announcements = { ...announcements(f.s), enabled: false };
    f.store.save(f.s);
    const blocker = f.store.newJob(f.s.id, "start");
    await f.jobs.schedule();
    assert.equal(f.store.unfinishedJobs().length, 1);
    blocker.status = "done";
    f.store.saveJob(blocker);
    // Keep the enqueued backup queued for inspection.
    const originalTick = f.jobs.tick.bind(f.jobs);
    f.jobs.tick = async () => {};
    await f.jobs.schedule();
    await f.jobs.schedule();
    assert.equal(
      f.store.unfinishedJobs().filter((j) => j.kind === "backup").length,
      1,
    );
    f.jobs.tick = originalTick;
    await f.jobs.tick();
    assert.equal(
      f.store.jobs().find((j) => j.kind === "backup")?.status,
      "done",
    );
  } finally {
    await f.close();
  }
});

test(
  "file symlinks cannot redirect config, RCON credentials, player reads or backup metadata",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture();
    const { app } = await createApp({
      root: f.root,
      engine: f.engine,
      scheduling: false,
    });
    try {
      const target = path.join(f.root, "private.txt");
      await fs.writeFile(target, "unchanged");
      for (const name of ["server.properties", ".mk-rcon-password"]) {
        const file = path.join(f.engine.dir(f.s), name);
        await fs.rm(file, { force: true });
        await fs.symlink(target, file);
        await assert.rejects(
          name === "server.properties"
            ? f.engine.configure(f.s)
            : f.engine.password(f.s),
          /Symbolic links/,
        );
        await fs.rm(file);
      }
      await f.engine.configure(f.s);
      await fs.symlink(
        target,
        path.join(f.engine.dir(f.s), ".mk-settings.json"),
      );
      await assert.rejects(
        f.jobs.backup(f.s, () => {}, true),
        /Symbolic links/,
      );
      assert.equal(f.starts, 1);
      assert.equal(await fs.readFile(target, "utf8"), "unchanged");
      await fs.symlink(target, path.join(f.engine.dir(f.s), "whitelist.json"));
      const setup = await app.inject({
        method: "POST",
        url: "/api/auth/setup",
        headers: { "x-mk-request": "1" },
        payload: {
          username: "symlink-admin",
          password: "symlink-password-123",
        },
      });
      const response = await app.inject({
        url: `/api/servers/${f.s.id}/players`,
        headers: {
          cookie: setup.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        },
      });
      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /Symbolic links/);
    } finally {
      await app.close();
      await f.close();
    }
  },
);

test("server-directory symlinks cannot redirect configuration, backup or nested file access", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.root, "outside");
    await fs.mkdir(target);
    const linked = { ...server() };
    await fs.symlink(
      target,
      f.engine.dir(linked),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(f.engine.configure(linked), /Symbolic links/);
    await assert.rejects(
      f.jobs.backup(linked, () => {}, true),
      /Symbolic links/,
    );
    await assert.rejects(
      noSymlinks(f.engine.dir(linked), "secret"),
      /Symbolic links/,
    );
    assert.deepEqual(await fs.readdir(target), []);
  } finally {
    await f.close();
  }
});
