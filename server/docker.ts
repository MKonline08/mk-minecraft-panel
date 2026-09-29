import Docker from "dockerode";
import { PassThrough } from "node:stream";
import net from "node:net";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { Server } from "./core.js";
import { patchProperties, properties } from "./core.js";
export const IMAGE_RELEASE = "2026.9.2";
const LABEL = "io.mk-panel.server";
export class Engine {
  docker: Docker;
  constructor(
    public root: string,
    public hostRoot: string,
  ) {
    this.docker = new Docker({
      socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
    });
  }
  dir(s: Server) {
    return path.join(this.root, "servers", s.id);
  }
  async system() {
    const info = await this.docker.info();
    return {
      cpus: info.NCPU,
      memory: info.MemTotal,
      architecture: info.Architecture,
    };
  }
  async container(s: Server) {
    const c = this.docker.getContainer("mk-" + s.id);
    try {
      const i = await c.inspect();
      if (i.Config.Labels?.[LABEL] !== s.id)
        throw new Error("Container ownership check failed");
      return c;
    } catch (e: any) {
      if (e.statusCode === 404) return null;
      throw e;
    }
  }
  async state(s: Server) {
    const c = await this.container(s);
    if (!c) return { status: "stopped", memory: 0, cpu: 0, players: null };
    const i = await c.inspect();
    if (!i.State.Running || i.State.Restarting)
      return {
        status: i.State.ExitCode || i.State.Restarting ? "failed" : "stopped",
        memory: 0,
        cpu: 0,
        players: null,
      };
    let memory = 0,
      cpu = 0;
    try {
      const stats = await c.stats({ stream: false });
      memory = Math.max(
        0,
        stats.memory_stats.usage -
          (stats.memory_stats.stats?.inactive_file || 0),
      );
      const d =
        stats.cpu_stats.cpu_usage.total_usage -
        stats.precpu_stats.cpu_usage.total_usage;
      const sys =
        stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      cpu = sys > 0 ? (d / sys) * (stats.cpu_stats.online_cpus || 1) * 100 : 0;
    } catch {}
    const status =
      i.State.Health?.Status === "healthy"
        ? "running"
        : i.State.Health?.Status === "unhealthy"
          ? "needs attention"
          : "starting";
    let players: number | null = null;
    if (status === "running") {
      try {
        const response = await this.command(s, "list");
        const match = /(?:There are|are) (\d+)/i.exec(response);
        if (match) players = Number(match[1]);
      } catch {}
    }
    return { status, memory, cpu, players };
  }
  async configure(s: Server) {
    const dir = this.dir(s);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "server.properties");
    const old = await fs.readFile(file, "utf8").catch(() => "");
    const password = await this.password(s);
    await fs.writeFile(
      file,
      patchProperties(old, {
        ...properties(s),
        "enable-rcon": true,
        "rcon.password": password,
        "rcon.port": 25575,
      }),
    );
  }
  async password(s: Server) {
    const file = path.join(this.dir(s), ".mk-rcon-password");
    try {
      return await fs.readFile(file, "utf8");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      const password = randomBytes(24).toString("hex");
      await fs.writeFile(file, password, { mode: 0o600 });
      return password;
    }
  }
  async ensurePort(port: number) {
    const all = await this.docker.listContainers({ all: true });
    if (all.some((c) => c.Ports?.some((p) => p.PublicPort === port)))
      throw new Error(`Port ${port} is already in use`);
    if (process.platform === "linux") {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createServer();
        sock.once("error", () =>
          reject(new Error(`Port ${port} is already in use`)),
        );
        sock.listen(port, "0.0.0.0", () => sock.close(() => resolve()));
      });
    }
  }
  async start(s: Server, progress: (msg: string) => void) {
    let c = await this.container(s);
    if (c) {
      const i = await c.inspect();
      if (i.State.Running) return;
      await this.capacity(s);
      await this.configure(s);
      progress("Starting Minecraft");
      await c.start();
      return;
    }
    await this.capacity(s);
    await this.ensurePort(s.port);
    await this.configure(s);
    progress(
      "Downloading the Java server image (first launch can take several minutes)",
    );
    const stream = await this.docker.pull(s.image);
    await new Promise<void>((resolve, reject) =>
      this.docker.modem.followProgress(stream, (err: any) =>
        err ? reject(err) : resolve(),
      ),
    );
    const env = [
      `EULA=TRUE`,
      `TYPE=${s.type}`,
      `VERSION=${s.version}`,
      `MEMORY=${s.memory}G`,
      "INIT_MEMORY=512M",
      "ENABLE_RCON=true",
      `RCON_PASSWORD=${await this.password(s)}`,
      "OVERRIDE_SERVER_PROPERTIES=false",
      "ENABLE_ROLLING_LOGS=true",
      `UID=${process.getuid?.() ?? 0}`,
      `GID=${process.getgid?.() ?? 0}`,
    ];
    c = await this.docker.createContainer({
      name: "mk-" + s.id,
      Image: s.image,
      Labels: { [LABEL]: s.id },
      Env: env,
      ExposedPorts: { "25565/tcp": {} },
      HostConfig: {
        Binds: [`${this.hostRoot.replace(/\/$/, "")}/servers/${s.id}:/data`],
        PortBindings: { "25565/tcp": [{ HostPort: String(s.port) }] },
        Memory: (s.memory * 1024 + 768) * 1024 * 1024,
        RestartPolicy: { Name: "unless-stopped" },
        LogConfig: {
          Type: "json-file",
          Config: { "max-size": "10m", "max-file": "3" },
        },
      },
    });
    progress("Starting Minecraft and generating the world");
    await c.start();
  }
  async capacity(s: Server) {
    const info = await this.system();
    const running = await this.docker.listContainers();
    const limits = await Promise.all(
      running.map(async (row) => {
        const c = await this.docker.getContainer(row.Id).inspect();
        return c.HostConfig.Memory || 0;
      }),
    );
    const required = (s.memory * 1024 + 768) * 1024 ** 2;
    if (
      limits.reduce((n, m) => n + m, 0) + required + 512 * 1024 ** 2 >
      info.memory
    )
      throw new Error(
        "Not enough unreserved host RAM. Stop another server or create this server with less memory.",
      );
  }
  async ready(s: Server, progress: (msg: string) => void) {
    for (let i = 0; i < 240; i++) {
      const state = await this.state(s);
      if (state.status === "running") return;
      if (["stopped", "failed"].includes(state.status))
        throw new Error(
          "Minecraft exited during startup. Open Console for the cause, then retry.",
        );
      if (i % 12 === 0)
        progress(
          `Waiting for Minecraft to be ready (${Math.floor((i * 5) / 60)} min). Console shows download and startup details.`,
        );
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(
      "Startup did not complete within 20 minutes. Check Console; the server may still be loading.",
    );
  }
  async stop(s: Server) {
    const c = await this.container(s);
    if (c && (await c.inspect()).State.Running) await c.stop({ t: 120 });
  }
  async logs(s: Server) {
    const c = await this.container(s);
    if (!c) return "Server has not started yet.";
    const raw = (await c.logs({
      stdout: true,
      stderr: true,
      tail: 160,
      timestamps: false,
    })) as Buffer;
    return demux(raw).slice(-60000);
  }
  async command(s: Server, command: string) {
    const c = await this.container(s);
    if (!c || !(await c.inspect()).State.Running)
      throw new Error("Server is not running");
    const exec = await c.exec({
      Cmd: ["rcon-cli", command],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    const out = new PassThrough();
    const err = new PassThrough();
    let text = "";
    out.on("data", (b) => (text += b.toString()));
    err.on("data", (b) => (text += b.toString()));
    this.docker.modem.demuxStream(stream, out, err);
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    if ((await exec.inspect()).ExitCode !== 0)
      throw new Error(text || "Command failed");
    return text;
  }
}
export function demux(buf: Buffer) {
  let i = 0,
    out = "";
  while (
    i + 8 <= buf.length &&
    buf[i] <= 2 &&
    buf[i + 1] === 0 &&
    buf[i + 2] === 0 &&
    buf[i + 3] === 0
  ) {
    const n = buf.readUInt32BE(i + 4);
    if (i + 8 + n > buf.length) break;
    out += buf.subarray(i + 8, i + 8 + n).toString();
    i += 8 + n;
  }
  return i === 0 ? buf.toString() : out;
}
