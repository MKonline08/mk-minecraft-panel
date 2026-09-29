import assert from "node:assert/strict";
const base = "http://127.0.0.1:8088/api";
let cookie = "";
async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(base + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-MK-Request": "1",
      cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  return data;
}
await api("/auth/setup", {
  username: "package-test",
  password: "temporary-package-test-password",
});
const system = await api("/system");
assert.equal(system.docker, true);
assert.match(system.architecture, /amd64|x86_64/);
await api(
  "/workspace/settings",
  {
    name: "Package workspace",
    refreshSeconds: 5,
    defaultMemory: 1,
    defaultBackupHours: 0,
    defaultRetention: 7,
  },
  "PUT",
);
const { server } = await api("/servers", {
  name: "Package validation",
  type: "VANILLA",
  version: "1.21.1",
  eula: true,
  autoStart: false,
});
assert.equal(server.memory, 1);
assert.equal(server.retention, 7);
async function waitJob(job) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const current = (await api("/jobs")).find((j) => j.id === job.id);
    if (current?.status === "failed") throw new Error(current.message);
    if (current?.status === "done") return;
  }
  throw new Error("Operation did not complete: " + job.kind);
}
let deleted = false;
try {
  const job = await api(`/servers/${server.id}/actions`, { action: "start" });
  let completed = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const jobs = await api("/jobs");
    const current = jobs.find((j) => j.id === job.id);
    if (current.status === "failed") throw new Error(current.message);
    if (current.status === "done") {
      completed = true;
      break;
    }
  }
  assert.ok(completed, "Packaged server startup must complete");
  assert.equal((await api(`/servers/${server.id}`)).status, "running");
  const result = await api(`/servers/${server.id}/command`, {
    command: "list",
  });
  assert.match(result.text, /players|online/i);
  assert.ok((await api(`/servers/${server.id}/storage`)).serverBytes > 0);
  const players = await api(`/servers/${server.id}/players`);
  assert.equal(players.status, "ready");
  assert.equal(players.online.length, 0);
  await waitJob(
    await api(`/servers/${server.id}/actions`, { action: "backup" }),
  );
  const backups = await api(`/servers/${server.id}/backups`);
  assert.equal(backups.length, 1);
  await waitJob(
    await api(
      `/servers/${server.id}/backup/${encodeURIComponent(backups[0].name)}`,
      undefined,
      "DELETE",
    ),
  );
  assert.equal((await api(`/servers/${server.id}/backups`)).length, 0);
  assert.equal((await api(`/servers/${server.id}`)).status, "running");
  await waitJob(
    await api(`/servers/${server.id}`, { name: server.name }, "DELETE"),
  );
  deleted = true;
  assert.equal(
    (await api("/servers")).some((s) => s.id === server.id),
    false,
  );
  console.log(
    "PASS: packaged image applies defaults, reports players/storage, creates and deletes a backup, then stops and deletes a running server",
  );
} finally {
  if (!deleted)
    await api(`/servers/${server.id}/actions`, { action: "stop" }).catch(
      console.error,
    );
}
