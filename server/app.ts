import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { Store } from "./store.js";
import { Engine, IMAGE_RELEASE } from "./docker.js";
import { Jobs } from "./jobs.js";
import {
  createSchema,
  defaults,
  settingsSchema,
  contentFolder,
  noSymlinks,
  safeName,
  type Server,
} from "./core.js";
import { minecraftVersions, javaFor, available, choices } from "./catalog.js";
import { inspectJar, searchMods, resolveMods } from "./mods.js";
import {
  Storage,
  ContentIndex,
  backupList,
  workspaceSettings,
  workspaceSchema,
} from "./workspace.js";
import { PlayerTracker } from "./players.js";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function createApp(
  options: { root?: string; engine?: Engine; scheduling?: boolean } = {},
) {
  const root = path.resolve(options.root || process.env.DATA_DIR || "data");
  const store = new Store(root);
  const engine =
    options.engine || new Engine(root, process.env.HOST_DATA_DIR || root);
  const jobs = new Jobs(store, engine);
  if (options.scheduling === false) jobs.close();
  const storage = new Storage(root);
  const content = new ContentIndex(root);
  const players = new PlayerTracker(
    store,
    engine,
    options.scheduling !== false,
  );
  engine.onlineCount = (id) => {
    const current = players.snapshots.get(id);
    return current?.status === "ready" && Date.now() - current.fetchedAt < 15000
      ? current.online.length
      : null;
  };
  jobs.onChange = (id) => storage.invalidate(id);
  jobs.beforeDelete = (id) => players.forget(id);
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 500, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: 2 * 1024 ** 3, files: 1, fields: 2 },
  });
  app.decorate("store", store);
  app.decorate("engine", engine);
  app.decorate("jobs", jobs);
  app.setErrorHandler((error, req, reply) => {
    const e = error as any;
    const status = e.statusCode || (e instanceof z.ZodError ? 400 : 400);
    reply.code(status >= 500 ? 500 : status).send({
      error:
        e instanceof z.ZodError
          ? e.issues
              .map((i: any) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")
          : e.message || "Request failed",
    });
  });
  const publicPaths = new Set([
    "/api/health",
    "/api/auth/status",
    "/api/auth/setup",
    "/api/auth/login",
  ]);
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: https://cdn.modrinth.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    const route = req.routeOptions.url || req.url.split("?")[0];
    if (!route.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let host;
        try {
          host = new URL(origin).host;
        } catch {
          throw Object.assign(new Error("Invalid origin"), { statusCode: 403 });
        }
        if (host !== req.headers.host)
          throw Object.assign(
            new Error("Cross-origin requests are not allowed"),
            { statusCode: 403 },
          );
      }
      if (req.headers["x-mk-request"] !== "1")
        throw Object.assign(new Error("Missing request protection header"), {
          statusCode: 403,
        });
    }
    if (publicPaths.has(route)) return;
    const token = req.cookies.mk_session;
    const session = token
      ? (store.db
          .prepare("SELECT expires FROM sessions WHERE id=?")
          .get(hash(token)) as any)
      : null;
    if (!session || session.expires < Date.now())
      throw Object.assign(new Error("Please sign in"), { statusCode: 401 });
  });
  function session(reply: any) {
    const token = randomBytes(32).toString("hex");
    store.db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
    store.db
      .prepare("INSERT INTO sessions VALUES (?,?)")
      .run(hash(token), Date.now() + 7 * 86400000);
    reply.setCookie("mk_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.SECURE_COOKIE === "true",
      path: "/",
      maxAge: 7 * 86400,
    });
  }
  const credentials = z.object({
    username: z.string().trim().min(3).max(40),
    password: z.string().min(12).max(200),
  });
  app.get("/api/health", async () => ({ ok: true, version: "1.1.0" }));
  app.get("/api/auth/status", async (req) => {
    const token = req.cookies.mk_session;
    const row = token
      ? (store.db
          .prepare("SELECT expires FROM sessions WHERE id=?")
          .get(hash(token)) as any)
      : null;
    return {
      setup: !store.get("password"),
      authenticated: !!row && row.expires > Date.now(),
    };
  });
  app.post(
    "/api/auth/setup",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (store.get("password"))
        throw new Error("Administrator already exists");
      const b = credentials.parse(req.body);
      const salt = randomBytes(16).toString("hex");
      store.set(
        "password",
        salt + ":" + scryptSync(b.password, salt, 64).toString("hex"),
      );
      store.set("username", b.username);
      session(reply);
      return { ok: true };
    },
  );
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = credentials.parse(req.body);
      const saved = store.get("password");
      if (!saved) throw new Error("Create your administrator account first");
      const [salt, digest] = saved.split(":");
      const valid = timingSafeEqual(
        scryptSync(b.password, salt, 64),
        Buffer.from(digest, "hex"),
      );
      if (!valid || b.username !== store.get("username"))
        throw Object.assign(new Error("Incorrect username or password"), {
          statusCode: 401,
        });
      session(reply);
      return { ok: true };
    },
  );
  app.post("/api/auth/logout", async (req, reply) => {
    if (req.cookies.mk_session)
      store.db
        .prepare("DELETE FROM sessions WHERE id=?")
        .run(hash(req.cookies.mk_session));
    reply.clearCookie("mk_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/workspace/settings", async () => ({
    ...workspaceSettings(store),
    username: store.get("username"),
  }));
  app.put("/api/workspace/settings", async (req) => {
    const settings = workspaceSchema.parse(req.body);
    store.set("workspace", JSON.stringify(settings));
    return settings;
  });
  app.put(
    "/api/account",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = z
        .object({
          currentPassword: z.string().min(1).max(200),
          username: credentials.shape.username,
          password: credentials.shape.password.optional(),
        })
        .parse(req.body);
      const [salt, digest] = store.get("password")!.split(":");
      if (
        !timingSafeEqual(
          scryptSync(b.currentPassword, salt, 64),
          Buffer.from(digest, "hex"),
        )
      )
        throw new Error("Current password is incorrect");
      if (b.password) {
        const nextSalt = randomBytes(16).toString("hex");
        store.set(
          "password",
          nextSalt + ":" + scryptSync(b.password, nextSalt, 64).toString("hex"),
        );
      }
      store.set("username", b.username);
      store.db.prepare("DELETE FROM sessions").run();
      session(reply);
      return { ok: true };
    },
  );
  app.get("/api/workspace/content", async (req) => {
    const kind = z
      .enum(["worlds", "mods", "backups"])
      .parse((req.query as any).kind);
    const groups = [];
    for (const s of store.servers()) {
      const state = await engine
        .state(s)
        .catch(() => ({ status: "unavailable" }));
      let items: any[] = [],
        error = null;
      try {
        items =
          kind === "worlds"
            ? (await storage.get(s)).worlds
            : kind === "mods"
              ? await content.installed(s)
              : await backupList(root, s);
      } catch (e: any) {
        error = e.message;
      }
      groups.push({
        serverId: s.id,
        serverName: s.name,
        type: s.type,
        status: state.status,
        items,
        error,
      });
    }
    return { groups, updatedAt: new Date().toISOString() };
  });
  app.get("/api/servers/:id/storage", async (req) =>
    storage.get(store.server((req.params as any).id)),
  );
  app.addHook("onResponse", async (req, reply) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      reply.statusCode < 400
    ) {
      const id = (req.params as any)?.id;
      if (id) storage.invalidate(id);
    }
  });
  app.get("/api/system", async () => {
    let info;
    try {
      info = await engine.system();
    } catch {
      return {
        docker: false,
        error:
          "Docker is unavailable. Check the Docker service and socket mount.",
      };
    }
    const disk = await fs.statfs(root);
    const results = await Promise.all(
      store
        .servers()
        .map((s) => engine.state(s).catch(() => ({ cpu: 0, memory: 0 }))),
    );
    return {
      docker: true,
      ...info,
      allocated: store.servers().reduce((n, s) => n + s.memory, 0),
      usedMemory: results.reduce((n, s) => n + s.memory, 0),
      cpu: Math.min(
        100,
        results.reduce((n, s) => n + s.cpu, 0) / Math.max(info.cpus, 1),
      ),
      diskTotal: disk.blocks * disk.bsize,
      diskFree: disk.bavail * disk.bsize,
    };
  });
  app.get("/api/catalog", async (req) => {
    const q = req.query as any;
    if (q.version)
      return {
        types: await choices(
          z
            .string()
            .regex(/^\d+\.\d+(?:\.\d+)?$/)
            .parse(q.version),
        ),
      };
    return { versions: (await minecraftVersions()).map((v: any) => v.id) };
  });
  const snapshot = async (s: Server) => ({
    ...s,
    ...(await engine.state(s).catch(() => ({
      status: "unavailable",
      memory: 0,
      cpu: 0,
      players: null,
    }))),
    memoryLimit: s.memory,
  });
  app.get("/api/servers", async () =>
    Promise.all(store.servers().map(snapshot)),
  );
  app.post("/api/servers", async (req) => {
    const workspaceDefaults = workspaceSettings(store);
    const b = createSchema.parse({
      memory: workspaceDefaults.defaultMemory,
      ...(req.body as any),
    });
    await engine.system();
    if (!(await available(b.type, b.version)))
      throw new Error(`No ${b.type} release is available for ${b.version}`);
    let java = await javaFor(b.version);
    if (b.type === "PAPER" && b.version === "1.16.5") java = 16;
    if (b.type === "FORGE" && /^1\.(?:[0-9]|1[0-7])(?:\.|$)/.test(b.version))
      java = 8;
    if (![8, 11, 16, 17, 21, 25].includes(java))
      throw new Error(
        `Java ${java} has not been validated by this panel release`,
      );
    const info = await engine.system();
    if ((b.memory * 1024 + 1024) * 1024 ** 2 > info.memory)
      throw new Error(
        "Not enough host memory for that allocation plus the operating system",
      );
    const ports = new Set(store.servers().map((s) => s.port));
    let port = b.port || 25565;
    if (b.port && ports.has(port))
      throw new Error("Port is assigned to another server");
    if (!b.port) {
      for (; port < 65535; port++) {
        if (ports.has(port)) continue;
        try {
          await engine.ensurePort(port);
          break;
        } catch {}
      }
    }
    if (port >= 65535) throw new Error("No free server port found");
    await engine.ensurePort(port);
    const s: Server = {
      id: randomUUID(),
      name: b.name,
      type: b.type,
      version: b.version,
      java,
      memory: b.memory,
      port,
      seed: b.seed,
      motd: b.motd,
      settings: { ...defaults },
      created: new Date().toISOString(),
      banner: false,
      icon: false,
      backupHours: workspaceDefaults.defaultBackupHours,
      retention: workspaceDefaults.defaultRetention,
      lastBackup: null,
      image: `itzg/minecraft-server:${IMAGE_RELEASE}-java${java}`,
    };
    await engine.configure(s);
    store.save(s);
    const job = b.autoStart ? jobs.enqueue(s.id, "start") : null;
    return { server: s, job };
  });
  app.get("/api/jobs", async () => store.jobs());
  app.get("/api/servers/:id", async (req) =>
    snapshot(store.server((req.params as any).id)),
  );
  const target = (req: any) => store.server(req.params.id);
  const idle = (s: Server) => {
    if (store.activeJob(s.id) || jobs.deleting.has(s.id))
      throw new Error("Wait for the current server operation to finish");
  };
  const stopped = async (s: Server) => {
    idle(s);
    const state = await engine.state(s);
    if (!["stopped", "failed"].includes(state.status))
      throw new Error("Stop the server before changing its files or settings");
  };
  app.delete("/api/servers/:id", async (req) => {
    const s = target(req);
    const { name } = z.object({ name: z.string() }).parse(req.body);
    if (name !== s.name)
      throw new Error("Type the server name exactly to confirm deletion");
    idle(s);
    if (!/^[0-9a-f-]{36}$/i.test(s.id))
      throw new Error("Invalid server ID; files were not deleted");
    for (const folder of ["servers", "backups", "images"])
      await noSymlinks(root, `${folder}/${s.id}`);
    return jobs.enqueue(s.id, "delete", { server: s });
  });
  app.post("/api/servers/:id/actions", async (req) => {
    const s = target(req);
    const b = z
      .object({ action: z.enum(["start", "stop", "restart", "backup"]) })
      .parse(req.body);
    return jobs.enqueue(s.id, b.action);
  });
  app.get("/api/servers/:id/logs", async (req) => ({
    text: await engine.logs(target(req)),
  }));
  app.post("/api/servers/:id/command", async (req) => {
    const s = target(req);
    const command = z
      .object({
        command: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .regex(/^[^\r\n\x00]+$/),
      })
      .parse(req.body).command;
    return { text: await engine.command(s, command) };
  });
  app.get("/api/servers/:id/players", async (req) => {
    const s = target(req);
    const dir = engine.dir(s);
    const read = async (name: string) =>
      JSON.parse(
        await fs.readFile(path.join(dir, name), "utf8").catch(() => "[]"),
      );
    return {
      ...(await players.get(s)),
      whitelist: await read("whitelist.json"),
      ops: await read("ops.json"),
    };
  });
  app.post("/api/servers/:id/players", async (req) => {
    const s = target(req);
    const b = z
      .object({
        action: z.enum([
          "whitelist add",
          "whitelist remove",
          "op",
          "deop",
          "kick",
        ]),
        name: z.string().regex(/^[A-Za-z0-9_]{1,16}$/),
      })
      .parse(req.body);
    return { text: await engine.command(s, b.action + " " + b.name) };
  });
  app.put("/api/servers/:id/settings", async (req) => {
    const s = target(req);
    await stopped(s);
    const values = settingsSchema
      .extend({ memory: z.number().int().min(1).max(64).optional() })
      .parse(req.body);
    const memory = values.memory ?? s.memory;
    await engine.reconfigureMemory(s, memory);
    s.memory = memory;
    s.settings = settingsSchema.parse(values);
    store.save(s);
    await engine.configure(s);
    return s;
  });
  app.put("/api/servers/:id/appearance", async (req) => {
    const s = target(req);
    idle(s);
    const b = z
      .object({
        name: z.string().trim().min(1).max(48),
        motd: z
          .string()
          .max(160)
          .refine((v) => v.split("\n").length <= 2, "Use at most two lines"),
      })
      .parse(req.body);
    Object.assign(s, b);
    store.save(s);
    return { server: s, restartRequired: true };
  });
  async function upload(req: any, max: number) {
    const part = await req.file();
    if (!part) throw new Error("Choose a file");
    const chunks = [];
    let size = 0;
    for await (const chunk of part.file) {
      size += chunk.length;
      if (size > max) {
        part.file.resume();
        throw new Error(`File exceeds ${Math.round(max / 1024 ** 2)} MB`);
      }
      chunks.push(chunk);
    }
    if (part.file.truncated) throw new Error("File too large");
    return { buffer: Buffer.concat(chunks), name: safeName(part.filename) };
  }
  app.post("/api/servers/:id/image/:kind", async (req) => {
    const s = target(req);
    idle(s);
    const kind = z.enum(["banner", "icon"]).parse((req.params as any).kind);
    const { buffer } = await upload(req, 10 * 1024 ** 2);
    const image = sharp(buffer, { limitInputPixels: 25000000 });
    const data = await image
      .resize(kind === "icon" ? 64 : 1200, kind === "icon" ? 64 : 400, {
        fit: "cover",
        position: "attention",
      })
      .png()
      .toBuffer();
    const dir = path.join(root, "images", s.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, kind + ".png"), data);
    if (kind === "icon") {
      await fs.mkdir(engine.dir(s), { recursive: true });
      await fs.writeFile(path.join(engine.dir(s), "server-icon.png"), data);
    }
    s[kind] = true;
    store.save(s);
    return { ok: true, restartRequired: kind === "icon" };
  });
  app.get("/api/servers/:id/image/:kind", async (req, reply) => {
    const s = target(req);
    const kind = z.enum(["banner", "icon"]).parse((req.params as any).kind);
    return reply
      .type("image/png")
      .send(createReadStream(path.join(root, "images", s.id, kind + ".png")));
  });
  app.get("/api/servers/:id/files", async (req) => {
    const s = target(req);
    const rel = String((req.query as any).path || "");
    const p = await noSymlinks(engine.dir(s), rel);
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries
      .filter((e) => !e.isSymbolicLink() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, directory: e.isDirectory() }));
  });
  app.get("/api/servers/:id/file", async (req) => {
    const s = target(req);
    const rel = String((req.query as any).path || "");
    if (!/\.(txt|json|yml|yaml|toml|properties|cfg|conf|log)$/.test(rel))
      throw new Error("Only text configuration files can be opened");
    if (rel.split("/").some((p) => p.startsWith(".")))
      throw new Error("Hidden files cannot be opened");
    const file = await noSymlinks(engine.dir(s), rel);
    if ((await fs.stat(file)).size > 1024 ** 2)
      throw new Error("File too large for the editor");
    const text = await fs.readFile(file, "utf8");
    if (path.resolve(file) === path.resolve(engine.dir(s), "server.properties"))
      return {
        text: text.replace(/^rcon.password=.*$/gm, "rcon.password=[hidden]"),
        readOnly: true,
      };
    return { text, readOnly: false };
  });
  app.put("/api/servers/:id/file", async (req) => {
    const s = target(req);
    await stopped(s);
    const b = z
      .object({ path: z.string(), text: z.string().max(1024 ** 2) })
      .parse(req.body);
    if (
      !/\.(txt|json|yml|yaml|toml|cfg|conf)$/.test(b.path) ||
      ["eula.txt"].includes(b.path) ||
      b.path.split("/").some((p) => p.startsWith("."))
    )
      throw new Error("This file is managed by the panel or is not editable");
    await fs.writeFile(await noSymlinks(engine.dir(s), b.path), b.text);
    return { ok: true };
  });
  app.post("/api/servers/:id/world", async (req) => {
    const s = target(req);
    idle(s);
    const part = await req.file();
    if (!part || !part.filename.toLowerCase().endsWith(".zip"))
      throw new Error("Choose a ZIP world archive");
    const dir = path.join(root, "uploads");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, randomUUID() + ".zip");
    try {
      await pipeline(part.file, createWriteStream(file));
      if (part.file.truncated) throw new Error("World upload exceeds 2 GB");
      return jobs.enqueue(s.id, "world", { file });
    } catch (e) {
      await fs.rm(file, { force: true });
      throw e;
    }
  });
  app.get("/api/servers/:id/backups", async (req) => {
    return backupList(root, target(req));
  });
  app.delete("/api/servers/:id/backup/:name", async (req) => {
    const s = target(req);
    idle(s);
    const name = safeName((req.params as any).name);
    if (!name.endsWith(".zip")) throw new Error("Invalid backup");
    const file = await noSymlinks(root, `backups/${s.id}/${name}`);
    if (!(await fs.stat(file)).isFile()) throw new Error("Backup not found");
    return jobs.enqueue(s.id, "delete-backup", { name });
  });
  app.put("/api/servers/:id/backups", async (req) => {
    const s = target(req);
    idle(s);
    const b = z
      .object({
        backupHours: z.number().int().min(0).max(168),
        retention: z.number().int().min(1).max(50),
      })
      .parse(req.body);
    Object.assign(s, b);
    store.save(s);
    return s;
  });
  app.post("/api/servers/:id/restore", async (req) => {
    const s = target(req);
    idle(s);
    const name = safeName(z.object({ name: z.string() }).parse(req.body).name);
    if (!name.endsWith(".zip")) throw new Error("Invalid backup");
    const file = await noSymlinks(root, `backups/${s.id}/${name}`);
    await fs.access(file);
    return jobs.enqueue(s.id, "restore", { file });
  });
  app.get("/api/servers/:id/backup/:name", async (req, reply) => {
    const s = target(req);
    const name = safeName((req.params as any).name);
    if (!name.endsWith(".zip")) throw new Error("Invalid backup");
    return reply
      .header("Content-Disposition", `attachment; filename="${name}"`)
      .type("application/zip")
      .send(
        createReadStream(await noSymlinks(root, `backups/${s.id}/${name}`)),
      );
  });
  app.get("/api/servers/:id/mods", async (req) => {
    const s = target(req);
    const folder = contentFolder(s.type);
    return (
      await fs.readdir(path.join(engine.dir(s), folder)).catch(() => [])
    ).filter((n) => /\.jar(?:\.disabled)?$/.test(n));
  });
  app.get("/api/servers/:id/mods/search", async (req) =>
    searchMods(String((req.query as any).q || "").slice(0, 100), target(req)),
  );
  app.get("/api/servers/:id/mods/preview", async (req) =>
    resolveMods(
      z
        .string()
        .regex(/^[\w-]+$/)
        .parse((req.query as any).project),
      target(req),
    ),
  );
  app.post("/api/servers/:id/mods/install", async (req) => {
    const s = target(req);
    const b = z
      .object({ project: z.string().regex(/^[\w-]+$/) })
      .parse(req.body);
    contentFolder(s.type);
    return jobs.enqueue(s.id, "mods", b);
  });
  app.post("/api/servers/:id/mods/upload", async (req) => {
    const s = target(req);
    await stopped(s);
    const { buffer, name } = await upload(req, 100 * 1024 ** 2);
    if (!name.endsWith(".jar")) throw new Error("Choose a .jar file");
    const check = await inspectJar(buffer, s);
    if (check.status === "Incompatible") return { installed: false, check };
    if ((req.query as any).confirm !== "true")
      return { installed: false, check };
    const dir = path.join(engine.dir(s), contentFolder(s.type));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), buffer, { flag: "wx" });
    return { installed: true, check };
  });
  app.post("/api/servers/:id/mods/toggle", async (req) => {
    const s = target(req);
    await stopped(s);
    const b = z.object({ name: z.string() }).parse(req.body);
    const name = safeName(b.name);
    if (!/\.jar(?:\.disabled)?$/.test(name))
      throw new Error("Invalid mod filename");
    const dir = path.join(engine.dir(s), contentFolder(s.type));
    const next = name.endsWith(".disabled")
      ? name.slice(0, -9)
      : name + ".disabled";
    await fs
      .access(path.join(dir, next))
      .then(() => {
        throw new Error("Destination already exists");
      })
      .catch((e: any) => {
        if (e.code !== "ENOENT") throw e;
      });
    await fs.rename(await noSymlinks(dir, name), path.join(dir, next));
    return { ok: true };
  });
  const client = path.resolve("dist/client");
  if (existsSync(client)) {
    await app.register(staticFiles, { root: client });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => {
    jobs.close();
    await players.close();
    await jobs.drain();
    store.close();
  });
  return { app, store, engine, jobs, storage, players };
}
