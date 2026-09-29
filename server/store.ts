import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Server, Job } from "./core.js";
export class Store {
  db: DatabaseSync;
  constructor(public root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, "panel.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS players(server_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(server_id,id)); PRAGMA user_version=2;",
    );
  }
  get(key: string) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as any;
    return row?.value as string | undefined;
  }
  set(key: string, value: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES (?,?)")
      .run(key, value);
  }
  servers(): Server[] {
    return (
      this.db
        .prepare("SELECT data FROM servers ORDER BY rowid DESC")
        .all() as any[]
    ).map((r) => JSON.parse(r.data));
  }
  server(id: string): Server {
    const row = this.db
      .prepare("SELECT data FROM servers WHERE id=?")
      .get(id) as any;
    if (!row)
      throw Object.assign(new Error("Server not found"), { statusCode: 404 });
    return JSON.parse(row.data);
  }
  save(s: Server) {
    this.db
      .prepare("INSERT OR REPLACE INTO servers VALUES (?,?)")
      .run(s.id, JSON.stringify(s));
  }
  removeServer(id: string, keepJob = "") {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "DELETE FROM jobs WHERE json_extract(data, '$.serverId')=? AND id != ?",
        )
        .run(id, keepJob);
      this.db.prepare("DELETE FROM players WHERE server_id=?").run(id);
      this.db
        .prepare("DELETE FROM settings WHERE key=?")
        .run("player-cursors:" + id);
      this.db.prepare("DELETE FROM servers WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  playerHistory(serverId: string): any[] {
    return (
      this.db
        .prepare("SELECT data FROM players WHERE server_id=?")
        .all(serverId) as any[]
    ).map((row) => JSON.parse(row.data));
  }
  observePlayer(
    serverId: string,
    name: string | null,
    uuid: string | null,
    observedAt: string | null,
  ) {
    uuid = uuid?.toLowerCase() || null;
    const history = this.playerHistory(serverId);
    const matches = history.filter(
      (p) =>
        (uuid && p.uuid === uuid) ||
        (name &&
          p.name?.toLowerCase() === name.toLowerCase() &&
          (!p.uuid || !uuid)),
    );
    const known = matches.find((p) => p.uuid) || matches[0];
    const id = uuid || known?.uuid || name?.toLowerCase();
    if (!id) return;
    const dates = matches
      .flatMap((p) => [p.firstObserved, p.lastSeen])
      .filter(Boolean)
      .concat(observedAt ? [observedAt] : [])
      .sort();
    const value = {
      id,
      uuid: uuid || known?.uuid || null,
      name: name || known?.name || null,
      aliases: [
        ...new Set(
          matches
            .flatMap((p) => [...(p.aliases || []), p.name])
            .concat(name)
            .filter(Boolean),
        ),
      ],
      firstObserved: dates[0] || null,
      lastSeen: dates.at(-1) || null,
    };
    if (matches.length === 1 && JSON.stringify(known) === JSON.stringify(value))
      return;
    for (const p of matches)
      if (p.id !== id)
        this.db
          .prepare("DELETE FROM players WHERE server_id=? AND id=?")
          .run(serverId, p.id);
    this.db
      .prepare("INSERT OR REPLACE INTO players VALUES (?,?,?)")
      .run(serverId, id, JSON.stringify(value));
  }
  activeJob(serverId: string) {
    return this.db
      .prepare(
        "SELECT id FROM jobs WHERE json_extract(data,'$.serverId')=? AND json_extract(data,'$.status') IN ('running','queued') LIMIT 1",
      )
      .get(serverId);
  }
  jobs(): Job[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM jobs ORDER BY CASE WHEN json_extract(data,'$.status') IN ('running','queued') THEN 0 ELSE 1 END, rowid DESC LIMIT 250",
        )
        .all() as any[]
    ).map((r) => JSON.parse(r.data));
  }
  unfinishedJobs(): Job[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM jobs WHERE json_extract(data,'$.status') IN ('running','queued') ORDER BY rowid",
        )
        .all() as any[]
    ).map((row) => JSON.parse(row.data));
  }
  job(id: string): Job {
    const row = this.db
      .prepare("SELECT data FROM jobs WHERE id=?")
      .get(id) as any;
    if (!row) throw new Error("Job not found");
    return JSON.parse(row.data);
  }
  saveJob(j: Job) {
    j.updated = new Date().toISOString();
    this.db
      .prepare("INSERT OR REPLACE INTO jobs VALUES (?,?)")
      .run(j.id, JSON.stringify(j));
  }
  newJob(
    serverId: string,
    kind: string,
    payload: Record<string, unknown> = {},
  ): Job {
    const j: Job = {
      id: randomUUID(),
      serverId,
      kind,
      payload,
      status: "queued",
      message: "Waiting to start",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    this.saveJob(j);
    return j;
  }
  close() {
    this.db.close();
  }
}
