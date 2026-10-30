import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Server } from "./core.js";
import { noSymlinks } from "./core.js";
import type { Jobs } from "./jobs.js";
import { Trash } from "./trash.js";
import {
  Imports,
  remote,
  remoteJSON,
  runtimeSchema,
  uploadLimit,
} from "./imports.js";

export function importRoutes(
  app: FastifyInstance,
  jobs: Jobs,
  target: (req: any) => Server,
  idle: (s: Server) => void,
) {
  const { store, engine } = jobs,
    imports = new Imports(store);
  async function locked<T>(s: Server, fn: () => Promise<T>, stopped = false) {
    idle(s);
    jobs.fileMutations.add(s.id);
    try {
      if (
        stopped &&
        !["stopped", "failed"].includes((await engine.state(s)).status)
      )
        throw new Error("Stop Minecraft before changing trash");
      return await fn();
    } finally {
      jobs.fileMutations.delete(s.id);
      jobs.onChange(s.id);
    }
  }
  const trash = (s: Server) => new Trash(store.root, s.id, engine.dir(s));
  app.get("/api/servers/:id/trash", async (req) => trash(target(req)).list());
  app.post("/api/servers/:id/trash", async (req) => {
    const s = target(req),
      b = z
        .object({ paths: z.array(z.string().min(1)).min(1).max(1000) })
        .parse(req.body);
    return locked(
      s,
      async () => {
        await trash(s).remove(b.paths);
        return { ok: true };
      },
      true,
    );
  });
  app.post("/api/servers/:id/trash/:entry/restore", async (req) => {
    const s = target(req);
    return locked(
      s,
      async () => {
        await trash(s).restore(String((req.params as any).entry));
        return { ok: true };
      },
      true,
    );
  });
  app.delete("/api/servers/:id/trash", async (req) => {
    const s = target(req);
    z.object({ confirm: z.literal(true) }).parse(req.body);
    return locked(
      s,
      async () => {
        await trash(s).empty();
        return { ok: true };
      },
      true,
    );
  });
  app.get("/api/modpack-settings", async () => ({
    curseforgeConfigured: !!(
      store.get("curseforge-api-key") || process.env.CURSEFORGE_API_KEY
    ),
    environmentManaged:
      !!process.env.CURSEFORGE_API_KEY && !store.get("curseforge-api-key"),
  }));
  app.put("/api/modpack-settings", async (req) => {
    const b = z.object({ apiKey: z.string().trim().max(1024) }).parse(req.body);
    if (b.apiKey && /[\r\n]/.test(b.apiKey)) throw new Error("Invalid API key");
    if (b.apiKey) store.set("curseforge-api-key", b.apiKey);
    else store.delete("curseforge-api-key");
    return { ok: true };
  });
  app.get("/api/modpacks", async (req) => {
    const q = z
      .object({ query: z.string().max(150).default("") })
      .parse(req.query);
    return remoteJSON(
      `https://api.modrinth.com/v2/search?facets=${encodeURIComponent(JSON.stringify([["project_type:modpack"], ["server_side:required", "server_side:optional"]]))}&query=${encodeURIComponent(q.query)}&limit=20`,
    );
  });
  app.get("/api/modpacks/:project/versions", async (req) => {
    const id = z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .parse((req.params as any).project);
    return remoteJSON(`https://api.modrinth.com/v2/project/${id}/version`);
  });
  app.post("/api/servers/:id/imports", async (req) => {
    const s = target(req),
      kind = z
        .enum(["world", "backup", "modpack"])
        .parse((req.query as any).kind);
    return locked(s, async () => {
      const part = await req.file({
        limits: { fileSize: uploadLimit(), files: 1, fields: 0 },
      });
      if (!part) throw new Error("Choose an archive");
      try {
        return await imports.inspect(s.id, kind, part.file, part.filename);
      } finally {
        part.file.resume();
      }
    });
  });
  app.post("/api/servers/:id/imports/modrinth", async (req) => {
    const s = target(req),
      b = z
        .object({ version: z.string().regex(/^[a-zA-Z0-9]{1,100}$/) })
        .parse(req.body);
    return locked(s, async () => {
      const version = await remoteJSON(
        `https://api.modrinth.com/v2/version/${b.version}`,
      );
      const file =
        version.files?.find((f: any) => f.primary) || version.files?.[0];
      if (!file?.filename?.endsWith(".mrpack"))
        throw new Error("This version has no Modrinth pack archive");
      const r = await remote(file.url);
      return imports.inspect(
        s.id,
        "modpack",
        Readable.fromWeb(r.body as any),
        file.filename,
      );
    });
  });
  app.get("/api/servers/:id/imports/:importId", async (req) => {
    const s = target(req);
    return imports.get(String((req.params as any).importId), s.id);
  });
  app.post("/api/servers/:id/imports/:importId/file", async (req) => {
    const s = target(req);
    return locked(s, async () => {
      const record = imports.get(String((req.params as any).importId), s.id);
      const part = await req.file({
        limits: { fileSize: uploadLimit(), files: 1, fields: 0 },
      });
      if (!part) throw new Error("Choose a missing file");
      try {
        await imports.manual(
          record,
          String((req.query as any).path),
          part.file,
        );
        return { ok: true };
      } finally {
        part.file.resume();
      }
    });
  });
  app.post("/api/servers/:id/imports/:importId/apply", async (req) => {
    const s = target(req);
    idle(s);
    const record = imports.get(String((req.params as any).importId), s.id);
    const b = z
      .object({
        confirm: z.literal(true),
        runtime: runtimeSchema.optional(),
        keepWorld: z.boolean().default(false),
        world: z.string().optional(),
        optional: z.array(z.string()).max(100000).default([]),
      })
      .parse(req.body);
    if (record.state !== "ready") throw new Error("Import is no longer ready");
    if (record.kind === "backup")
      return locked(s, async () => {
        const runtime = runtimeSchema.parse(
          record.runtime
            ? {
                ...record.runtime,
                loaderVersion:
                  record.runtime.loaderVersion || b.runtime?.loaderVersion,
              }
            : b.runtime,
        );
        const dir = await noSymlinks(store.root, `backups/${s.id}`);
        await fs.mkdir(dir, { recursive: true });
        const name = `uploaded-${randomUUID()}.zip`;
        await fs.copyFile(
          path.join(await imports.dir(record.id), "archive.zip"),
          path.join(dir, name),
        );
        store.set(
          `backup-import:${s.id}:${name}`,
          JSON.stringify({ ...record, runtime }),
        );
        record.state = "installed";
        imports.save(record);
        return {
          ok: true,
          name,
          message:
            "Backup uploaded. Restore it separately from the backup list.",
        };
      });
    return jobs.enqueue(s.id, "import", { ...b, importId: record.id });
  });
  app.get("/api/servers/:id/import-recovery", async (req) => {
    const s = target(req),
      raw = store.get(`rollback:${s.id}`);
    return {
      available: !!raw,
      recoveryRequired: !!s.recoveryRequired,
      pack: s.pack,
    };
  });
  app.post("/api/servers/:id/import-recovery", async (req) => {
    const s = target(req);
    idle(s);
    z.object({ confirm: z.literal(true) }).parse(req.body);
    return jobs.enqueue(s.id, "import-rollback");
  });
  app.delete("/api/servers/:id/import-recovery", async (req) => {
    const s = target(req);
    z.object({ confirm: z.literal(true) }).parse(req.body);
    return locked(
      s,
      async () => {
        if (s.recoveryRequired)
          throw new Error("Recover the interrupted import first");
        const raw = store.get(`rollback:${s.id}`);
        if (raw) {
          const journal = JSON.parse(raw);
          await fs.rm(await noSymlinks(store.root, journal.previous), {
            recursive: true,
            force: true,
          });
          store.delete(`rollback:${s.id}`);
        }
        return { ok: true };
      },
      true,
    );
  });
}
