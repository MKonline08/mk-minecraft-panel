import assert from "node:assert/strict";
import fs from "node:fs/promises";
const base = "http://127.0.0.1:8089/api";
const manifest = "/tmp/mk-upgrade-manifest.json";
const account = {
  username: "upgrade-check",
  password: "temporary-upgrade-check-password",
};
let cookie = "";
async function api(url, body, method = body ? "POST" : "GET") {
  const response = await fetch(base + url, {
    method,
    headers: {
      cookie,
      "X-MK-Request": "1",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  if (response.headers.get("set-cookie"))
    cookie = response.headers.get("set-cookie").split(";")[0];
  return value;
}
async function wait(job) {
  for (let i = 0; i < 60; i++) {
    const current = (await api("/jobs")).find((j) => j.id === job.id);
    if (current?.status === "failed") throw new Error(current.message);
    if (current?.status === "done") return current;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Upgrade backup did not finish");
}
if (process.argv[2] === "seed") {
  await api("/auth/setup", account);
  const { server } = await api("/servers", {
    name: "Existing CasaOS world",
    type: "VANILLA",
    version: "1.21.1",
    memory: 1,
    seed: "123",
    motd: "Keep this MOTD",
    eula: true,
    autoStart: false,
  });
  await api(
    `/servers/${server.id}/backups`,
    { backupHours: 24, retention: 5 },
    "PUT",
  );
  await api(`/servers/${server.id}/files/folder`, { path: "world" });
  await api(
    `/servers/${server.id}/file`,
    { path: "world/level.dat", text: "unchanged-world-fixture" },
    "PUT",
  );
  const backup = await wait(
    await api(`/servers/${server.id}/actions`, { action: "backup" }),
  );
  assert.equal(backup.status, "done");
  await fs.writeFile(
    manifest,
    JSON.stringify({
      id: server.id,
      image: server.image,
      backup: (await api(`/servers/${server.id}/backups`))[0].name,
    }),
  );
  console.log("Seeded populated v1.2.1 installation");
} else {
  const original = JSON.parse(await fs.readFile(manifest, "utf8"));
  assert.equal((await api("/health")).version, "1.5.1");
  await api("/auth/login", account);
  const s = await api(`/servers/${original.id}`);
  assert.equal(s.name, "Existing CasaOS world");
  assert.equal(s.image, original.image);
  assert.equal(s.motd, "Keep this MOTD");
  assert.equal(s.backupHours, 24);
  assert.equal(s.retention, 5);
  assert.equal(s.backupSchedule.mode, "interval");
  assert.equal(s.announcements.enabled, true);
  assert.equal(
    (await api(`/servers/${s.id}/file?path=world/level.dat`)).text,
    "unchanged-world-fixture",
  );
  const old = (await api(`/servers/${s.id}/backups`)).find(
    (b) => b.name === original.backup,
  );
  assert.ok(old);
  assert.ok(["unknown", "verified"].includes(old.verification));
  const job = await wait(
    await api(`/servers/${s.id}/actions`, { action: "backup" }),
  );
  assert.equal(job.verified, true);
  assert.equal(
    (await api(`/servers/${s.id}/backups`)).find((b) => b.name === job.archive)
      .verification,
    "verified",
  );
  await wait(await api(`/servers/${s.id}/restore`, { name: original.backup }));
  assert.equal(
    (await api(`/servers/${s.id}/file?path=world/level.dat`)).text,
    "unchanged-world-fixture",
  );
  assert.equal((await api(`/servers/${s.id}`)).status, "stopped");
  console.log(
    "PASS: v1.2.1 container update preserves account, registration, world, properties, backups and pinned Minecraft image; new backup and old restore work",
  );
}
