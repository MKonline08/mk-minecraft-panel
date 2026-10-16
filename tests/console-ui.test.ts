import { test } from "node:test";
import assert from "node:assert/strict";
import { boundLines, collapseTelemetry } from "../src/backup-console.js";
test("console retains at most 2000 lines or 1 MB and preserves errors and manual output", () => {
  assert.equal(boundLines(Array(3000).fill("same")).length, 2000);
  const lines = boundLines(Array(2000).fill("§".repeat(1024)));
  assert.ok(Buffer.byteLength(lines.join("\n")) <= 1024 * 1024);
  const telemetry =
    "[RCON Client /127.0.0.1/INFO]: There are 0 of a max of 20 players online:";
  const raw = [
    telemetry,
    telemetry,
    "[Server thread/ERROR]: Bad",
    "[Command response] There are 0 of a max of 20 players online:",
    "same",
    "same",
  ];
  assert.equal(collapseTelemetry(raw, false).hidden, 1);
  assert.deepEqual(
    collapseTelemetry(raw, false).visible.slice(-4),
    raw.slice(-4),
  );
  assert.deepEqual(collapseTelemetry(raw, true).visible, raw);
});
