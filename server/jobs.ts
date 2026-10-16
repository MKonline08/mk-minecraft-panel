import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { Engine } from "./docker.js";
import type { Job, Server } from "./core.js";
import { noSymlinks, safeName } from "./core.js";
import { extractZip, worldRoot, zipFolder, verifyZip } from "./archives.js";
import { resolveMods, installMods } from "./mods.js";
import {
  announcements,
  renderAnnouncement,
  nextBackup,
  nextCalendar,
} from "./backup-settings.js";
export class Jobs {
  active = false;
  preparing = false;
  scheduling = false;
  closed = false;
  deleting = new Set<string>();
  fileMutations = new Set<string>();
  onChange: (id: string) => void = () => {};
  beforeDelete: (id: string) => Promise<void> = async () => {};
  timer: NodeJS.Timeout;
  constructor(
    public store: Store,
    public engine: Engine,
  ) {
    for (const j of store.unfinishedJobs()) {
      if (j.status === "running") {
        if (j.kind === "backup") {
          j.status = "queued";
          j.payload.recover = true;
          j.message = "Recovering interrupted backup";
        } else if (
          ["start", "restart", "stop", "delete", "delete-backup"].includes(
            j.kind,
          )
        ) {
          j.status = "queued";
          j.message = "Resuming after panel restart";
        } else {
          j.status = "failed";
          j.message =
            "Panel restarted during this operation. Review files/backups before retrying; completed backups were preserved.";
        }
        store.saveJob(j);
      }
    }
    this.timer = setInterval(() => {
      void this.schedule();
      void this.tick();
    }, 5000);
    this.timer.unref();
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
  }
  async drain() {
    this.close();
    while (this.active || this.preparing || this.scheduling)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
  enqueue(id: string, kind: string, payload: Record<string, unknown> = {}) {
    if (this.fileMutations.has(id))
      throw new Error("Wait for the file operation to finish");
    if (this.deleting.has(id)) throw new Error("This server is being deleted");
    if (this.store.activeJob(id))
      throw new Error("This server already has an operation in progress");
    const j = this.store.newJob(id, kind, payload);
    if (kind === "backup") {
      const s = this.store.server(id);
      j.payload.dueAt ??= Date.now() + (announcements(s).enabled ? 10000 : 0);
      j.stage = "countdown";
      this.store.saveJob(j);
    }
    void this.tick();
    return j;
  }
  async tick() {
    if (this.closed || this.preparing) return;
    this.preparing = true;
    let j: Job | undefined;
    try {
      for (const candidate of this.store
        .unfinishedJobs()
        .filter((j) => j.status === "queued")) {
        if (candidate.kind === "backup" && !candidate.payload.recover) {
          await this.countdown(candidate);
          if (this.closed || this.store.job(candidate.id).status !== "queued")
            continue;
          if (Number(candidate.payload.dueAt) > Date.now()) continue;
        }
        j ??= candidate;
      }
    } catch (e) {
      console.error("Job preparation:", e);
    } finally {
      this.preparing = false;
    }
    if (
      !j ||
      this.active ||
      this.closed ||
      this.store.job(j.id).status !== "queued"
    )
      return;
    this.active = true;
    const job = j;
    const progress = (m: string) => {
      job.message = m;
      job.stage = m;
      this.store.saveJob(job);
    };
    try {
      j.status = "running";
      j.startedAt ??= new Date().toISOString();
      progress("Preparing operation");
      const s =
        j.kind === "delete"
          ? (j.payload.server as Server)
          : this.store.server(j.serverId);
      switch (j.kind) {
        case "delete":
          await this.removeServer(s, j.id, progress);
          break;
        case "delete-backup": {
          const name = safeName(String(j.payload.name));
          if (!name.endsWith(".zip")) throw new Error("Invalid backup");
          progress("Deleting backup");
          const file = await noSymlinks(
            this.store.root,
            `backups/${s.id}/${name}`,
          );
          await fs.rm(file, { force: true });
          this.store.delete(`backup-verified:${s.id}:${name}`);
          const names = (
            await fs
              .readdir(path.join(this.store.root, "backups", s.id))
              .catch(() => [])
          )
            .filter((n) => n.endsWith(".zip"))
            .sort()
            .reverse();
          const current = this.store.server(s.id);
          current.lastBackup = names.length
            ? (
                await fs.stat(
                  await noSymlinks(
                    this.store.root,
                    `backups/${s.id}/${names[0]}`,
                  ),
                )
              ).mtime.toISOString()
            : null;
          this.store.save(current);
          break;
        }
        case "start":
          await this.engine.start(s, progress);
          await this.engine.ready(s, progress);
          break;
        case "stop":
          await this.engine.stop(s);
          break;
        case "restart":
          await this.engine.stop(s);
          await this.engine.start(s, progress);
          await this.engine.ready(s, progress);
          break;
        case "backup":
          await this.backup(s, progress, true, j);
          break;
        case "world":
          await this.replace(s, String(j.payload.file), true, progress);
          break;
        case "restore":
          await this.replace(s, String(j.payload.file), false, progress);
          break;
        case "mods": {
          progress("Resolving compatible mods and dependencies");
          const items = await resolveMods(String(j.payload.project), s);
          await this.engine.stop(s);
          await this.backup(s, progress, false);
          progress("Downloading verified mod files");
          await installMods(items, this.engine.dir(s), s);
          break;
        }
        default:
          throw new Error("Unknown operation");
      }
      j.status = "done";
      progress(
        ["world", "restore", "mods"].includes(j.kind)
          ? "Complete. Review your files, then start the server."
          : "Complete",
      );
    } catch (e: any) {
      j.status = "failed";
      j.error = e.message || "Operation failed";
      progress(e.message || "Operation failed");
    } finally {
      j.finishedAt = new Date().toISOString();
      this.store.saveJob(j);
      if (j.kind === "backup") {
        const current = this.store.server(j.serverId);
        if (
          current.backupSchedule?.mode === "daily" ||
          current.backupSchedule?.mode === "weekly"
        ) {
          current.nextBackupAt = new Date(
            nextCalendar(current.backupSchedule, Date.now())!,
          ).toISOString();
          this.store.save(current);
        }
      }
      this.onChange(j.serverId);
      this.active = false;
      if (!this.closed) void this.tick();
    }
  }
  async announce(
    s: Server,
    j: Job,
    key: string,
    template: string,
    remaining = 0,
  ) {
    if (this.store.job(j.id).status !== j.status) return;
    const events = (j.announcementEvents ??= []);
    if (events.some((e) => e.key === key)) return;
    const event: NonNullable<Job["announcementEvents"]>[number] = {
      key,
      at: new Date().toISOString(),
      status: "attempted",
    };
    events.push(event);
    this.store.saveJob(j); // Persist before sending: a crash must not replay a broadcast.
    try {
      if (
        !announcements(s).enabled ||
        !["running", "starting", "needs attention"].includes(
          (await this.engine.state(s)).status,
        )
      ) {
        event.status = "skipped";
      } else {
        if (this.store.job(j.id).status !== j.status) return;
        await this.engine.command(
          s,
          "say " +
            renderAnnouncement(
              template,
              s.name,
              remaining,
              j.startedAt ? (Date.now() - Date.parse(j.startedAt)) / 1000 : 0,
            ),
        );
        event.status = "sent";
      }
    } catch (e: any) {
      event.status = "failed";
      event.error = e.message;
    }
    const latest = this.store.job(j.id);
    if (latest.status !== j.status) {
      latest.announcementEvents = events;
      this.store.saveJob(latest);
    } else this.store.saveJob(j);
  }
  async countdown(j: Job) {
    const s = this.store.server(j.serverId);
    if (!j.payload.prepared) {
      try {
        if (
          !j.payload.scheduled &&
          (!announcements(s).enabled ||
            !["running", "starting", "needs attention"].includes(
              (await this.engine.state(s)).status,
            ))
        )
          j.payload.dueAt = Date.now();
      } catch {
        if (!j.payload.scheduled) j.payload.dueAt = Date.now();
      }
      if (this.store.job(j.id).status !== "queued") return;
      j.payload.prepared = true;
      this.store.saveJob(j);
    }
    const remaining = Math.max(
      0,
      Math.ceil((Number(j.payload.dueAt) - Date.now()) / 1000),
    );
    j.message = `Backup in ${remaining} seconds. Players must reconnect after restart.`;
    j.stage = "countdown";
    this.store.saveJob(j);
    const settings = announcements(s);
    const warnings = j.payload.scheduled ? settings.warnings : [10];
    const eligible = [...new Set(warnings)]
      .sort((a, b) => a - b)
      .find((seconds) => remaining > 0 && remaining <= seconds);
    if (eligible !== undefined)
      await this.announce(
        s,
        j,
        `warning:${eligible}`,
        settings.warning,
        remaining,
      );
  }
  cancelCountdown(id: string) {
    for (const j of this.store
      .unfinishedJobs()
      .filter((j) => j.serverId === id && j.kind === "backup")) {
      if (j.status !== "queued" || j.payload.recover)
        throw new Error("Wait for the backup to finish");
      j.status = "failed";
      j.stage = "cancelled";
      j.message = "Backup countdown cancelled because settings changed";
      j.finishedAt = new Date().toISOString();
      this.store.saveJob(j);
    }
  }
  async removeServer(
    s: Server,
    jobId: string,
    progress: (message: string) => void,
  ) {
    if (!s || !/^[0-9a-f-]{36}$/i.test(s.id))
      throw new Error("Invalid server ID; files were not deleted");
    this.deleting.add(s.id);
    try {
      for (const folder of ["servers", "backups", "images"])
        await noSymlinks(this.store.root, `${folder}/${s.id}`);
      await this.beforeDelete(s.id);
      progress("Stopping server before deletion");
      await this.engine.stop(s);
      const container = await this.engine.container(s);
      if (container) {
        if ((await container.inspect()).State.Running)
          throw new Error("Server did not stop. No files were deleted.");
        await container.remove();
      }
      progress("Deleting server files and backups");
      for (const folder of ["servers", "backups", "images"]) {
        const target = await noSymlinks(this.store.root, `${folder}/${s.id}`);
        await fs.rm(target, { recursive: true, force: true });
      }
      this.store.removeServer(s.id, jobId);
    } finally {
      this.deleting.delete(s.id);
    }
  }
  async backup(
    s: Server,
    progress: (s: string) => void,
    restart: boolean,
    job?: Job,
  ) {
    const folder = await noSymlinks(this.store.root, `backups/${s.id}`);
    await fs.mkdir(folder, { recursive: true });
    const dir = await this.engine.file(s, "");
    let running = job?.wasRunning ?? false;
    let failure: Error | undefined;
    let name = job?.archive ?? "";
    try {
      if (job?.payload.recover) {
        for (const entry of await fs.readdir(folder, { withFileTypes: true }))
          if (entry.isFile() && entry.name.endsWith(".partial"))
            await fs.rm(await noSymlinks(folder, entry.name));
        if (!job.verified)
          throw new Error(
            "Panel restarted during backup; incomplete backup discarded",
          );
        progress("Verifying recovered backup");
        await verifyZip(await noSymlinks(folder, safeName(name)));
      } else {
        running = ["running", "starting", "needs attention"].includes(
          (await this.engine.state(s)).status,
        );
        if (job) {
          job.wasRunning = running;
          this.store.saveJob(job);
        }
        if (job)
          await this.announce(s, job, "shutdown", announcements(s).shutdown);
        progress("Stopping Minecraft for a consistent backup");
        await this.engine.stop(s);
        name =
          new Date().toISOString().replace(/[:.]/g, "-") +
          "-" +
          randomUUID().slice(0, 8) +
          ".zip";
        if (job) {
          job.archive = name;
          this.store.saveJob(job);
        }
        progress("Creating backup");
        await fs.writeFile(
          await this.engine.file(s, ".mk-settings.json"),
          JSON.stringify({ settings: s.settings, motd: s.motd, seed: s.seed }),
        );
        let savedAt = 0;
        await zipFolder(dir, await noSymlinks(folder, name), {
          stage: progress,
          progress: (bytes, total) => {
            if (!job) return;
            job.bytesProcessed = bytes;
            job.totalBytes = total;
            if (Date.now() - savedAt > 500 || bytes === total) {
              savedAt = Date.now();
              this.store.saveJob(job);
            }
          },
        });
        const stat = await fs.stat(await noSymlinks(folder, name));
        const size = stat.size;
        this.store.set(
          `backup-verified:${s.id}:${name}`,
          JSON.stringify({
            verifiedAt: new Date().toISOString(),
            size,
            mtime: stat.mtimeMs,
          }),
        );
        if (job) {
          job.verified = true;
          job.archiveSize = size;
          this.store.saveJob(job);
        }
        const current = this.store.server(s.id);
        current.lastBackup = new Date().toISOString();
        this.store.save(current);
        const files = (await fs.readdir(folder))
          .filter((n) => n.endsWith(".zip"))
          .sort()
          .reverse();
        for (const n of files.slice(s.retention)) {
          await fs.rm(await noSymlinks(folder, n));
          this.store.delete(`backup-verified:${s.id}:${n}`);
        }
      }
    } catch (e: any) {
      failure = e;
      if (job) {
        job.error = e.message;
        progress(`Backup failed: ${e.message}. Recovering server...`);
      }
    } finally {
      if ((restart || failure) && running) {
        if (job) {
          job.recovery = { attempted: true };
          this.store.saveJob(job);
        }
        try {
          progress("Restarting after backup");
          await this.engine.start(s, progress);
          await this.engine.ready(s, progress);
        } catch (e: any) {
          if (job) {
            job.recovery = { attempted: true, error: e.message };
            this.store.saveJob(job);
          }
          failure = new Error(
            [failure?.message, `Server restart failed: ${e.message}`]
              .filter(Boolean)
              .join("; "),
          );
        }
      }
    }
    if (job)
      await this.announce(
        s,
        job,
        failure ? "failure" : "complete",
        failure ? announcements(s).failure : announcements(s).complete,
      );
    if (
      job &&
      failure &&
      announcements(s).enabled &&
      job.announcementEvents?.find((e) => e.key === "failure")?.status !==
        "sent"
    )
      this.store.set(
        `backup-notice:${s.id}`,
        JSON.stringify({ jobId: job.id, retryAt: Date.now() + 30000 }),
      );
    if (!failure) this.store.delete(`backup-notice:${s.id}`);
    if (failure) throw failure;
    return name;
  }
  async replace(
    s: Server,
    file: string,
    world: boolean,
    progress: (s: string) => void,
  ) {
    const staging = await noSymlinks(
      this.store.root,
      `staging/${randomUUID()}`,
    );
    await fs.mkdir(staging, { recursive: true });
    try {
      progress("Validating archive");
      await verifyZip(file, () => {}, 8 * 1024 ** 3);
      await extractZip(file, staging);
      const source = world ? await worldRoot(staging) : staging;
      if (
        !world &&
        !(await fs
          .stat(path.join(source, "server.properties"))
          .then((s) => s.isFile())
          .catch(() => false))
      )
        throw new Error("This is not a full MK server backup");
      await this.backup(s, progress, false);
      const dir = await this.engine.file(s, "");
      const journal = await noSymlinks(
        this.store.root,
        `staging/${s.id}-previous-${randomUUID()}`,
      );
      if (world) {
        progress("Installing world");
        await fs.mkdir(journal);
        try {
          for (const name of ["world", "world_nether", "world_the_end"]) {
            await fs
              .rename(await this.engine.file(s, name), path.join(journal, name))
              .catch((e: any) => {
                if (e.code !== "ENOENT") throw e;
              });
          }
          await fs.rename(source, await this.engine.file(s, "world"));
        } catch (e) {
          for (const name of await fs.readdir(journal))
            await fs.rename(path.join(journal, name), path.join(dir, name));
          throw e;
        }
      } else {
        progress("Restoring server files");
        await fs.rename(dir, journal);
        try {
          await fs.rename(staging, dir);
          const saved = JSON.parse(
            await fs
              .readFile(await this.engine.file(s, ".mk-settings.json"), "utf8")
              .catch(() => "{}"),
          );
          const current = this.store.server(s.id);
          if (saved.settings) current.settings = saved.settings;
          if (typeof saved.motd === "string") current.motd = saved.motd;
          if (typeof saved.seed === "string") current.seed = saved.seed;
          this.store.save(current);
        } catch (e) {
          if (
            !(await fs
              .stat(dir)
              .then(() => true)
              .catch(() => false))
          )
            await fs.rename(journal, dir);
          throw e;
        }
      }
      await fs.rm(journal, { recursive: true, force: true });
      if (world) await fs.rm(file, { force: true });
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  async schedule() {
    if (this.closed || this.scheduling) return;
    this.scheduling = true;
    try {
      for (const s of this.store.servers()) {
        const notice = JSON.parse(
          this.store.get(`backup-notice:${s.id}`) || "null",
        );
        if (
          notice &&
          Date.now() >= notice.retryAt &&
          !this.store.activeJob(s.id)
        ) {
          try {
            if (
              announcements(s).enabled &&
              (await this.engine.state(s)).status === "running"
            ) {
              const j = this.store.job(notice.jobId);
              const key = `failure-recovered:${notice.retryAt}`;
              await this.announce(s, j, key, announcements(s).failure);
              if (
                j.announcementEvents?.find((e) => e.key === key)?.status ===
                "sent"
              )
                this.store.set(`backup-notice:${s.id}`, "null");
              else
                this.store.set(
                  `backup-notice:${s.id}`,
                  JSON.stringify({ ...notice, retryAt: Date.now() + 60000 }),
                );
            }
          } catch {
            /* A stopped/unreachable server can be retried on a later tick. */
          }
        }
        const due = nextBackup(s);
        if (due === null) continue;
        if (
          (s.backupSchedule?.mode === "daily" ||
            s.backupSchedule?.mode === "weekly") &&
          !s.nextBackupAt
        ) {
          s.nextBackupAt = new Date(due).toISOString();
          this.store.save(s);
        }
        const lead = announcements(s).enabled
          ? Math.max(0, ...announcements(s).warnings) * 1000
          : 0;
        if (
          Date.now() < due - lead ||
          this.deleting.has(s.id) ||
          this.fileMutations.has(s.id) ||
          this.store.activeJob(s.id)
        )
          continue;
        const last = this.store
          .jobs()
          .find(
            (j) =>
              j.serverId === s.id &&
              j.kind === "backup" &&
              j.status === "failed" &&
              j.stage !== "cancelled",
          );
        if (last && Date.now() - Date.parse(last.updated) < 3600000) continue;
        this.enqueue(s.id, "backup", { scheduled: true, dueAt: due });
      }
    } catch (e) {
      console.error("Backup scheduler:", e);
    } finally {
      this.scheduling = false;
    }
  }
}
