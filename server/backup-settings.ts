import { z } from "zod";
import type { Server } from "./core.js";

export const scheduleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("interval") }),
  z.object({ mode: z.literal("disabled") }),
  z.object({
    mode: z.enum(["daily", "weekly"]),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    timezone: z
      .string()
      .max(100)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, "Choose a valid IANA timezone"),
    weekday: z.number().int().min(0).max(6).default(0),
  }),
]);
const message = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[^\r\n\x00]+$/);
export const announcementSchema = z.object({
  enabled: z.boolean().default(true),
  warnings: z
    .array(z.number().int().min(10).max(86400))
    .max(10)
    .default([300, 60, 10]),
  warning: message.default(
    "[Backup] {server} backs up in {remaining}. You will need to reconnect.",
  ),
  shutdown: message.default(
    "[Backup] Saving {server} now. Please reconnect after the server restarts.",
  ),
  complete: message.default(
    "[Backup] {server} backup complete ({duration}). Welcome back!",
  ),
  failure: message.default(
    "[Backup] {server} backup failed. Please check the panel.",
  ),
});
export type BackupSchedule = z.infer<typeof scheduleSchema>;
export type Announcements = z.infer<typeof announcementSchema>;
export function announcements(s: Server): Announcements {
  return announcementSchema.parse(s.announcements ?? {});
}
export function renderAnnouncement(
  template: string,
  name: string,
  remaining = 0,
  duration = 0,
) {
  const time = (seconds: number) =>
    seconds >= 60
      ? `${Math.ceil(seconds / 60)} minute(s)`
      : `${Math.ceil(seconds)} seconds`;
  return template.replace(
    /\{(server|remaining|duration)\}/g,
    (_, key: string) =>
      ({
        server: name.replace(/[\r\n\x00]/g, " "),
        remaining: time(remaining),
        duration: time(duration),
      })[key]!,
  );
}

// Find the first valid local minute at/after the requested time on each date.
// Enumerating UTC minutes naturally handles missing minutes and selects only
// the first occurrence of a repeated local time. Called only when due time changes.
export function nextCalendar(
  schedule: BackupSchedule,
  after: number,
): number | null {
  if (schedule.mode !== "daily" && schedule.mode !== "weekly") return null;
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const dates = new Set<string>();
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const start = Math.floor(after / 60000) * 60000 - 36 * 3600000;
  for (let t = start; t <= after + 9 * 86400000; t += 60000) {
    const parts = Object.fromEntries(
      format.formatToParts(t).map((p) => [p.type, p.value]),
    );
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (dates.has(date) || `${parts.hour}:${parts.minute}` < schedule.time)
      continue;
    dates.add(date);
    if (
      t > after &&
      (schedule.mode === "daily" ||
        weekdays[schedule.weekday] === parts.weekday)
    )
      return t;
  }
  throw new Error("Could not calculate next backup time");
}
export function nextBackup(s: Server, now = Date.now()): number | null {
  const schedule = s.backupSchedule ?? { mode: "interval" };
  if (schedule.mode === "disabled") return null;
  if (schedule.mode === "interval")
    return s.backupHours
      ? Date.parse(s.lastBackup || s.created) + s.backupHours * 3600000
      : null;
  return s.nextBackupAt
    ? Date.parse(s.nextBackupAt)
    : nextCalendar(schedule, now);
}
