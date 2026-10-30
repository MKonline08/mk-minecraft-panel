import fs from "node:fs/promises";
import path from "node:path";
import {
  Imports,
  runtimeSchema,
  diskSpace,
  worldName,
  type Runtime,
} from "./imports.js";
import {
  noSymlinks,
  patchProperties,
  readProperties,
  settingsSchema,
  type Server,
  type Job,
} from "./core.js";
import { treeBytes } from "./trash.js";
import type { Jobs } from "./jobs.js";

async function removeContainer(jobs: Jobs, s: Server) {
  await jobs.engine.stop(s);
  const c = await jobs.engine.container(s);
  if (c) await c.remove();
}
export async function rollbackImport(
  jobs: Jobs,
  s: Server,
  progress: (s: string) => void,
) {
  const raw = jobs.store.get(`rollback:${s.id}`);
  if (!raw) throw new Error("No import rollback is available");
  const journal = JSON.parse(raw);
  const previous = await noSymlinks(jobs.store.root, journal.previous);
  const live = jobs.engine.dir(s);
  if (!(await fs.stat(previous).catch(() => null))) {
    if (journal.stage === "prepared") {
      jobs.store.save(journal.server);
      jobs.store.delete(`rollback:${s.id}`);
      return;
    }
    throw new Error(
      "Previous installation is missing. Restore the safety backup.",
    );
  }
  progress("Rolling back files and runtime settings");
  await removeContainer(jobs, s);
  const failed = previous + "-failed";
  if (await fs.stat(live).catch(() => null)) await fs.rename(live, failed);
  try {
    await fs.rename(previous, live);
    jobs.store.save(journal.server);
  } catch (e) {
    if (!(await fs.stat(live).catch(() => null))) await fs.rename(failed, live);
    throw e;
  }
  jobs.store.delete(`rollback:${s.id}`);
  // The failed installation is retained beside the journal for diagnosis.
}
export async function runImport(
  jobs: Jobs,
  s: Server,
  j: Job,
  progress: (s: string) => void,
) {
  const imports = new Imports(jobs.store),
    record = imports.get(String(j.payload.importId), s.id);
  if (record.state !== "ready")
    throw new Error(
      "This import has already been applied or needs to be uploaded again",
    );
  if (s.recoveryRequired)
    throw new Error("Recover the previous interrupted import first");
  if (jobs.store.get(`rollback:${s.id}`))
    throw new Error(
      "Keep or roll back the previous import before replacing this server again",
    );
  const dir = await imports.dir(record.id),
    source = await noSymlinks(dir, record.source);
  let prepared: string,
    next: Server = structuredClone(s);
  progress("Preparing and validating imported files");
  if (record.kind === "world") {
    const selected = String(j.payload.world ?? record.worlds[0] ?? "");
    if (!record.worlds.includes(selected))
      throw new Error("Choose a world from this archive");
    if (record.worlds.length > 1 && j.payload.world === undefined)
      throw new Error("Choose which world to import");
    prepared = path.join(dir, "prepared");
    await fs.rm(prepared, { recursive: true, force: true });
    // Copy only after stopping below, so live world writes cannot race the snapshot.
  } else {
    const runtime = runtimeSchema.parse(j.payload.runtime || record.runtime);
    if (
      j.payload.keepWorld &&
      (record.kind !== "modpack" || runtime.version !== s.version)
    )
      throw new Error("Keeping a world requires the same Minecraft version");
    await diskSpace(
      dir,
      (await treeBytes(source)) + (await treeBytes(jobs.engine.dir(s))),
    );
    const result = await imports.prepare(
      record,
      runtime,
      Array.isArray(j.payload.optional) ? (j.payload.optional as string[]) : [],
      progress,
    );
    prepared = result.dest;
    next = {
      ...s,
      ...result.runtime,
      pack:
        record.kind === "modpack"
          ? {
              name: record.name,
              version: record.version,
              format: record.format,
              status: "installed",
            }
          : undefined,
    };
  }
  await diskSpace(
    dir,
    (await treeBytes(jobs.engine.dir(s))) * 3 + (await treeBytes(source)),
  );
  await jobs.engine.stop(s);
  progress("Creating a verified safety backup");
  const safety = await jobs.backup(s, progress, false);
  const live = jobs.engine.dir(s);
  if (record.kind === "world") {
    await fs.cp(live, prepared!, { recursive: true });
    const name = await worldName(live);
    for (const suffix of ["", "_nether", "_the_end"])
      await fs.rm(await noSymlinks(prepared!, name + suffix), {
        recursive: true,
        force: true,
      });
    const selected = String(j.payload.world ?? record.worlds[0]);
    const from = await noSymlinks(source, selected);
    await fs.mkdir(path.dirname(await noSymlinks(prepared!, name)), {
      recursive: true,
    });
    await fs.cp(from, await noSymlinks(prepared!, name), { recursive: true });
    // Paper-style sibling dimensions accompany the chosen world.
    for (const suffix of ["_nether", "_the_end"]) {
      const sibling = from + suffix;
      if (await fs.stat(sibling).catch(() => null))
        await fs.cp(sibling, await noSymlinks(prepared!, name + suffix), {
          recursive: true,
        });
    }
  } else if (j.payload.keepWorld) {
    const oldName = await worldName(live),
      newName = await worldName(prepared!);
    for (const suffix of ["", "_nether", "_the_end"]) {
      const from = await noSymlinks(live, oldName + suffix),
        dest = await noSymlinks(prepared!, newName + suffix);
      await fs.rm(dest, { recursive: true, force: true });
      if (await fs.stat(from).catch(() => null)) {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.cp(from, dest, { recursive: true });
      }
    }
  }
  if (record.kind === "modpack" && !j.payload.keepWorld) {
    // Do not delete pack-supplied template worlds: they are the pack's fresh world.
    next.seed = "";
  }
  const password = await jobs.engine.password(s);
  await worldName(prepared!);
  next.lastBackup = jobs.store.server(s.id).lastBackup;
  const props = path.join(prepared!, "server.properties");
  await fs.writeFile(
    props,
    patchProperties(await fs.readFile(props, "utf8").catch(() => ""), {
      "server-port": 25565,
      "enable-rcon": true,
      "rcon.port": 25575,
      "rcon.password": password,
    }),
  );
  await fs.writeFile(path.join(prepared!, ".mk-rcon-password"), password, {
    mode: 0o600,
  });
  const importedProperties = readProperties(await fs.readFile(props, "utf8"));
  const settings: Record<string, unknown> = { ...next.settings };
  for (const [field, key] of Object.entries({
    difficulty: "difficulty",
    gamemode: "gamemode",
    maxPlayers: "max-players",
    viewDistance: "view-distance",
    pvp: "pvp",
    whitelist: "white-list",
  })) {
    if (importedProperties[key] !== undefined)
      settings[field] =
        typeof (next.settings as any)[field] === "number"
          ? Number(importedProperties[key])
          : typeof (next.settings as any)[field] === "boolean"
            ? importedProperties[key] === "true"
            : importedProperties[key];
  }
  next.settings = settingsSchema.parse(settings);
  next.motd = importedProperties.motd ?? next.motd;
  next.seed = importedProperties["level-seed"] ?? next.seed;
  const previous = `staging/${s.id}-previous-${record.id}`;
  const journal = {
    previous,
    server: s,
    stage: "prepared",
    safetyBackup: safety,
  };
  await fs.mkdir(path.dirname(await noSymlinks(jobs.store.root, previous)), {
    recursive: true,
  });
  jobs.store.set(`rollback:${s.id}`, JSON.stringify(journal));
  record.state = "installing";
  imports.save(record);
  jobs.store.save({ ...s, recoveryRequired: true });
  try {
    await removeContainer(jobs, s);
    await fs.rename(live, await noSymlinks(jobs.store.root, previous));
    journal.stage = "old-moved";
    jobs.store.set(`rollback:${s.id}`, JSON.stringify(journal));
    await fs.rename(prepared!, live);
    next.recoveryRequired = false;
    jobs.store.save(next);
    journal.stage = "installed";
    jobs.store.set(`rollback:${s.id}`, JSON.stringify(journal));
    record.state = "installed";
    imports.save(record);
  } catch (e) {
    record.state = "failed";
    imports.save(record);
    try {
      await rollbackImport(jobs, jobs.store.server(s.id), progress);
    } catch {
      jobs.store.save({ ...s, recoveryRequired: true });
    }
    throw e;
  }
  if (record.kind === "modpack") {
    try {
      progress("Installed. Checking Minecraft startup");
      await jobs.engine.start(next, progress);
      await jobs.engine.ready(next, progress);
      await jobs.engine.command(next, "list");
      next.pack!.status = "verified";
    } catch (e) {
      next.pack!.status = "failed";
      next.pack!.log = await jobs.engine
        .logs(next)
        .catch(() => "Logs unavailable");
      await jobs.engine.stop(next);
      jobs.store.save(next);
      throw new Error(
        `Installed, but startup failed. Open Console or roll back. ${(e as Error).message}`,
      );
    }
    jobs.store.save(next);
  }
}
