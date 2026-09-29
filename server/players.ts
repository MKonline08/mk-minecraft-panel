import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import type { Store } from "./store.js";
import type { Engine } from "./docker.js";
import { noSymlinks, type Server } from "./core.js";

export function onlineNames(response: string): string[] {
  const text = response.replace(/§[0-9a-fk-or]/gi, "").trim();
  const m = /There are (\d+).*?players? online\s*:\s*(.*)/i.exec(text);
  if (!m) throw new Error("Online player response could not be read");
  const names = m[2]
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (
    names.length !== Number(m[1]) ||
    names.some((n) => !/^[A-Za-z0-9_]{1,16}$/.test(n))
  )
    throw new Error("Online player response was incomplete");
  return names;
}
export class PlayerTracker {
  timer?: NodeJS.Timeout;
  closed = false;
  inflight = new Map<string, Promise<any>>();
  snapshots = new Map<string, any>();
  recovered = new Map<string, number>();
  constructor(
    public store: Store,
    public engine: Engine,
    start = true,
  ) {
    if (start) {
      this.timer = setInterval(() => {
        void this.tick();
      }, 5000);
      this.timer.unref();
      void this.tick();
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.inflight.values());
  }
  async forget(id: string) {
    await this.inflight.get(id)?.catch(() => {});
    this.snapshots.delete(id);
    this.recovered.delete(id);
  }
  async tick() {
    if (this.closed) return;
    await Promise.allSettled(this.store.servers().map((s) => this.refresh(s)));
  }
  async get(s: Server) {
    if (this.store.activeJob(s.id))
      return {
        status: "unavailable",
        online: [],
        history: this.store.playerHistory(s.id),
        error: "Server operation in progress",
        updatedAt: null,
      };
    const cached = this.snapshots.get(s.id);
    if (!cached || Date.now() - cached.fetchedAt >= 5000) await this.refresh(s);
    return {
      status: "unavailable",
      online: [],
      error: "Server operation in progress",
      updatedAt: null,
      ...this.snapshots.get(s.id),
      history: this.store.playerHistory(s.id),
    };
  }
  async refresh(s: Server) {
    if (this.inflight.has(s.id)) return this.inflight.get(s.id);
    const task = this.collect(s).finally(() => this.inflight.delete(s.id));
    this.inflight.set(s.id, task);
    return task;
  }
  async collect(s: Server) {
    if (this.closed || this.store.activeJob(s.id)) return;
    const dir = await noSymlinks(this.store.root, `servers/${s.id}`);
    let cache: { name: string; uuid: string }[] = [];
    try {
      const file = await noSymlinks(dir, "usercache.json");
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      if (Array.isArray(parsed))
        cache = parsed.filter(
          (p) =>
            typeof p.name === "string" &&
            /^[A-Za-z0-9_]{1,16}$/.test(p.name) &&
            /^[0-9a-f-]{36}$/i.test(p.uuid),
        );
    } catch {}
    const findUuid = (name: string) =>
      cache.find((p) => p.name.toLowerCase() === name.toLowerCase())?.uuid ||
      null;
    let historyWarning: string | null = null;
    try {
      if (
        !this.recovered.has(s.id) ||
        Date.now() - this.recovered.get(s.id)! > 60000
      ) {
        const knownUuids = new Set(
          this.store.playerHistory(s.id).map((p) => p.uuid),
        );
        for (const world of ["world", "world_nether", "world_the_end"]) {
          const folder = await noSymlinks(dir, `${world}/playerdata`);
          const files = await fs
            .readdir(folder, { withFileTypes: true })
            .catch(() => []);
          for (const entry of files) {
            if (!entry.isFile() || !/^[0-9a-f-]{36}\.dat$/i.test(entry.name))
              continue;
            const uuid = entry.name.slice(0, -4).toLowerCase();
            if (knownUuids.has(uuid)) continue;
            this.store.observePlayer(
              s.id,
              cache.find((p) => p.uuid.toLowerCase() === uuid)?.name || null,
              uuid,
              null,
            );
            knownUuids.add(uuid);
          }
        }
        this.recovered.set(s.id, Date.now());
      }
      for (const p of this.store.playerHistory(s.id)) {
        const match = cache.find(
          (c) =>
            c.uuid.toLowerCase() === p.uuid ||
            (!p.uuid && c.name.toLowerCase() === p.name?.toLowerCase()),
        );
        if (
          match &&
          (match.name !== p.name || match.uuid.toLowerCase() !== p.uuid)
        )
          this.store.observePlayer(s.id, match.name, match.uuid, null);
      }
      await this.readLogs(s, findUuid);
    } catch {
      historyWarning = "Some historical player records could not be read.";
    }
    let status = "unavailable",
      error: string | null = null;
    let online: any[] = [];
    try {
      const container = await this.engine.container(s);
      if (!container || !(await container.inspect()).State.Running)
        status = "stopped";
      else {
        const names = onlineNames(await this.engine.command(s, "list"));
        const now = new Date().toISOString();
        for (const name of names)
          this.store.observePlayer(s.id, name, findUuid(name), now);
        online = names.map((name) =>
          this.store
            .playerHistory(s.id)
            .find((p) => p.name?.toLowerCase() === name.toLowerCase()),
        );
        status = "ready";
      }
    } catch (e: any) {
      error = e.message || "Could not connect to the server";
    }
    this.snapshots.set(s.id, {
      status,
      online,
      error,
      historyWarning,
      updatedAt: new Date().toISOString(),
      fetchedAt: Date.now(),
    });
  }
  async readLogs(s: Server, uuid: (name: string) => string | null) {
    const dir = await noSymlinks(this.store.root, `servers/${s.id}/logs`);
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => []);
    const key = "player-cursors:" + s.id;
    const cursors = JSON.parse(this.store.get(key) || "{}");
    const recorded = new Set(
      this.store
        .playerHistory(s.id)
        .flatMap((p) => [...(p.aliases || []), p.name])
        .filter(Boolean)
        .map((n) => n.toLowerCase()),
    );
    let failed = false;
    for (const e of entries) {
      if (!e.isFile() || !/\.log(?:\.gz)?$/.test(e.name)) continue;
      const file = path.join(dir, e.name);
      const st = await fs.stat(file);
      const previous = cursors[e.name];
      if (previous?.size === st.size && previous?.mtime === st.mtimeMs) {
        if (previous.error) failed = true;
        continue;
      }
      const compressed = e.name.endsWith(".gz");
      // File identity, truncation, and changed same-size logs reset the cursor.
      const start =
        !compressed &&
        previous &&
        previous.ino === st.ino &&
        previous.size < st.size
          ? previous.offset
          : 0;
      const source = createReadStream(file, { start: start || 0 });
      const stream = compressed ? source.pipe(createGunzip()) : source;
      if (compressed) source.on("error", (e) => stream.destroy(e));
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let consumed = 0;
      try {
        for await (const line of lines) {
          consumed += Buffer.byteLength(line) + 1;
          if (consumed > 128 * 1024 ** 2)
            throw new Error("Log exceeds history import limit");
          const match = /\]:\s*([A-Za-z0-9_]{1,16}) joined the game\s*$/.exec(
            line,
          );
          if (match && !recorded.has(match[1].toLowerCase())) {
            this.store.observePlayer(s.id, match[1], uuid(match[1]), null);
            recorded.add(match[1].toLowerCase());
          }
        }
        // Read from the last full line next time to avoid missing a partial write.
        cursors[e.name] = {
          size: st.size,
          mtime: st.mtimeMs,
          ino: st.ino,
          offset: compressed ? 0 : Math.max(0, st.size - 1024),
        };
      } catch {
        failed = true;
        cursors[e.name] = {
          size: st.size,
          mtime: st.mtimeMs,
          ino: st.ino,
          offset: 0,
          error: true,
        };
      } finally {
        lines.close();
        stream.destroy();
        source.destroy();
      }
    }
    this.store.set(key, JSON.stringify(cursors));
    if (failed) throw new Error("Some historical logs could not be read");
  }
}
