import React, { useEffect, useState } from "react";
import {
  Archive,
  Blocks,
  Globe,
  HardDrive,
  MemoryStick,
  Search,
  Trash2,
  Users,
  X,
  Download,
} from "lucide-react";

async function request(
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "PUT",
) {
  const response = await fetch("/api" + url, {
    method,
    headers: {
      "X-MK-Request": "1",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Request failed");
  return value;
}
function useResource(url: string, interval = 5000) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true,
      busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const value = await request(url);
        if (alive) {
          setData(value);
          setError("");
        }
      } catch (e: any) {
        if (alive) setError(e.message);
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(load, interval);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [url, interval, revision]);
  return { data, error, reload: () => setRevision((v) => v + 1) };
}
export const bytes = (n: number | undefined | null) =>
  n == null
    ? "Unavailable"
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : `${(n / 1024 ** 3).toFixed(2)} GB`;
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Unknown";
function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p className="notice error" role="alert">
      {children}
    </p>
  );
}

function PixelAvatar({ identity }: { identity: string }) {
  let hash = 2166136261;
  for (const char of identity)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return (
    <svg
      className="pixel-avatar"
      viewBox="0 0 8 8"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <rect width="8" height="8" fill={`hsl(${hash % 360} 40% 20%)`} />
      <rect
        x="1"
        y="1"
        width="6"
        height="6"
        fill={`hsl(${hash % 360} 65% 63%)`}
      />
      <path d="M1 1h6v2H5V2H3v1H1z" fill={`hsl(${hash % 360} 50% 32%)`} />
      <path d="M2 4h1v1H2zm3 0h1v1H5zM3 6h2v1H3z" fill="#101829" />
    </svg>
  );
}
export function PlayerRoster({ data, error }: { data: any; error?: string }) {
  const [query, setQuery] = useState("");
  const available = data?.status === "ready" && !error;
  const onlineIds = new Set(
    (available ? data.online : []).map((p: any) => p.id),
  );
  const matches = (p: any) =>
    (p.name || p.uuid || "").toLowerCase().includes(query.toLowerCase());
  const history = [...(data?.history || [])].sort(
    (a, b) =>
      (b.lastSeen || "").localeCompare(a.lastSeen || "") ||
      (a.name || a.id).localeCompare(b.name || b.id),
  );
  const card = (p: any, live: boolean) => (
    <article className="player-card" key={p.id}>
      <PixelAvatar identity={p.uuid || p.name || p.id} />
      <div>
        <strong>{p.name || `Player ${p.uuid?.slice(0, 8)}`}</strong>
        <span className={live ? "player-status online" : "player-status"}>
          {live
            ? "Online now"
            : available || data?.status === "stopped"
              ? "Offline"
              : "Status unavailable"}
        </span>
        {!live && <small>Last seen: {date(p.lastSeen)}</small>}
        <small>First observed: {date(p.firstObserved)}</small>
      </div>
    </article>
  );
  return (
    <div className="player-roster">
      <div className="section-heading">
        <div>
          <h2>
            <Users size={22} /> Player activity
          </h2>
          <p className="muted">
            {data?.updatedAt
              ? `Updated ${date(data.updatedAt)}`
              : "Checking players…"}
          </p>
        </div>
        <label className="content-search">
          <Search size={16} />
          <input
            aria-label="Search players"
            placeholder="Find a player…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {(error || (data?.status === "unavailable" && data?.error)) && (
        <ErrorText>{error || data.error}</ErrorText>
      )}
      <section className="player-section">
        <h3>
          Online now{" "}
          <span className="count">
            {available
              ? data.online.length
              : data?.status === "stopped"
                ? 0
                : "—"}
          </span>
        </h3>
        <div className="player-grid">
          {available &&
            data.online.filter(matches).map((p: any) => card(p, true))}
        </div>
        {!available ? (
          <p className="muted">
            {data?.status === "stopped"
              ? "Server is stopped."
              : "Live player information is unavailable."}
          </p>
        ) : (
          !data.online.filter(matches).length && (
            <p className="muted">
              {query
                ? "No matching online players."
                : "Nobody is online right now."}
            </p>
          )
        )}
      </section>
      <section className="player-section">
        <h3>
          Everyone who has joined{" "}
          <span className="count">{history.length}</span>
        </h3>
        <p className="muted">
          Saved across panel restarts. Older players appear when records can be
          recovered; missing dates stay unknown.
        </p>
        {data?.historyWarning && <p className="muted">{data.historyWarning}</p>}
        <div className="player-grid">
          {history.filter(matches).map((p) => card(p, onlineIds.has(p.id)))}
        </div>
        {!history.filter(matches).length && (
          <p className="muted">
            {query
              ? "No players match this search."
              : "Players will appear here after joining."}
          </p>
        )}
      </section>
    </div>
  );
}
export function ServerResources({
  server,
  interval,
}: {
  server: any;
  interval: number;
}) {
  const storage = useResource(`/servers/${server.id}/storage`, interval);
  return (
    <section aria-label="Server resources">
      <div className="resource-grid">
        {[
          {
            title: "RAM in use",
            value:
              server.status === "unavailable"
                ? "Unavailable"
                : bytes(server.memory),
            icon: MemoryStick,
          },
          {
            title: "Configured RAM",
            value: `${server.memoryLimit} GB`,
            icon: MemoryStick,
          },
          {
            title: "Server files",
            value: bytes(storage.data?.serverBytes),
            icon: HardDrive,
          },
          {
            title: "Backups storage",
            value: bytes(storage.data?.backupBytes),
            icon: Archive,
          },
        ].map(({ title, value, icon: Icon }) => (
          <div className="resource-card" key={title}>
            <Icon size={22} />
            <small>{title}</small>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <p className="muted resource-note">
        {storage.error ||
          (storage.data
            ? `Storage measured ${date(storage.data.updatedAt)} · refreshed at least every 60 seconds while this page is open`
            : "Measuring storage…")}
      </p>
    </section>
  );
}
export function BackupDelete({
  serverId,
  serverName,
  name,
  disabled,
  onDone,
}: {
  serverId: string;
  serverName: string;
  name: string;
  disabled?: boolean;
  onDone: () => void;
}) {
  const [show, setShow] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <button
        className="danger-soft"
        disabled={disabled}
        aria-label={`Delete backup ${name} from ${serverName}`}
        onClick={() => {
          setShow(true);
          setError("");
        }}
      >
        <Trash2 size={16} /> Delete
      </button>
      {show && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="backup-delete-title"
          >
            <h2 id="backup-delete-title">Delete backup?</h2>
            <p>
              Permanently delete <strong>{name}</strong> from{" "}
              <strong>{serverName}</strong>? Your active world will stay in
              place.
            </p>
            {error && <ErrorText>{error}</ErrorText>}
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setShow(false)}>
                Cancel
              </button>
              <button
                className="danger-soft"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await request(
                      `/servers/${serverId}/backup/${encodeURIComponent(name)}`,
                      undefined,
                      "DELETE",
                    );
                    setShow(false);
                    onDone();
                  } catch (e: any) {
                    setError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Starting…" : "Delete this backup"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
export function WorkspaceContent({
  kind,
  servers,
  jobs,
  interval,
  open,
  changed,
}: {
  kind: "worlds" | "mods" | "backups";
  servers: any[];
  jobs: any[];
  interval: number;
  open: (server: any, tab: string) => void;
  changed: () => void;
}) {
  const content = useResource(`/workspace/content?kind=${kind}`, interval);
  const [query, setQuery] = useState(""),
    [serverId, setServerId] = useState("");
  const [restore, setRestore] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const title =
    kind === "worlds"
      ? "Worlds"
      : kind === "mods"
        ? "Mods & Plugins"
        : "Backups";
  const tab =
    kind === "worlds" ? "World" : kind === "mods" ? "Mods/Plugins" : "Backups";
  const Icon = kind === "worlds" ? Globe : kind === "mods" ? Blocks : Archive;
  const groups = (content.data?.groups || [])
    .filter((g: any) => !serverId || g.serverId === serverId)
    .map((g: any) => ({
      ...g,
      items: g.items.filter((item: any) =>
        `${g.serverName} ${item.name}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    }));
  const runningJob = (id: string) =>
    jobs.some(
      (j) => j.serverId === id && ["queued", "running"].includes(j.status),
    );
  return (
    <section className="workspace-content">
      <div className="content-toolbar">
        <label className="content-search">
          <Search size={17} />
          <input
            aria-label={`Search ${title}`}
            placeholder={`Search ${title.toLowerCase()}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="Filter by server"
          value={serverId}
          onChange={(e) => setServerId(e.target.value)}
        >
          <option value="">All servers</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {content.error && <ErrorText>{content.error}</ErrorText>}
      {!content.data && !content.error && (
        <p className="muted">Loading {title.toLowerCase()}…</p>
      )}
      {groups.map((g: any) => (
        <section className="panel content-group" key={g.serverId}>
          <div className="section-heading">
            <div>
              <h2>
                <Icon size={20} />
                {g.serverName}
              </h2>
              <span className="muted">
                {g.type} · {g.status} · {g.items.length}{" "}
                {kind === "worlds"
                  ? "world folders"
                  : kind === "mods"
                    ? "installed items"
                    : "backups"}
              </span>
            </div>
            <button
              disabled={runningJob(g.serverId)}
              onClick={() => {
                const s = servers.find((s) => s.id === g.serverId);
                if (s) open(s, tab);
              }}
            >
              {kind === "worlds"
                ? "Import / manage world"
                : kind === "mods"
                  ? "Install / upload"
                  : "Create / schedule backup"}
            </button>
          </div>
          {g.error && <ErrorText>{g.error}</ErrorText>}
          <div className="content-items">
            {g.items.map((item: any) => (
              <article className="content-item" key={item.name}>
                <Icon size={23} />
                <div className="content-details">
                  <strong>{item.name}</strong>
                  <small>
                    {g.serverName} · {bytes(item.bytes ?? item.size)}
                    {item.createdAt ? ` · ${date(item.createdAt)}` : ""}
                  </small>
                  {kind === "mods" && (
                    <div className="item-badges">
                      <span>{item.kind}</span>
                      <span>{item.enabled ? "Enabled" : "Disabled"}</span>
                      <span title={item.reasons?.join(" ")}>
                        {item.compatibility}
                      </span>
                    </div>
                  )}
                </div>
                {kind === "backups" && (
                  <div className="content-actions">
                    <a
                      className="button"
                      aria-label={`Download ${item.name}`}
                      href={`/api/servers/${g.serverId}/backup/${encodeURIComponent(item.name)}`}
                    >
                      <Download size={16} />
                    </a>
                    <button
                      disabled={runningJob(g.serverId)}
                      onClick={() => {
                        setRestore({
                          ...item,
                          serverId: g.serverId,
                          serverName: g.serverName,
                        });
                        setError("");
                      }}
                    >
                      Restore
                    </button>
                    <BackupDelete
                      serverId={g.serverId}
                      serverName={g.serverName}
                      name={item.name}
                      disabled={runningJob(g.serverId)}
                      onDone={() => {
                        content.reload();
                        changed();
                      }}
                    />
                  </div>
                )}
              </article>
            ))}
          </div>
          {!g.items.length && (
            <p className="muted">
              {query
                ? "No matches in this server."
                : kind === "mods" && g.type === "VANILLA"
                  ? "Vanilla does not support mods or plugins."
                  : kind === "worlds"
                    ? "No world generated yet. Start the server or import a world."
                    : kind === "mods"
                      ? "No mods or plugins installed."
                      : "No backups yet."}
            </p>
          )}
        </section>
      ))}
      {content.data && !groups.length && (
        <div className="panel">
          <p>
            No servers to show. Create a server to start managing its{" "}
            {title.toLowerCase()}.
          </p>
        </div>
      )}
      {restore && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-title"
          >
            <h2 id="restore-title">Restore backup to {restore.serverName}?</h2>
            <p>{restore.name}</p>
            <p>
              The current files will be backed up before replacement. The server
              will be left stopped.
            </p>
            {error && <ErrorText>{error}</ErrorText>}
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setRestore(null)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await request(
                      `/servers/${restore.serverId}/restore`,
                      { name: restore.name },
                      "POST",
                    );
                    setRestore(null);
                    changed();
                  } catch (e: any) {
                    setError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Restore this backup
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
export function WorkspaceSettings({
  settings,
  system,
  onSaved,
}: {
  settings: any;
  system: any;
  onSaved: () => void;
}) {
  const [values, setValues] = useState(settings);
  const [account, setAccount] = useState({
    username: settings.username || "",
    currentPassword: "",
    password: "",
  });
  const [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const save = async (accountChange = false) => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await request(
        accountChange ? "/account" : "/workspace/settings",
        accountChange
          ? { ...account, password: account.password || undefined }
          : values,
      );
      setMessage(
        accountChange
          ? "Account updated. Other sessions have been signed out."
          : "Workspace settings saved. Defaults apply to new servers.",
      );
      if (accountChange)
        setAccount({ ...account, currentPassword: "", password: "" });
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="workspace-settings">
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2>Workspace settings</h2>
        <div className="form-grid">
          <label className="enhanced-field">
            Workspace name
            <input
              value={values.name}
              maxLength={60}
              required
              onChange={(e) => setValues({ ...values, name: e.target.value })}
            />
          </label>
          <label className="enhanced-field">
            Refresh frequency
            <select
              value={values.refreshSeconds}
              onChange={(e) =>
                setValues({ ...values, refreshSeconds: +e.target.value })
              }
            >
              {[5, 15, 30].map((n) => (
                <option key={n} value={n}>
                  Every {n} seconds
                </option>
              ))}
            </select>
          </label>
          <label className="enhanced-field">
            Default RAM for new servers (GB)
            <input
              type="number"
              min={1}
              max={16}
              value={values.defaultMemory}
              required
              onChange={(e) =>
                setValues({ ...values, defaultMemory: +e.target.value })
              }
            />
          </label>
          <label className="enhanced-field">
            Default backup schedule
            <select
              value={values.defaultBackupHours}
              onChange={(e) =>
                setValues({ ...values, defaultBackupHours: +e.target.value })
              }
            >
              <option value={0}>Manual only</option>
              {[6, 12, 24, 48, 168].map((n) => (
                <option key={n} value={n}>
                  Every {n} hours
                </option>
              ))}
            </select>
          </label>
          <label className="enhanced-field">
            Default backups to keep
            <input
              type="number"
              min={1}
              max={50}
              required
              value={values.defaultRetention}
              onChange={(e) =>
                setValues({ ...values, defaultRetention: +e.target.value })
              }
            />
          </label>
        </div>
        <p className="muted">
          RAM and backup defaults apply only to servers you create afterward.
          Player history continues to update in the background.
        </p>
        <button className="primary" disabled={busy}>
          Save workspace settings
        </button>
      </form>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void save(true);
        }}
      >
        <h2>Administrator account</h2>
        <div className="form-grid">
          <label className="enhanced-field">
            Admin username
            <input
              autoComplete="username"
              minLength={3}
              maxLength={40}
              required
              value={account.username}
              onChange={(e) =>
                setAccount({ ...account, username: e.target.value })
              }
            />
          </label>
          <label className="enhanced-field">
            Current password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={account.currentPassword}
              onChange={(e) =>
                setAccount({ ...account, currentPassword: e.target.value })
              }
            />
          </label>
          <label className="enhanced-field">
            New password (optional)
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={200}
              value={account.password}
              onChange={(e) =>
                setAccount({ ...account, password: e.target.value })
              }
            />
          </label>
        </div>
        <button disabled={busy}>Update administrator</button>
      </form>
      <section className="panel">
        <h2>Host & updates</h2>
        <p className="muted">
          Architecture: {system?.architecture || "Unavailable"} · Host RAM:{" "}
          {bytes(system?.memory)} · Free host storage: {bytes(system?.diskFree)}
        </p>
        <p>
          Keep your existing CasaOS port and data folder when updating the panel
          image.
        </p>
        <a
          href="https://github.com/MKonline08/mk-minecraft-panel#installation-on-casaos"
          target="_blank"
          rel="noreferrer"
        >
          Installation & recovery guide
        </a>
      </section>
    </div>
  );
}
