import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { Engine } from "./docker.js";
import type { Job, Server } from "./core.js";
import { noSymlinks, safeName } from "./core.js";
import { extractZip, worldRoot, zipFolder } from "./archives.js";
import { resolveMods, installMods } from "./mods.js";
export class Jobs {
  active = false;
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
        if (
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
    while (this.active) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  enqueue(id: string, kind: string, payload: Record<string, unknown> = {}) {
    if (this.fileMutations.has(id))
      throw new Error("Wait for the file operation to finish");
    if (this.deleting.has(id)) throw new Error("This server is being deleted");
    if (this.store.activeJob(id))
      throw new Error("This server already has an operation in progress");
    const j = this.store.newJob(id, kind, payload);
    void this.tick();
    return j;
  }
  async tick() {
    if (this.active || this.closed) return;
    const j = this.store.unfinishedJobs().find((j) => j.status === "queued");
    if (!j) return;
    this.active = true;
    const progress = (m: string) => {
      j.message = m;
      this.store.saveJob(j);
    };
    try {
      j.status = "running";
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
                  path.join(this.store.root, "backups", s.id, names[0]),
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
          await this.backup(s, progress, true);
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
      progress(e.message || "Operation failed");
    } finally {
      this.onChange(j.serverId);
      this.active = false;
      if (!this.closed) void this.tick();
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
  async backup(s: Server, progress: (s: string) => void, restart: boolean) {
    const state = await this.engine.state(s);
    const running = ["running", "starting", "needs attention"].includes(
      state.status,
    );
    progress("Stopping Minecraft for a consistent backup");
    await this.engine.stop(s);
    const folder = path.join(this.store.root, "backups", s.id);
    await fs.mkdir(folder, { recursive: true });
    const name =
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      randomUUID().slice(0, 8) +
      ".zip";
    progress("Creating backup");
    await fs.writeFile(
      path.join(this.engine.dir(s), ".mk-settings.json"),
      JSON.stringify({ settings: s.settings, motd: s.motd, seed: s.seed }),
    );
    await zipFolder(this.engine.dir(s), path.join(folder, name));
    const current = this.store.server(s.id);
    current.lastBackup = new Date().toISOString();
    this.store.save(current);
    const files = (await fs.readdir(folder))
      .filter((n) => n.endsWith(".zip"))
      .sort()
      .reverse();
    for (const n of files.slice(s.retention)) await fs.rm(path.join(folder, n));
    if (restart && running) {
      progress("Restarting after backup");
      await this.engine.start(s, progress);
      await this.engine.ready(s, progress);
    }
    return name;
  }
  async replace(
    s: Server,
    file: string,
    world: boolean,
    progress: (s: string) => void,
  ) {
    const staging = path.join(this.store.root, "staging", randomUUID());
    await fs.mkdir(staging, { recursive: true });
    try {
      progress("Validating archive");
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
      const dir = this.engine.dir(s);
      const journal = path.join(
        this.store.root,
        "staging",
        s.id + "-previous-" + randomUUID(),
      );
      if (world) {
        progress("Installing world");
        await fs.mkdir(journal);
        try {
          for (const name of ["world", "world_nether", "world_the_end"]) {
            await fs
              .rename(path.join(dir, name), path.join(journal, name))
              .catch((e: any) => {
                if (e.code !== "ENOENT") throw e;
              });
          }
          await fs.rename(source, path.join(dir, "world"));
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
              .readFile(path.join(dir, ".mk-settings.json"), "utf8")
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
    if (this.closed) return;
    try {
      for (const s of this.store.servers())
        if (
          !this.deleting.has(s.id) &&
          !this.fileMutations.has(s.id) &&
          s.backupHours &&
          Date.now() - Date.parse(s.lastBackup || s.created) >
            s.backupHours * 3600000 &&
          !this.store
            .jobs()
            .some(
              (j) =>
                j.serverId === s.id && ["running", "queued"].includes(j.status),
            )
        ) {
          const last = this.store
            .jobs()
            .find((j) => j.serverId === s.id && j.kind === "backup");
          if (!last || Date.now() - Date.parse(last.updated) > 3600000)
            this.enqueue(s.id, "backup");
        }
    } catch (e) {
      console.error("Backup scheduler:", e);
    }
  }
}
