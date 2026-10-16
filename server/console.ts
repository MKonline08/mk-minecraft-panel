export type LogLine = { timestamp: string; text: string };
type Cursor = { epoch: string; timestamp: string; count: number };
export function logPage(text: string, epoch: string, encoded: string) {
  let previous: Cursor | undefined;
  if (encoded !== "start") {
    try {
      previous = JSON.parse(Buffer.from(encoded, "base64url").toString());
      if (
        !previous ||
        typeof previous.epoch !== "string" ||
        !/^\d{4}-\d\d-\d\dT.*Z$/.test(previous.timestamp) ||
        !Number.isSafeInteger(previous.count) ||
        previous.count < 0
      )
        throw new Error();
    } catch {
      throw new Error("Invalid console cursor");
    }
  }
  const lines: LogLine[] = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d{4}-\d\d-\d\dT\S+Z) (.*)$/.exec(line);
      return match
        ? { timestamp: match[1], text: match[2] }
        : { timestamp: "", text: line };
    })
    .filter((line) => line.timestamp);
  const reset = !previous || previous.epoch !== epoch;
  const counts = new Map<string, number>();
  const fresh = lines.filter((line) => {
    const count = (counts.get(line.timestamp) ?? 0) + 1;
    counts.set(line.timestamp, count);
    return (
      reset ||
      line.timestamp > previous!.timestamp ||
      (line.timestamp === previous!.timestamp && count > previous!.count)
    );
  });
  const last = lines.at(-1);
  const cursor: Cursor = last
    ? { epoch, timestamp: last.timestamp, count: counts.get(last.timestamp)! }
    : previous?.epoch === epoch
      ? previous
      : { epoch, timestamp: "1970-01-01T00:00:00.000000000Z", count: 0 };
  return {
    text: fresh.map((l) => l.text).join("\n"),
    lines: fresh,
    cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
    reset,
    truncated: lines.length >= 2000,
  };
}
export function cursorSince(encoded: string) {
  if (encoded === "start") return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString());
    const timestamp = Date.parse(value.timestamp);
    if (!Number.isFinite(timestamp)) throw new Error();
    return Math.max(0, Math.floor(timestamp / 1000) - 1);
  } catch {
    throw new Error("Invalid console cursor");
  }
}
