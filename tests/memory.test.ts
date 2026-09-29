import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../server/docker.js";
import type { Server } from "../server/core.js";

test("RAM check accepts a small laptop even when other containers reserve large limits", async () => {
  const engine = new Engine("/tmp/mk-memory-test", "/tmp/mk-memory-test");
  engine.system = async () => ({
    cpus: 2,
    memory: 3 * 1024 ** 3,
    architecture: "x86_64",
  });
  engine.docker.listContainers = async () => {
    throw new Error("Docker reservations must not be summed");
  };
  const server = { memory: 2 } as Server;
  await engine.capacity(server);
  engine.system = async () => ({
    cpus: 2,
    memory: 2 * 1024 ** 3,
    architecture: "x86_64",
  });
  await assert.rejects(engine.capacity(server), /lower Server memory/);
});
