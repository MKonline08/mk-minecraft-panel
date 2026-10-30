import { ImportPanel } from "./imports.js";
import React, { useEffect, useRef, useState, useId } from "react";
import { api, send, useLoad } from "./api.js";
import { BackupDelete } from "./enhancements.js";
import {
  announcementSchema,
  renderAnnouncement,
  type BackupSchedule,
  type Announcements,
} from "../server/backup-settings.js";

type Props = {
  s: any;
  act: (fn: () => Promise<any>, message?: string) => Promise<any>;
  working: boolean;
};
const size = (n?: number | null) =>
  n == null ? "Unavailable" : `${(n / 1024 ** 2).toFixed(1)} MB`;
const duration = (start?: string, finish?: string) =>
  start
    ? `${Math.max(0, Math.floor(((finish ? Date.parse(finish) : Date.now()) - Date.parse(start)) / 1000))}s`
    : "—";
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {React.Children.map(children, (child) =>
        React.isValidElement(child) &&
        ["input", "select", "textarea"].includes(String(child.type))
          ? React.cloneElement(child as React.ReactElement<any>, { id })
          : child,
      )}
    </div>
  );
}
export function boundLines(lines: string[]) {
  let bytes = 0,
    start = lines.length;
  const encoder = new TextEncoder();
  while (start > 0 && lines.length - start < 2000) {
    const next = encoder.encode(lines[start - 1]).length + 1;
    if (bytes + next > 1024 * 1024) break;
    bytes += next;
    start--;
  }
  return lines.slice(start);
}
export function collapseTelemetry(lines: string[], reveal: boolean) {
  const seen = new Set<string>();
  let hidden = 0;
  const visible = lines.filter((line) => {
    const match =
      /^.*\[(?:RCON Client[^\]]*|Server thread)\/INFO\](?::| \[[^\]]*\]:)\s*(There are \d+ of a max of \d+ players online:.*)$/.exec(
        line,
      );
    if (!match || reveal) return true;
    if (seen.has(match[1])) {
      hidden++;
      return false;
    }
    seen.add(match[1]);
    return true;
  });
  return { visible, hidden };
}
export function Console({ s, act, working }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [reveal, setReveal] = useState(false);
  const [auto, setAuto] = useState(true);
  const [search, setSearch] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unread, setUnread] = useState(0);
  const cursor = useRef("start");
  const output = useRef<HTMLPreElement>(null);
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const inflight = useRef(false);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    cursor.current = "start";
    setLines([]);
    setUnread(0);
  }, [s.id]);
  useEffect(() => {
    if (paused || !visible) return;
    let disposed = false;
    const controller = new AbortController();
    const poll = async () => {
      if (inflight.current) return;
      inflight.current = true;
      try {
        const data = await api(
          `/servers/${s.id}/logs?cursor=${encodeURIComponent(cursor.current)}`,
          { signal: controller.signal },
        );
        if (disposed) return;
        const added = data.lines
          ? data.lines.map((l: any) => l.text)
          : (data.text || "").split("\n").filter(Boolean);
        cursor.current = data.cursor || cursor.current;
        setLines((old) => boundLines([...(data.reset ? [] : old), ...added]));
        if (!autoRef.current) setUnread((n) => n + added.length);
        setNotice(
          data.truncated
            ? "Output exceeded the retrieval window. Older lines remain in the server logs."
            : "",
        );
        setError("");
      } catch (e: any) {
        if (!disposed && e.name !== "AbortError") setError(e.message);
      } finally {
        inflight.current = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 4000);
    return () => {
      disposed = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [s.id, paused, visible]);
  useEffect(() => {
    if (auto && output.current) {
      output.current.scrollTop = output.current.scrollHeight;
      setUnread(0);
    }
  }, [lines, auto]);
  const collapsed = collapseTelemetry(lines, reveal);
  const shown = collapsed.visible.filter((l) =>
    l.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="panel">
      <div className="section-heading">
        <h2>Live console</h2>
        <span className="muted">
          {paused ? "Paused" : "New output every 4 seconds"}
        </span>
      </div>
      <div className="console-controls">
        <button onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume console" : "Pause console"}
        </button>
        <button
          onClick={() => {
            setLines([]);
            setUnread(0);
          }}
        >
          Clear display
        </button>
        <label>
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />{" "}
          Auto-scroll
        </label>
        <label>
          <input
            type="checkbox"
            checked={reveal}
            onChange={(e) => setReveal(e.target.checked)}
          />{" "}
          Show repeated player checks
        </label>
        <input
          aria-label="Search console"
          placeholder="Search output"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {collapsed.hidden > 0 && (
        <p className="muted">
          {collapsed.hidden} repeated player checks collapsed. Raw server logs
          are preserved.
        </p>
      )}
      {unread > 0 && (
        <button onClick={() => setAuto(true)}>
          {unread} new lines · Jump to latest
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <pre ref={output} className="console" aria-label="Minecraft output">
        {shown.join("\n") || "Waiting for server output…"}
      </pre>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const text = command;
          const result = await act(
            () => send(`/servers/${s.id}/command`, { command: text }),
            "Command sent",
          );
          if (result) {
            setLines((old) =>
              boundLines([
                ...old,
                `> ${text}`,
                ...result.text
                  .split("\n")
                  .map((l: string) => `[Command response] ${l}`),
              ]),
            );
            setCommand("");
          }
        }}
      >
        <span className="prompt">&gt;</span>
        <input
          aria-label="Server command"
          placeholder="Enter a Minecraft command, e.g. list"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <button className="primary" disabled={working || !command.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

export function Backups({ s, act, working }: Props) {
  const base = `/servers/${s.id}`;
  const list = useLoad<any[]>(() => api(base + "/backups"), [s.id], 5000);
  const storage = useLoad<any>(() => api(base + "/storage"), [s.id], 15000);
  const jobs = useLoad<any[]>(() => api("/jobs"), [s.id], 1000);
  const current = useLoad<any>(() => api(base), [s.id], 5000);
  const [hours, setHours] = useState(s.backupHours);
  const [retention, setRetention] = useState(s.retention);
  const [schedule, setSchedule] = useState<BackupSchedule>(
    s.backupSchedule || { mode: "interval" },
  );
  const [calendar, setCalendar] = useState({
    time: "03:00",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    weekday: 0,
    ...(s.backupSchedule?.mode === "daily" ||
    s.backupSchedule?.mode === "weekly"
      ? s.backupSchedule
      : {}),
  });
  const [messages, setMessages] = useState<Announcements>(
    announcementSchema.parse(s.announcements ?? {}),
  );
  const [warningText, setWarningText] = useState(messages.warnings.join(", "));
  const [restore, setRestore] = useState<string | null>(null);
  const [preview, setPreview] = useState<
    "warning" | "shutdown" | "complete" | "failure"
  >("warning");
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const job = jobs.data?.find(
    (j) => j.serverId === s.id && j.kind === "backup",
  );
  const countdown =
    job?.stage === "countdown" && ["queued", "running"].includes(job.status)
      ? Math.max(0, Math.ceil((job.payload.dueAt - clock) / 1000))
      : null;
  const canEdit = !working || countdown !== null;
  const configured = {
    ...messages,
    warnings: warningText
      .split(",")
      .map((v) => Number(v.trim()))
      .filter(Boolean),
  };
  return (
    <div className="panel backups-panel">
      <ImportPanel s={s as any} act={act} working={working} kind="backup" />
      <div className="section-heading">
        <h2>Backups &amp; restore</h2>
        <button
          className="primary"
          disabled={working}
          onClick={() =>
            act(
              () => send(base + "/actions", { action: "backup" }),
              "Backup scheduled",
            )
          }
        >
          Back up now
        </button>
      </div>
      <p className="muted">
        Backups stop Minecraft for consistency and restart it if it was running.
        Players must reconnect. Restoring first creates a safety backup and
        leaves the server stopped.
      </p>
      <div className="backup-summary">
        <div>
          <strong>Next backup</strong>
          <p>
            {current.data?.nextBackupAt
              ? new Date(current.data.nextBackupAt).toLocaleString()
              : "Manual only"}
          </p>
        </div>
        <div>
          <strong>Storage</strong>
          <p>
            Backups: {size(storage.data?.backupBytes)} · Server:{" "}
            {size(storage.data?.serverBytes)} · Free:{" "}
            {size(storage.data?.diskFree)}
          </p>
        </div>
      </div>
      {job && (
        <div className="notice" role="status">
          <strong>
            {countdown !== null ? `Backup in ${countdown}s` : job.message}
          </strong>
          <p>
            {job.status} · Duration: {duration(job.startedAt, job.finishedAt)}
            {job.bytesProcessed != null &&
              ` · Verified ${size(job.bytesProcessed)} of ${size(job.totalBytes)}`}
            {job.archiveSize != null && ` · Archive ${size(job.archiveSize)}`}
          </p>
          {job.error && <p>{job.error}</p>}
          {job.recovery?.error && <p>Restart: {job.recovery.error}</p>}
          {job.announcementEvents?.some((e: any) => e.status === "failed") && (
            <p>
              Some announcements could not be sent. Open activity details below.
            </p>
          )}
          <details>
            <summary>Activity details</summary>
            {job.announcementEvents?.map((e: any) => (
              <p key={e.key}>
                {e.key}: {e.status}
                {e.error ? ` — ${e.error}` : ""}
              </p>
            ))}
          </details>
        </div>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const value =
            schedule.mode === "daily" || schedule.mode === "weekly"
              ? { ...calendar, mode: schedule.mode }
              : schedule;
          const result = await act(
            () =>
              send(
                base + "/backups",
                {
                  backupHours: hours,
                  retention,
                  backupSchedule: value,
                  announcements: configured,
                },
                "PUT",
              ),
            "Backup settings saved",
          );
          if (result) {
            void current.reload();
            void jobs.reload();
          }
        }}
      >
        <div className="form-grid">
          <Field label="Schedule">
            <select
              value={schedule.mode}
              onChange={(e) =>
                setSchedule(
                  e.target.value === "daily" || e.target.value === "weekly"
                    ? { ...calendar, mode: e.target.value }
                    : { mode: e.target.value as "interval" | "disabled" },
                )
              }
            >
              <option value="disabled">Manual only</option>
              <option value="interval">Every few hours</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </Field>
          {schedule.mode === "interval" && (
            <Field label="Automatic backups">
              <select value={hours} onChange={(e) => setHours(+e.target.value)}>
                <option value={0}>Manual only</option>
                {[
                  6,
                  12,
                  24,
                  48,
                  168,
                  ...(hours && ![6, 12, 24, 48, 168].includes(hours)
                    ? [hours]
                    : []),
                ].map((h) => (
                  <option key={h} value={h}>
                    Every {h} hours
                  </option>
                ))}
              </select>
            </Field>
          )}
          {(schedule.mode === "daily" || schedule.mode === "weekly") && (
            <>
              <Field label="Backup time">
                <input
                  type="time"
                  required
                  value={calendar.time}
                  onChange={(e) =>
                    setCalendar({ ...calendar, time: e.target.value })
                  }
                />
              </Field>
              <Field label="Timezone">
                <input
                  required
                  list="timezones"
                  value={calendar.timezone}
                  onChange={(e) =>
                    setCalendar({ ...calendar, timezone: e.target.value })
                  }
                />
                <datalist id="timezones">
                  {Intl.supportedValuesOf("timeZone").map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                  <option value="UTC" />
                </datalist>
              </Field>
              {schedule.mode === "weekly" && (
                <Field label="Day">
                  <select
                    value={calendar.weekday}
                    onChange={(e) =>
                      setCalendar({ ...calendar, weekday: +e.target.value })
                    }
                  >
                    {[
                      "Sunday",
                      "Monday",
                      "Tuesday",
                      "Wednesday",
                      "Thursday",
                      "Friday",
                      "Saturday",
                    ].map((day, i) => (
                      <option key={day} value={i}>
                        {day}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </>
          )}
          <Field label="Backups to keep">
            <input
              type="number"
              min={1}
              max={50}
              required
              value={retention}
              onChange={(e) => setRetention(+e.target.value)}
            />
          </Field>
        </div>
        <h3>In-game announcements</h3>
        <label>
          <input
            type="checkbox"
            checked={messages.enabled}
            onChange={(e) =>
              setMessages({ ...messages, enabled: e.target.checked })
            }
          />{" "}
          Announce backups in-game
        </label>
        <Field label="Warnings before scheduled backups (seconds, separated by commas)">
          <input
            value={warningText}
            onChange={(e) => setWarningText(e.target.value)}
            placeholder="300, 60, 10"
          />
        </Field>
        <p className="muted">
          Manual backups give a ten-second warning. Use {"{server}"},{" "}
          {"{remaining}"}, and {"{duration}"} in messages.
        </p>
        {(["warning", "shutdown", "complete", "failure"] as const).map(
          (kind) => (
            <Field
              key={kind}
              label={`${kind[0].toUpperCase() + kind.slice(1)} message`}
            >
              <input
                required
                maxLength={500}
                value={messages[kind]}
                onChange={(e) =>
                  setMessages({ ...messages, [kind]: e.target.value })
                }
              />
            </Field>
          ),
        )}
        <div className="announcement-preview">
          <Field label="Preview message">
            <select
              value={preview}
              onChange={(e) => setPreview(e.target.value as typeof preview)}
            >
              {["warning", "shutdown", "complete", "failure"].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
          <p>{renderAnnouncement(messages[preview], s.name, 300, 60)}</p>
          <button
            type="button"
            disabled={working}
            onClick={() =>
              act(
                () =>
                  send(base + "/backups/announce", {
                    kind: preview,
                    announcements: configured,
                  }),
                "Test announcement sent",
              )
            }
          >
            Send test announcement
          </button>
        </div>
        <button className="primary" disabled={!canEdit}>
          Save schedule
        </button>
      </form>
      {list.error && <p role="alert">{list.error}</p>}
      <div className="backup-list">
        {list.data?.map((b) => (
          <div className="list-row" key={b.name}>
            <div>
              <strong>{b.name}</strong>
              <small>
                {size(b.size)} ·{" "}
                {b.verification === "verified"
                  ? "Verified"
                  : "Verification unknown (older backup)"}
              </small>
            </div>
            <a
              className="button"
              href={`/api${base}/backup/${encodeURIComponent(b.name)}`}
              aria-label={`Download ${b.name}`}
            >
              Download
            </a>
            <button disabled={working} onClick={() => setRestore(b.name)}>
              Restore
            </button>
            <BackupDelete
              serverId={s.id}
              serverName={s.name}
              name={b.name}
              disabled={working}
              onDone={() => {
                void list.reload();
              }}
            />
          </div>
        ))}
        {!list.data?.length && <p>Your backups will appear here.</p>}
      </div>
      {restore && (
        <div className="notice" role="alert">
          <p>
            Restore <strong>{restore}</strong>? Current files will be backed up
            before replacement. The server will remain stopped for review.
          </p>
          <button
            className="primary"
            disabled={working}
            onClick={async () => {
              const r = await act(
                () => send(base + "/restore", { name: restore }),
                "Restore started",
              );
              if (r) setRestore(null);
            }}
          >
            Restore this backup
          </button>
          <button onClick={() => setRestore(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
