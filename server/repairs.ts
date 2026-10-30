import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { contentFolder, noSymlinks, safeName, type Server } from "./core.js";
import { jarFiles } from "./archives.js";
import { USER_AGENT } from "./catalog.js";
import { resolveMods } from "./mods.js";
import {
  remote,
  remoteJSON,
  boundedWrite,
  checkHashes,
  diskSpace,
} from "./imports.js";
import { treeBytes } from "./trash.js";
import type { Jobs } from "./jobs.js";

export type Inventory = { name: string; hash: string; ids: string[] }[];
export type Proposal = {
  id: string;
  kind: "disable" | "update";
  title: string;
  files: { old?: string; name: string; hash?: string; url?: string }[];
  clientRequired: boolean;
};
export type Diagnosis = {
  id: string;
  serverId: string;
  created: string;
  runtime: string;
  inventory: Inventory;
  evidence: string[];
  explanation: string;
  proposals: Proposal[];
  warnings: string[];
};
export async function hashFile(file: string) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function inventory(root: string): Promise<Inventory> {
  const files = await fs.readdir(root).catch((e) => {
    if (e.code !== "ENOENT") throw e;
    return [];
  });
  const rows: Inventory = [];
  if (files.length > 5000)
    throw new Error("Too many installed files to diagnose");
  for (const name of files.filter((n) => n.endsWith(".jar")).sort()) {
    const file = await noSymlinks(root, name),
      stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("Expected a regular mod file");
    const ids: string[] = [];
    if (stat.size <= 100 * 1024 ** 2)
      try {
        const metadata = await jarFiles(await fs.readFile(file), [
          "fabric.mod.json",
          "META-INF/neoforge.mods.toml",
          "META-INF/mods.toml",
        ]);
        if (metadata["fabric.mod.json"])
          ids.push(JSON.parse(metadata["fabric.mod.json"]).id);
        for (const key of [
          "META-INF/neoforge.mods.toml",
          "META-INF/mods.toml",
        ]) {
          for (const section of (metadata[key] || "").split(/(?=^\s*\[)/m)) {
            if (/^\s*\[\[mods\]\]/.test(section)) {
              const id = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(section)?.[1];
              if (id) ids.push(id);
            }
          }
        }
      } catch {} // Unknown metadata never justifies removing a file.
    rows.push({ name, hash: await hashFile(file), ids });
  }
  return rows;
}
export function identifyFailure(log: string, rows: Inventory) {
  const lines = log.split(/\r?\n/);
  // Only explicit deferred-task blame or mandatory-dependency blame justifies a proposal.
  const blamed = [
    ...log.matchAll(
      /Mod ['"]([^'"]+)['"] encountered an error|Requested by:\s*'([^']+)'/g,
    ),
  ].map((m) => m[1] || m[2]);
  const matches = rows.filter((row) =>
    row.ids.some((id) => blamed.includes(id)),
  );
  if (matches.length !== 1)
    return {
      file: null,
      evidence: lines
        .filter((l) =>
          /FATAL|ERROR|OutOfMemoryError|requires .*version/i.test(l),
        )
        .slice(-12),
      explanation: /OutOfMemoryError|Cannot allocate memory/.test(log)
        ? "The log reports a memory failure. Mod changes are not a safe repair; review server and host memory."
        : "No single installed mod is conclusively identified. Review the full crash report; no automatic file changes are proposed.",
    };
  const file = matches[0];
  return {
    file,
    evidence: lines
      .filter(
        (l) =>
          blamed.some((id) => l.includes(id)) ||
          /Cannot get config value|Missing or unsupported mandatory/.test(l),
      )
      .slice(0, 10),
    explanation: `The startup log explicitly identifies ${file.name}. Disabling it is a diagnostic trial; other mods may depend on it. An available release is a compatibility candidate, not a guaranteed fix.`,
  };
}
export async function diagnose(jobs: Jobs, s: Server): Promise<Diagnosis> {
  const folder = await jobs.engine.file(s, contentFolder(s.type)),
    rows = await inventory(folder);
  const latest = await noSymlinks(jobs.engine.dir(s), "logs/latest.log");
  let log = "";
  try {
    const f = await fs.open(latest, "r");
    try {
      const st = await f.stat(),
        bytes = Math.min(st.size, 4 * 1024 ** 2),
        buffer = Buffer.alloc(bytes);
      await f.read(buffer, 0, bytes, st.size - bytes);
      log = buffer.toString("utf8");
    } finally {
      await f.close();
    }
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    log = await jobs.engine.logs(s);
  }
  const finding = identifyFailure(log, rows);
  const result: Diagnosis = {
    id: randomUUID(),
    serverId: s.id,
    created: new Date().toISOString(),
    runtime: JSON.stringify([s.type, s.version, s.loaderVersion]),
    inventory: rows,
    evidence: finding.evidence,
    explanation: finding.explanation,
    proposals: [],
    warnings: [],
  };
  if (finding.file) {
    const culprit = finding.file;
    result.proposals.push({
      id: "disable",
      kind: "disable",
      title: `Disable ${culprit.name}`,
      files: [{ old: culprit.name, name: culprit.name + ".disabled" }],
      clientRequired: false,
    });
    try {
      const response = await fetch(
        "https://api.modrinth.com/v2/version_files",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({
            hashes: rows.map((r) => r.hash),
            algorithm: "sha512",
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok)
        throw new Error(`Mod identification returned ${response.status}`);
      const versions = (await response.json()) as Record<string, any>,
        current = versions[culprit.hash];
      if (!current)
        throw new Error(
          "The implicated JAR is not identified by Modrinth. No verified update can be proposed.",
        );
      const updatedResponse = await fetch(
        `https://api.modrinth.com/v2/version_file/${culprit.hash}/update?algorithm=sha512`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({
            loaders: [s.type.toLowerCase()],
            game_versions: [s.version],
            version_types: ["release"],
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!updatedResponse.ok)
        throw new Error("No compatible release could be resolved");
      const updated = (await updatedResponse.json()) as any;
      if (updated.id === current.id)
        throw new Error(
          "The implicated mod already matches the latest compatible release.",
        );
      const items = await resolveMods(current.project_id, s, updated.id),
        changes: Proposal["files"] = [];
      const projectRows = new Map<string, typeof rows>();
      for (const row of rows) {
        const v = versions[row.hash];
        if (v)
          projectRows.set(v.project_id, [
            ...(projectRows.get(v.project_id) || []),
            row,
          ]);
      }
      const targetVersions = new Map(
        items.map((item) => [item.project, item.version]),
      );
      for (const version of Object.values(versions)) {
        const replacement = items.find(
          (item) => item.project === version.project_id,
        );
        const dependencies =
          replacement?.dependencies || version.dependencies || [];
        for (const dependency of dependencies) {
          if (
            dependency.dependency_type === "incompatible" &&
            (projectRows.has(dependency.project_id) ||
              targetVersions.has(dependency.project_id))
          )
            throw new Error(
              "A proposed update conflicts with an installed mod",
            );
          const target = targetVersions.get(dependency.project_id);
          if (
            dependency.dependency_type === "required" &&
            dependency.version_id &&
            target &&
            dependency.version_id !== target
          )
            throw new Error(
              "An installed mod requires a different dependency version. Manual review is required.",
            );
        }
      }
      for (const item of items) {
        const existing = projectRows.get(item.project) || [];
        if (existing.length > 1)
          throw new Error("Duplicate project versions require manual review");
        if (!existing.length && rows.some((r) => !versions[r.hash]))
          throw new Error(
            "An update needs dependencies, but some installed JARs cannot be identified. Resolve these manually to avoid duplicate mods.",
          );
        if (existing[0]?.hash === item.file.hashes.sha512) continue;
        changes.push({
          old: existing[0]?.name,
          name: safeName(item.file.filename),
          hash: item.file.hashes.sha512,
          url: item.file.url,
        });
      }
      if (changes.length)
        result.proposals.push({
          id: "update",
          kind: "update",
          title: `Try compatible release ${updated.version_number} and required dependencies`,
          files: changes,
          clientRequired: items.some((i) => i.clientRequired),
        });
    } catch (e) {
      result.warnings.push((e as Error).message);
    }
  }
  jobs.store.set(`diagnosis:${result.id}`, JSON.stringify(result));
  return result;
}
export async function rollbackRepair(
  jobs: Jobs,
  s: Server,
  progress: (m: string) => void,
) {
  const raw = jobs.store.get(`repair-rollback:${s.id}`);
  if (!raw) throw new Error("No repair rollback is available");
  const journal = JSON.parse(raw),
    previous = await noSymlinks(jobs.store.root, journal.previous),
    live = await jobs.engine.file(s, "");
  progress("Restoring the pre-repair server");
  await jobs.engine.stop(s);
  const marker = await noSymlinks(live, ".mk-repair-snapshot");
  if (!(await fs.stat(previous).catch(() => null))) {
    if (
      (await fs.readFile(marker, "utf8").catch(() => "")) !== journal.previous
    )
      throw new Error(
        "Recovery copy is missing; restore the recorded safety backup",
      );
  } else {
    journal.phase = "restoring";
    jobs.store.set(`repair-rollback:${s.id}`, JSON.stringify(journal));
    const failed = previous + "-failed-" + randomUUID();
    const hadLive = !!(await fs.stat(live).catch(() => null));
    if (hadLive) await fs.rename(live, failed);
    try {
      await fs.rename(previous, live);
    } catch (e) {
      if (hadLive) await fs.rename(failed, live);
      throw e;
    }
  }
  jobs.store.save({
    ...journal.server,
    lastBackup: jobs.store.server(s.id).lastBackup,
  });
  jobs.store.delete(`repair-rollback:${s.id}`);
  await fs.rm(marker, { force: true });
}
export async function repair(
  jobs: Jobs,
  s: Server,
  diagnosisId: string,
  proposalId: string,
  progress: (m: string) => void,
) {
  if (jobs.store.get(`repair-rollback:${s.id}`))
    throw new Error(
      "Keep or roll back the previous repair before trying another",
    );
  const raw = jobs.store.get(`diagnosis:${safeName(diagnosisId)}`);
  if (!raw) throw new Error("Run diagnosis again");
  const report: Diagnosis = JSON.parse(raw),
    proposal = report.proposals.find((p) => p.id === proposalId);
  if (
    report.serverId !== s.id ||
    !proposal ||
    report.runtime !== JSON.stringify([s.type, s.version, s.loaderVersion])
  )
    throw new Error("Repair does not match this server");
  if (s.recoveryRequired)
    throw new Error("Recover the interrupted operation first");
  const live = await jobs.engine.file(s, ""),
    folder = await jobs.engine.file(s, contentFolder(s.type));
  if (
    JSON.stringify(await inventory(folder)) !== JSON.stringify(report.inventory)
  )
    throw new Error("Installed files changed. Run diagnosis again.");
  const stage = await noSymlinks(
    jobs.store.root,
    `staging/repair-download-${randomUUID()}`,
  );
  await fs.mkdir(stage, { recursive: true });
  try {
    for (const file of proposal.files) {
      if (!file.name.endsWith(".jar") && proposal.kind === "update")
        throw new Error("Expected a JAR download");
      if (file.url) {
        progress(`Downloading verified ${file.name}`);
        const r = await remote(file.url);
        await boundedWrite(
          Readable.fromWeb(r.body as any),
          path.join(stage, file.name),
          100 * 1024 ** 2,
        );
        await checkHashes(path.join(stage, file.name), { sha512: file.hash! });
      }
      const dest = await noSymlinks(folder, file.name);
      if (file.old !== file.name && (await fs.stat(dest).catch(() => null)))
        throw new Error(`${file.name} already exists`);
    }
    await diskSpace(jobs.store.root, (await treeBytes(live)) * 3);
    await jobs.engine.stop(s);
    if (
      JSON.stringify(await inventory(folder)) !==
      JSON.stringify(report.inventory)
    )
      throw new Error("Installed files changed. Run diagnosis again.");
    progress("Creating a verified repair backup");
    const backup = await jobs.backup(s, progress, false);
    const previous = `staging/${s.id}-repair-${randomUUID()}`;
    await fs.mkdir(path.dirname(await noSymlinks(jobs.store.root, previous)), {
      recursive: true,
    });
    await fs.cp(live, await noSymlinks(jobs.store.root, previous), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        await noSymlinks(jobs.store.root, previous),
        ".mk-repair-snapshot",
      ),
      previous,
    );
    const journal = { previous, server: s, backup, phase: "applying" };
    jobs.store.set(`repair-rollback:${s.id}`, JSON.stringify(journal));
    jobs.store.save({ ...s, recoveryRequired: true });
    try {
      for (const file of proposal.files) {
        if (file.old)
          await fs.rename(
            await noSymlinks(folder, file.old),
            path.join(stage, file.old + ".original"),
          );
        if (proposal.kind === "disable")
          await fs.rename(
            path.join(stage, file.old + ".original"),
            await noSymlinks(folder, file.name),
          );
        else
          await fs.rename(
            path.join(stage, file.name),
            await noSymlinks(folder, file.name),
          );
      }
      // The old catalog manifest no longer describes the active JAR set.
      await fs.rm(await noSymlinks(folder, ".mk-modrinth.json"), {
        force: true,
      });
      jobs.store.save({ ...jobs.store.server(s.id), recoveryRequired: false });
      journal.phase = "verifying";
      jobs.store.set(`repair-rollback:${s.id}`, JSON.stringify(journal));
      progress("Checking repaired Minecraft startup");
      await jobs.engine.start(jobs.store.server(s.id), progress);
      await jobs.engine.ready(jobs.store.server(s.id), progress);
      await jobs.engine.command(s, "list");
      const verifiedServer = jobs.store.server(s.id);
      if (verifiedServer.pack) {
        verifiedServer.pack.status = "verified";
        delete verifiedServer.pack.log;
        jobs.store.save(verifiedServer);
      }
      journal.phase = "verified";
      jobs.store.set(`repair-rollback:${s.id}`, JSON.stringify(journal));
      jobs.store.set(
        `repair-result:${s.id}`,
        JSON.stringify({
          status: "verified",
          changes: proposal.files,
          backup,
          at: new Date().toISOString(),
        }),
      );
      progress("Repair verified. Minecraft is running.");
    } catch (e) {
      const logs = await jobs.engine.logs(s).catch(() => "");
      jobs.store.set(
        `repair-result:${s.id}`,
        JSON.stringify({
          status: "failed",
          error: (e as Error).message,
          logs,
          backup,
        }),
      );
      try {
        await rollbackRepair(jobs, jobs.store.server(s.id), progress);
      } catch (recovery) {
        jobs.store.save({ ...jobs.store.server(s.id), recoveryRequired: true });
        throw new Error(
          `Repair failed; recovery required: ${(recovery as Error).message}. Safety backup: ${backup}`,
        );
      }
      throw new Error(
        `Repair did not verify; original files restored and server stopped. ${(e as Error).message}`,
      );
    }
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
