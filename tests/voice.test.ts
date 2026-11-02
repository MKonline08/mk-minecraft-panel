import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../server/docker.js";
import type { Server } from "../server/core.js";

test("voice port changes preserve files and require a stopped container", async () => {
  const engine = new Engine("/tmp/voice", "/tmp/voice");
  let removed = 0;
  let running = true;
  engine.container = async () =>
    ({
      inspect: async () => ({ State: { Running: running } }),
      remove: async () => {
        removed++;
      },
    }) as any;
  engine.docker.listContainers = async () => [];
  const s = { voicePort: undefined } as Server;
  await assert.rejects(engine.reconfigureVoice(s, 24454), /Stop the server/);
  assert.equal(removed, 0);
  running = false;
  engine.docker.listContainers = async () =>
    [{ Ports: [{ Type: "udp", PublicPort: 24454 }] }] as any;
  await assert.rejects(engine.reconfigureVoice(s, 24454), /already in use/);
  assert.equal(removed, 0);
  engine.docker.listContainers = async () => [];
  await engine.reconfigureVoice(s, 24454);
  assert.equal(removed, 1);
});

test("voice port publishes UDP separately from the Minecraft TCP port", async () => {
  const engine = new Engine("/tmp/voice", "/tmp/voice");
  engine.container = async () => null;
  engine.capacity = async () => {};
  engine.ensurePort = async () => {};
  engine.configure = async () => {};
  engine.password = async () => "test-password";
  (engine.docker as any).pull = async () => ({});
  engine.docker.modem.followProgress = (_stream: any, done: any) => done(null);
  let options: any;
  engine.docker.createContainer = async (value: any) => {
    options = value;
    return { start: async () => {} } as any;
  };
  const s = {
    id: "test",
    port: 25568,
    voicePort: 24455,
    memory: 2,
    type: "FORGE",
    version: "1.12.2",
    image: "test",
  } as Server;
  await engine.start(s, () => {});
  assert.deepEqual(options.HostConfig.PortBindings["24454/udp"], [
    { HostPort: "24455" },
  ]);
  assert.deepEqual(options.HostConfig.PortBindings["25565/tcp"], [
    { HostPort: "25568" },
  ]);
  assert.equal(options.HostConfig.Binds[0], "/tmp/voice/servers/test:/data");
  delete s.voicePort;
  await engine.start(s, () => {});
  assert.equal(options.HostConfig.PortBindings["24454/udp"], undefined);
});

