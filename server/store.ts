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
  jobs(): Job[] {
    return (
      this.db
        .prepare("SELECT data FROM jobs ORDER BY rowid DESC LIMIT 250")
        .all() as any[]
    ).map((r) => JSON.parse(r.data));
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
