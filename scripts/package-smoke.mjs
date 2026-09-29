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
const { server } = await api("/servers", {
  name: "Package validation",
  type: "VANILLA",
  version: "1.21.1",
  memory: 1,
  eula: true,
  autoStart: false,
});
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
  const stop = await api(`/servers/${server.id}/actions`, { action: "stop" });
  let stopped = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const current = (await api("/jobs")).find((j) => j.id === stop.id);
    if (current.status === "failed") throw new Error(current.message);
    if (current.status === "done") { stopped = true; break; }
  }
  assert.ok(stopped, "Packaged server must stop before deletion");
  await api(`/servers/${server.id}`, { name: server.name }, "DELETE");
  deleted = true;
  assert.equal((await api("/servers")).some((s) => s.id === server.id), false);
  console.log(
    "PASS: packaged image creates, controls, stops and deletes a real Minecraft server through its authenticated API",
  );
} finally {
  if (!deleted)
    await api(`/servers/${server.id}/actions`, { action: "stop" }).catch(
      console.error,
    );
}
