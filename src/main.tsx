import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  Server as ServerIcon,
  Globe,
  Blocks,
  Archive,
  Settings,
  Plus,
  Search,
  ChevronRight,
  ArrowLeft,
  Play,
  Square,
  RotateCw,
  Terminal,
  Users,
  HardDrive,
  Cpu,
  MemoryStick,
  Menu,
  X,
  LogOut,
  Upload,
  Copy,
  Check,
  AlertTriangle,
  Image,
  Folder,
  FileText,
  Download,
  RefreshCw,
  ChevronDown,
  ExternalLink,
  Palette,
  Shield,
  LoaderCircle,
} from "lucide-react";
import "./style.css";
type S = {
  id: string;
  name: string;
  type: string;
  version: string;
  status: string;
  memory: number;
  memoryLimit: number;
  cpu: number;
  port: number;
  java: number;
  motd: string;
  banner: boolean;
  icon: boolean;
  settings: any;
  backupHours: number;
  retention: number;
  lastBackup: string | null;
};
type J = {
  id: string;
  serverId: string;
  kind: string;
  status: string;
  message: string;
  created: string;
};
const pretty = (s: string) =>
  s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const gb = (n: number) => Number(n / 1024 ** 3).toFixed(1);
async function api(url: string, options: RequestInit = {}) {
  const r = await fetch("/api" + url, {
    ...options,
    headers: {
      "X-MK-Request": "1",
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
const send = (url: string, body?: unknown, method = "POST") =>
  api(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
function useLoad<T>(fn: () => Promise<T>, deps: any[], interval = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      const d = await fn();
      setData(d);
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, deps);
  useEffect(() => {
    setData(null);
    void reload();
    if (interval) {
      const id = setInterval(reload, interval);
      return () => clearInterval(id);
    }
  }, [reload, interval]);
  return { data, error, reload };
}
function Brand() {
  return (
    <div className="brand">
      <img src="/icon.svg" alt="MK" />
      <div>
        MK <span>Minecraft Panel</span>
      </div>
    </div>
  );
}
function Status({ status }: { status: string }) {
  return (
    <span className={"status " + status.replaceAll(" ", "-")}>
      <i />
      {pretty(status)}
    </span>
  );
}
function Empty({
  icon: Icon = ServerIcon,
  title,
  children,
}: {
  icon?: any;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Icon size={34} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Notice({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={"notice " + (error ? "error" : "")}
    >
      <AlertTriangle size={17} />
      <div>{children}</div>
    </div>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Landscape({ variant = 0 }: { variant?: number }) {
  return (
    <svg
      className={"landscape landscape-" + (variant % 3)}
      viewBox="0 0 700 230"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={"sky" + variant} x2="0" y2="1">
          <stop stopColor={["#173b68", "#302057", "#15455f"][variant % 3]} />
          <stop
            offset="1"
            stopColor={["#62899d", "#83459f", "#4b9b9d"][variant % 3]}
          />
        </linearGradient>
      </defs>
      <rect width="700" height="230" fill={"url(#sky" + variant + ")"} />
      <rect x="530" y="25" width="42" height="42" fill="#e7e7c5" opacity=".8" />
      <path
        d="M0 164H48V136H83V104H113V134H150V154H184V127H220V83H253V53H280V87H311V121H350V150H395V118H423V95H460V130H495V165H560V141H600V114H637V153H700V230H0Z"
        fill="#1b343b"
      />
      <path
        d="M0 192H78V170H127V192H197V156H250V179H303V204H370V170H410V142H449V177H513V196H586V169H650V191H700V230H0Z"
        fill="#10252f"
      />
      <g fill="#66b5aa" opacity=".3">
        <path d="M80 170h47v7H80zM197 156h53v7h-53zM410 142h39v7h-39zM586 169h64v7h-64z" />
      </g>
    </svg>
  );
}
function Motd({ text }: { text: string }) {
  const colors: Record<string, string> = {
    "0": "#000",
    "1": "#0000aa",
    "2": "#00aa00",
    "3": "#00aaaa",
    "4": "#aa0000",
    "5": "#aa00aa",
    "6": "#ffaa00",
    "7": "#aaa",
    "8": "#555",
    "9": "#5555ff",
    a: "#55ff55",
    b: "#55ffff",
    c: "#ff5555",
    d: "#ff55ff",
    e: "#ffff55",
    f: "#fff",
  };
  let color = "#aaa",
    bold = false;
  return (
    <span className="motd-text">
      {text.split(/(§[0-9a-fklmnor])/gi).map((part, i) => {
        if (part.startsWith("§")) {
          const c = part[1].toLowerCase();
          if (colors[c]) {
            color = colors[c];
            bold = false;
          } else if (c === "l") bold = true;
          else if (c === "r") {
            color = "#aaa";
            bold = false;
          }
          return null;
        }
        return (
          <span key={i} style={{ color, fontWeight: bold ? 700 : 400 }}>
            {part}
          </span>
        );
      })}
    </span>
  );
}
function Auth({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth">
      <div className="auth-glow" />
      <div className="auth-box">
        <Brand />
        <span className="eyebrow">YOUR WORLDS. YOUR RULES.</span>
        <h1>
          {setup
            ? "Your next adventure starts here."
            : "Welcome back, builder."}
        </h1>
        <p>
          {setup
            ? "Create your administrator account to start managing Minecraft on your CasaOS machine."
            : "Sign in to your MK Minecraft Panel."}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const f = new FormData(e.currentTarget);
            try {
              await send(
                "/auth/" + (setup ? "setup" : "login"),
                Object.fromEntries(f),
              );
              onDone();
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Username">
            <input
              name="username"
              autoComplete="username"
              required
              minLength={3}
            />
          </Field>
          <Field label="Password" hint="At least 12 characters.">
            <input
              name="password"
              type="password"
              autoComplete={setup ? "new-password" : "current-password"}
              minLength={12}
              required
            />
          </Field>
          {error && <Notice error>{error}</Notice>}
          <button className="primary wide" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <Shield size={18} />
            )}{" "}
            {setup ? "Create administrator" : "Sign in"}
          </button>
        </form>
        <small className="muted">
          Self-hosted on your machine. Built for your adventures.
        </small>
      </div>
    </div>
  );
}
function App() {
  const auth = useLoad<any>(() => api("/auth/status"), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [section, setSection] = useState("Dashboard");
  const [tab, setTab] = useState("Overview");
  const [creating, setCreating] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [failure, setFailure] = useState("");
  const [working, setWorking] = useState(false);
  const servers = useLoad<S[]>(
    () => (auth.data?.authenticated ? api("/servers") : Promise.resolve([])),
    [auth.data?.authenticated],
    5000,
  );
  const system = useLoad<any>(
    () => (auth.data?.authenticated ? api("/system") : Promise.resolve(null)),
    [auth.data?.authenticated],
    10000,
  );
  const jobs = useLoad<J[]>(
    () => (auth.data?.authenticated ? api("/jobs") : Promise.resolve([])),
    [auth.data?.authenticated],
    3000,
  );
  const notify = (s: string) => {
    setToast(s);
    setTimeout(() => setToast(""), 6000);
  };
  const act = async (fn: () => Promise<any>, message = "Saved") => {
    setWorking(true);
    setFailure("");
    try {
      const r = await fn();
      notify(message);
      await servers.reload();
      await jobs.reload();
      return r;
    } catch (e: any) {
      setFailure(e.message);
      return null;
    } finally {
      setWorking(false);
    }
  };
  if (!auth.data)
    return (
      <div className="loading">
        <Brand />
        {auth.error ? (
          <Notice error>{auth.error}</Notice>
        ) : (
          <LoaderCircle className="spin" />
        )}
      </div>
    );
  if (!auth.data.authenticated)
    return <Auth setup={auth.data.setup} onDone={auth.reload} />;
  const s = servers.data?.find((s) => s.id === selected);
  const activeJobs = (jobs.data || []).filter((j) =>
    ["queued", "running"].includes(j.status),
  );
  const serverJobs = (jobs.data || []).filter(
    (j) => !selected || j.serverId === selected,
  );
  const open = (s: S, t = "Overview") => {
    setSelected(s.id);
    setTab(t);
    setMobile(false);
    setFailure("");
  };
  const nav = (name: string) => {
    setSection(name);
    setSelected(null);
    setMobile(false);
    setFailure("");
  };
  return (
    <div className="app">
      <aside className={mobile ? "open" : ""}>
        <Brand />
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          {[
            [LayoutDashboard, "Dashboard"],
            [ServerIcon, "Servers"],
            [Globe, "Worlds"],
            [Blocks, "Mods & Plugins"],
            [Archive, "Backups"],
            [Settings, "Settings"],
          ].map(([Icon, name]: any) => (
            <button
              key={name}
              className={!selected && section === name ? "active" : ""}
              onClick={() => nav(name)}
            >
              <Icon size={19} />
              {name}
              {name === "Servers" && (
                <span className="count">{servers.data?.length || 0}</span>
              )}
            </button>
          ))}
        </nav>
        <button
          className="primary create-side"
          onClick={() => {
            setCreating(true);
            setMobile(false);
          }}
        >
          <Plus size={18} /> Create Server
        </button>
        <div className="sidebar-bottom">
          <div className="host-badge">
            <span className={"dot " + (system.data?.docker ? "green" : "")} />
            <div>
              CasaOS host
              <small>
                {system.data?.docker ? "Connected" : "Check connection"}
              </small>
            </div>
          </div>
          <button
            className="ghost"
            onClick={() =>
              act(async () => {
                await send("/auth/logout");
                await auth.reload();
              }, "Signed out")
            }
          >
            <LogOut size={17} /> Sign out
          </button>
          <small>
            MK PANEL <span>v1.0.0</span>
          </small>
        </div>
      </aside>
      <div className="main">
        <header>
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobile(!mobile)}
          >
            <Menu />
          </button>
          <div className="search">
            <Search size={18} />
            <input
              aria-label="Search servers"
              placeholder="Search your servers…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(null);
                setSection("Servers");
              }}
            />
            <kbd>/</kbd>
          </div>
          <span className="local-tag">
            <Shield size={14} /> Private workspace
          </span>
          <div className="avatar">MK</div>
        </header>
        <main>
          {failure && (
            <div className="dismiss">
              <Notice error>{failure}</Notice>
              <button aria-label="Dismiss error" onClick={() => setFailure("")}>
                <X size={17} />
              </button>
            </div>
          )}
          {servers.error && <Notice error>{servers.error}</Notice>}
          {system.data && !system.data.docker && (
            <Notice error>{system.data.error}</Notice>
          )}
          {s ? (
            <>
              <button className="back" onClick={() => setSelected(null)}>
                <ArrowLeft size={16} /> All servers
              </button>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR SERVER</div>
                  <h1>{s.name}</h1>
                  <p>
                    {pretty(s.type)} <span className="separator">/</span>{" "}
                    Minecraft {s.version} <span className="separator">/</span>{" "}
                    Java {s.java}
                  </p>
                </div>
                <Status status={s.status} />
              </div>
              <div className="tabs">
                {[
                  "Overview",
                  "Console",
                  "Players",
                  "Settings",
                  "World",
                  "Mods/Plugins",
                  "Files",
                  "Backups",
                  "Appearance",
                ].map((t) => (
                  <button
                    key={t}
                    className={t === tab ? "active" : ""}
                    onClick={() => {
                      setTab(t);
                      setFailure("");
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <ServerPage
                key={s.id + tab}
                s={s}
                tab={tab}
                act={act}
                working={working || activeJobs.some((j) => j.serverId === s.id)}
                notify={notify}
              />
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">LET’S BUILD SOMETHING GREAT</div>
                  <h1>{section}</h1>
                  <p>
                    {section === "Dashboard"
                      ? "Your worlds, all in one place."
                      : section === "Servers"
                        ? "A little home for every adventure."
                        : `Manage ${section.toLowerCase()} across your servers.`}
                  </p>
                </div>
                <button className="primary" onClick={() => setCreating(true)}>
                  <Plus size={18} /> Create Server
                </button>
              </div>
              {section === "Dashboard" && (
                <div className="stats">
                  <Stat
                    icon={Cpu}
                    label="SERVER CPU"
                    value={
                      system.data?.docker
                        ? `${Math.round(system.data.cpu)}%`
                        : "—"
                    }
                    detail={
                      system.data?.docker
                        ? `${system.data.cpus} host cores`
                        : "Host unavailable"
                    }
                    percent={system.data?.cpu || 0}
                  />
                  <Stat
                    icon={MemoryStick}
                    label="SERVER MEMORY"
                    value={
                      system.data?.docker
                        ? `${gb(system.data.usedMemory)} GB`
                        : "—"
                    }
                    detail={
                      system.data?.docker
                        ? `of ${gb(system.data.memory)} GB host RAM`
                        : "Host unavailable"
                    }
                    percent={
                      (system.data?.usedMemory / system.data?.memory) * 100 || 0
                    }
                  />
                  <Stat
                    icon={HardDrive}
                    label="STORAGE"
                    value={
                      system.data?.docker
                        ? `${gb(system.data.diskTotal - system.data.diskFree)} GB`
                        : "—"
                    }
                    detail={
                      system.data?.docker
                        ? `${gb(system.data.diskFree)} GB free`
                        : "Host unavailable"
                    }
                    percent={
                      (1 - system.data?.diskFree / system.data?.diskTotal) *
                        100 || 0
                    }
                  />
                </div>
              )}
              {section === "Settings" ? (
                <div className="panel prose">
                  <h2>
                    <Settings size={22} /> Workspace settings
                  </h2>
                  <p>
                    Server data is kept on your CasaOS host. Each Minecraft
                    server receives its own container, storage, and game port.
                  </p>
                  <dl>
                    <dt>Host architecture</dt>
                    <dd>{system.data?.architecture || "Unavailable"}</dd>
                    <dt>Assigned Minecraft memory</dt>
                    <dd>
                      {system.data?.allocated || 0} GB (servers may be stopped)
                    </dd>
                    <dt>Administration</dt>
                    <dd>One password-protected administrator</dd>
                    <dt>Updates</dt>
                    <dd>
                      Use a tagged release from GitHub; back up your panel
                      folder first.
                    </dd>
                  </dl>
                  <a
                    href="https://github.com/MKonline08/mk-minecraft-panel#installation-on-casaos"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Installation & recovery guide <ExternalLink size={14} />
                  </a>
                </div>
              ) : (
                <>
                  <div className="section-heading">
                    <h2>
                      {section === "Dashboard" ? "Your servers" : section}{" "}
                      <span>{servers.data?.length || 0}</span>
                    </h2>
                    <span className="muted">
                      {servers.data?.filter((s) => s.status === "running")
                        .length || 0}{" "}
                      running
                    </span>
                  </div>
                  <div className="server-grid">
                    {(servers.data || [])
                      .filter((s) =>
                        s.name.toLowerCase().includes(query.toLowerCase()),
                      )
                      .map((server, i) => (
                        <ServerCard
                          key={server.id}
                          s={server}
                          i={i}
                          open={() =>
                            open(
                              server,
                              section === "Worlds"
                                ? "World"
                                : section === "Mods & Plugins"
                                  ? "Mods/Plugins"
                                  : section === "Backups"
                                    ? "Backups"
                                    : "Overview",
                            )
                          }
                          busy={
                            working ||
                            activeJobs.some((j) => j.serverId === server.id)
                          }
                          action={(action) =>
                            act(
                              () =>
                                send(`/servers/${server.id}/actions`, {
                                  action,
                                }),
                              "Operation started",
                            )
                          }
                        />
                      ))}
                  </div>
                  {!servers.data?.length && (
                    <div className="panel">
                      <Empty
                        title="Make room for your first world"
                        icon={Globe}
                      >
                        Create a server, choose your Minecraft version, and let
                        MK handle the setup.
                      </Empty>
                      <button
                        className="primary center"
                        onClick={() => setCreating(true)}
                      >
                        <Plus size={18} /> Create your first server
                      </button>
                    </div>
                  )}
                  {!!servers.data?.length &&
                    query &&
                    !(servers.data || []).some((s) =>
                      s.name.toLowerCase().includes(query.toLowerCase()),
                    ) && (
                      <Empty title="No matching servers">
                        Try another name.
                      </Empty>
                    )}
                </>
              )}
            </>
          )}
          {!!serverJobs.length && (
            <section className="activity panel">
              <div className="section-heading">
                <h2>Recent activity</h2>
                <span className="muted">
                  {activeJobs.length
                    ? `${activeJobs.length} in progress`
                    : "All caught up"}
                </span>
              </div>
              {serverJobs.slice(0, 5).map((j) => (
                <div key={j.id} className={"activity-row " + j.status}>
                  {j.status === "running" || j.status === "queued" ? (
                    <LoaderCircle size={18} className="spin" />
                  ) : j.status === "done" ? (
                    <Check size={18} />
                  ) : (
                    <AlertTriangle size={18} />
                  )}
                  <div>
                    <strong>
                      {pretty(j.kind)} ·{" "}
                      {servers.data?.find((s) => s.id === j.serverId)?.name ||
                        "Server"}
                    </strong>
                    <small>{j.message}</small>
                  </div>
                  <span>{pretty(j.status)}</span>
                </div>
              ))}
            </section>
          )}
          <footer>
            Made for your next adventure. <span>MK Minecraft Panel</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
        </div>
      )}
      {creating && (
        <CreateModal
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await servers.reload();
            await jobs.reload();
            setSelected(id);
            setTab("Overview");
          }}
        />
      )}
    </div>
  );
}
function Stat({ icon: Icon, label, value, detail, percent }: any) {
  return (
    <div className="stat">
      <div className="stat-icon">
        <Icon size={25} />
      </div>
      <div className="stat-body">
        <small>{label}</small>
        <div className="stat-value">{value}</div>
        <div className="meter">
          <span style={{ width: Math.min(100, Math.max(0, percent)) + "%" }} />
        </div>
        <p>{detail}</p>
      </div>
    </div>
  );
}
function ServerCard({
  s,
  i,
  open,
  action,
  busy,
}: {
  s: S;
  i: number;
  open: () => void;
  action: (s: string) => void;
  busy: boolean;
}) {
  const running = ["running", "starting", "needs attention"].includes(s.status);
  return (
    <article className="server-card">
      <button className="card-art" onClick={open} aria-label={"Open " + s.name}>
        {s.banner ? (
          <img src={`/api/servers/${s.id}/image/banner`} alt="" />
        ) : (
          <Landscape variant={i} />
        )}
        <Status status={s.status} />
        <span className="card-open">
          <ChevronRight size={20} />
        </span>
      </button>
      <div className="card-body">
        <button className="card-title" onClick={open}>
          <span className={"cube cube-" + (i % 3)}>
            {s.icon ? (
              <img src={`/api/servers/${s.id}/image/icon`} alt="" />
            ) : (
              <Blocks size={24} />
            )}
          </span>
          <div>
            <h3>{s.name}</h3>
            <p>
              {s.version} <span>·</span> {pretty(s.type)}
            </p>
          </div>
        </button>
        <div className="card-metrics">
          <span>
            <MemoryStick size={15} /> Memory
          </span>
          <strong>
            {gb(s.memory)} <small>/ {s.memoryLimit} GB</small>
          </strong>
        </div>
        <div className="meter">
          <span
            style={{
              width:
                Math.min(100, (s.memory / (s.memoryLimit * 1024 ** 3)) * 100) +
                "%",
            }}
          />
        </div>
        <div className="card-metrics minor">
          <span>
            <Cpu size={15} /> CPU
          </span>
          <strong>{Math.round(s.cpu)}%</strong>
        </div>
        <div className="card-actions">
          <button onClick={open}>
            <Terminal size={17} /> Manage
          </button>
          <button
            disabled={busy || s.status === "unavailable"}
            className={running ? "danger-soft" : "success"}
            onClick={() => action(running ? "stop" : "start")}
          >
            {running ? <Square size={13} /> : <Play size={15} />}{" "}
            {running ? "Stop" : "Start"}
          </button>
        </div>
      </div>
    </article>
  );
}
function CreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [b, setB] = useState({
    name: "",
    type: "PAPER",
    version: "1.21.1",
    memory: 2,
    eula: false,
    seed: "",
    motd: "§bMK Minecraft §8• §dYour next adventure",
    autoStart: true,
  });
  const [world, setWorld] = useState<File | null>(null);
  const [project, setProject] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const catalog = useLoad<any>(() => api("/catalog"), []);
  const types = useLoad<any>(
    () => api("/catalog?version=" + b.version),
    [b.version],
  );
  const update = (key: string, value: any) => setB({ ...b, [key]: value });
  const wait = async (job: any) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const list: J[] = await api("/jobs");
      const current = list.find((j) => j.id === job.id);
      setProgress(current?.message || "Working…");
      if (current?.status === "done") return;
      if (current?.status === "failed") throw new Error(current.message);
    }
  };
  async function create() {
    setBusy(true);
    setError("");
    try {
      setProgress("Creating your server…");
      const r = await send("/servers", { ...b, autoStart: false });
      const id = r.server.id;
      setCreatedId(id);
      if (world) {
        setProgress("Uploading your world…");
        const f = new FormData();
        f.append("file", world);
        await wait(
          await api(`/servers/${id}/world`, { method: "POST", body: f }),
        );
      }
      if (project.trim())
        await wait(
          await send(`/servers/${id}/mods/install`, {
            project: project.trim(),
          }),
        );
      if (b.autoStart)
        await send(`/servers/${id}/actions`, { action: "start" });
      onCreated(id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-title"
        className="modal"
      >
        <div className="modal-top">
          <span className="eyebrow">A NEW ADVENTURE</span>
          <button
            disabled={busy}
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        <h1 id="create-title">Create your server</h1>
        <p>Pick your world. We’ll take care of the setup.</p>
        <div className="steps">
          {["Basics", "Software", "World & mods", "Review"].map((s, i) => (
            <div key={s} className={step >= i ? "done" : ""}>
              <span>{i + 1}</span>
              {s}
            </div>
          ))}
        </div>
        {error && <Notice error>{error}</Notice>}
        {catalog.error && <Notice error>{catalog.error}</Notice>}
        {step === 0 && (
          <>
            <Field label="Server name">
              <input
                placeholder="e.g. MK Survival"
                autoFocus
                value={b.name}
                maxLength={48}
                onChange={(e) => update("name", e.target.value)}
              />
            </Field>
            <Field
              label={`Minecraft memory: ${b.memory} GB`}
              hint="Allow extra memory for Debian, CasaOS, and other running servers."
            >
              <input
                type="range"
                min="1"
                max="16"
                value={b.memory}
                onChange={(e) => update("memory", +e.target.value)}
              />
            </Field>
          </>
        )}
        {step === 1 && (
          <>
            <Field label="Minecraft version">
              <select
                value={b.version}
                onChange={(e) => update("version", e.target.value)}
              >
                {!catalog.data?.versions?.includes(b.version) && (
                  <option>{b.version}</option>
                )}
                {catalog.data?.versions.map((v: string) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
            <Field label="Server software">
              <div className="type-grid">
                {(types.data?.types || []).map((t: any) => (
                  <button
                    type="button"
                    disabled={!t.available}
                    key={t.type}
                    className={b.type === t.type ? "selected" : ""}
                    onClick={() => update("type", t.type)}
                  >
                    <Blocks size={18} />
                    <strong>{pretty(t.type)}</strong>
                    <small>
                      {!t.available
                        ? "Unavailable"
                        : t.type === "VANILLA"
                          ? "Classic Minecraft"
                          : ["PAPER", "SPIGOT", "PURPUR"].includes(t.type)
                            ? "Plugins"
                            : "Mods"}
                    </small>
                  </button>
                ))}
              </div>
            </Field>
            {!types.data && (
              <p className="muted">Checking available versions…</p>
            )}
            <small className="muted">
              Java is selected automatically. A separate game port is assigned
              to each server.
            </small>
          </>
        )}
        {step === 2 && (
          <>
            <Field label="World seed (optional)">
              <input
                value={b.seed}
                onChange={(e) => update("seed", e.target.value)}
                placeholder="Leave blank for a fresh random world"
              />
            </Field>
            <Field
              label="Upload an existing world (optional)"
              hint="Java world ZIP, up to 2 GB. Leave empty to generate a new world."
            >
              <input
                type="file"
                accept=".zip"
                onChange={(e) => setWorld(e.target.files?.[0] || null)}
              />
            </Field>
            {b.type !== "VANILLA" && (
              <Field
                label="Modrinth project ID or slug (optional)"
                hint="Required dependencies are resolved automatically. More mods can be added from the server page."
              >
                <input
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  placeholder="e.g. fabric-api"
                />
              </Field>
            )}
          </>
        )}
        {step === 3 && (
          <>
            <div className="review">
              <h2>{b.name}</h2>
              <p>
                {pretty(b.type)} · Minecraft {b.version} · {b.memory} GB RAM
              </p>
              <p>
                {world ? world.name : "New generated world"}
                {project && ` · ${project}`}
              </p>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={b.autoStart}
                onChange={(e) => update("autoStart", e.target.checked)}
              />{" "}
              Start automatically after setup
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={b.eula}
                onChange={(e) => update("eula", e.target.checked)}
              />{" "}
              <span>
                I have read and accept the{" "}
                <a
                  href="https://www.minecraft.net/eula"
                  target="_blank"
                  rel="noreferrer"
                >
                  Minecraft EULA
                </a>
                .
              </span>
            </label>
            <Notice>
              First startup downloads Minecraft and generates your world. The
              panel will show progress and confirm when it is ready.
            </Notice>
          </>
        )}
        {busy && (
          <div className="progress">
            <LoaderCircle className="spin" size={18} />
            {progress}
          </div>
        )}
        <div className="modal-actions">
          {step > 0 && (
            <button
              disabled={busy || !!createdId}
              onClick={() => setStep(step - 1)}
            >
              Back
            </button>
          )}
          {createdId && !busy ? (
            <button className="primary" onClick={() => onCreated(createdId)}>
              Open created server
            </button>
          ) : step < 3 ? (
            <button
              className="primary"
              disabled={
                !b.name.trim() ||
                (step === 1 &&
                  !types.data?.types.some(
                    (t: any) => t.type === b.type && t.available,
                  ))
              }
              onClick={() => setStep(step + 1)}
            >
              Continue <ChevronRight size={17} />
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy || !b.eula}
              onClick={create}
            >
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <Plus size={18} />
              )}{" "}
              Create server
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
type PageProps = {
  s: S;
  tab: string;
  act: (fn: () => Promise<any>, message?: string) => Promise<any>;
  working: boolean;
  notify: (s: string) => void;
};
function ServerPage(p: PageProps) {
  const { s, tab, act, working, notify } = p;
  const base = "/servers/" + s.id;
  const running = ["running", "starting", "needs attention"].includes(s.status);
  if (tab === "Console") return <Console {...p} />;
  if (tab === "Appearance") return <Appearance {...p} />;
  if (tab === "Settings") return <ServerSettings {...p} />;
  if (tab === "World")
    return (
      <div className="panel prose">
        <h2>
          <Globe size={22} /> Your world
        </h2>
        <p>
          Upload a Java world ZIP containing <code>level.dat</code>. MK
          validates the archive, stops the server, and makes a backup before
          replacing your world. Existing Nether and End folders are included in
          that backup.
        </p>
        <UploadBox
          accept=".zip"
          disabled={working}
          label="Choose a world ZIP"
          action={async (f) => {
            const data = new FormData();
            data.append("file", f);
            await act(
              () => api(base + "/world", { method: "POST", body: data }),
              "World import started",
            );
          }}
        />
        <Notice>
          After importing, review your mods and start the server. Upload the
          complete world folder to preserve its dimensions.
        </Notice>
      </div>
    );
  if (tab === "Mods/Plugins") return <Mods {...p} />;
  if (tab === "Files") return <Files {...p} />;
  if (tab === "Backups") return <Backups {...p} />;
  if (tab === "Players") return <Players {...p} />;
  const address = window.location.hostname + ":" + s.port;
  return (
    <>
      <div className="overview-banner">
        {s.banner ? (
          <img src={"/api" + base + "/image/banner"} alt="Server banner" />
        ) : (
          <Landscape />
        )}
        <div>
          <span className="eyebrow">READY FOR YOUR NEXT CHAPTER</span>
          <h2>{s.name}</h2>
        </div>
      </div>
      <div className="two-col">
        <section className="panel">
          <h2>Server controls</h2>
          <p className="muted">Your world stays saved when the server stops.</p>
          <div className="button-row">
            <button
              className="success"
              disabled={working || running || s.status === "unavailable"}
              onClick={() =>
                act(
                  () => send(base + "/actions", { action: "start" }),
                  "Starting server",
                )
              }
            >
              <Play size={16} /> Start
            </button>
            <button
              disabled={working || !running}
              onClick={() =>
                act(
                  () => send(base + "/actions", { action: "restart" }),
                  "Restarting server",
                )
              }
            >
              <RotateCw size={16} /> Restart
            </button>
            <button
              className="danger-soft"
              disabled={working || !running}
              onClick={() =>
                act(
                  () => send(base + "/actions", { action: "stop" }),
                  "Stopping server",
                )
              }
            >
              <Square size={14} /> Stop
            </button>
          </div>
          <Field label="Join from your local network">
            <div className="copy-field">
              <code>{address}</code>
              <button
                aria-label="Copy server address"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(address);
                    notify("Address copied");
                  } catch {
                    notify("Select and copy the address shown above");
                  }
                }}
              >
                <Copy size={17} />
              </button>
            </div>
          </Field>
          <small className="muted">
            Use your CasaOS laptop’s LAN address when connecting from another
            device.
          </small>
        </section>
        <section className="panel">
          <h2>At a glance</h2>
          <dl>
            <dt>Server software</dt>
            <dd>
              {pretty(s.type)} {s.version}
            </dd>
            <dt>Memory</dt>
            <dd>
              {gb(s.memory)} / {s.memoryLimit} GB
            </dd>
            <dt>CPU</dt>
            <dd>{Math.round(s.cpu)}%</dd>
            <dt>Game port</dt>
            <dd>{s.port}</dd>
            <dt>Last backup</dt>
            <dd>
              {s.lastBackup
                ? new Date(s.lastBackup).toLocaleString()
                : "No backups yet"}
            </dd>
          </dl>
        </section>
      </div>
    </>
  );
}
function Console({ s, act, working }: PageProps) {
  const base = "/servers/" + s.id;
  const logs = useLoad<any>(() => api(base + "/logs"), [s.id], 4000);
  const [command, setCommand] = useState("");
  const [response, setResponse] = useState("");
  return (
    <div className="panel">
      <div className="section-heading">
        <h2>
          <Terminal size={20} /> Live console
        </h2>
        <span className="muted">Refreshes every 4 seconds</span>
      </div>
      {logs.error && <Notice error>{logs.error}</Notice>}
      <pre className="console">
        {logs.data?.text || "Waiting for server output…"}
        {response && "\n> " + response}
      </pre>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await act(
            () => send(base + "/command", { command }),
            "Command sent",
          );
          if (r) {
            setResponse(r.text);
            setCommand("");
            void logs.reload();
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
function ServerSettings({ s, act, working }: PageProps) {
  const [v, setV] = useState(s.settings);
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        void act(() => send("/servers/" + s.id + "/settings", v, "PUT"));
      }}
    >
      <h2>Gameplay settings</h2>
      <p className="muted">
        Stop the server before saving. Changes take effect on its next start.
      </p>
      <div className="form-grid">
        <Field label="Difficulty">
          <select
            value={v.difficulty}
            onChange={(e) => setV({ ...v, difficulty: e.target.value })}
          >
            {["peaceful", "easy", "normal", "hard"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Field>
        <Field label="Game mode">
          <select
            value={v.gamemode}
            onChange={(e) => setV({ ...v, gamemode: e.target.value })}
          >
            {["survival", "creative", "adventure", "spectator"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Field>
        <Field label="Maximum players">
          <input
            type="number"
            min="1"
            max="1000"
            value={v.maxPlayers}
            onChange={(e) => setV({ ...v, maxPlayers: +e.target.value })}
          />
        </Field>
        <Field label="View distance (chunks)">
          <input
            type="number"
            min="2"
            max="32"
            value={v.viewDistance}
            onChange={(e) => setV({ ...v, viewDistance: +e.target.value })}
          />
        </Field>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={v.pvp}
          onChange={(e) => setV({ ...v, pvp: e.target.checked })}
        />{" "}
        Enable player combat (PvP)
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={v.whitelist}
          onChange={(e) => setV({ ...v, whitelist: e.target.checked })}
        />{" "}
        Only allow whitelisted players
      </label>
      <button
        className="primary"
        disabled={working || !["stopped", "failed"].includes(s.status)}
      >
        Save settings
      </button>
    </form>
  );
}
function UploadBox({
  accept,
  label,
  action,
  disabled = false,
}: {
  accept: string;
  label: string;
  action: (f: File) => Promise<any>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <label className={"upload-box " + (disabled ? "disabled" : "")}>
        <Upload size={26} />
        <strong>{busy ? "Uploading…" : label}</strong>
        <small>Click to choose a file</small>
        <input
          type="file"
          accept={accept}
          disabled={disabled || busy}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) {
              setBusy(true);
              setError("");
              try {
                await action(f);
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
                e.target.value = "";
              }
            }
          }}
        />
      </label>
      {error && <Notice error>{error}</Notice>}
    </>
  );
}
function Appearance({ s, act, working }: PageProps) {
  const [name, setName] = useState(s.name);
  const [motd, setMotd] = useState(s.motd);
  const [stamp, setStamp] = useState(Date.now());
  const base = "/servers/" + s.id;
  const upload = (kind: string) => async (f: File) => {
    const data = new FormData();
    data.append("file", f);
    await act(
      () => api(base + "/image/" + kind, { method: "POST", body: data }),
      kind === "icon"
        ? "Icon saved. Restart the server to apply."
        : "Banner saved",
    );
    setStamp(Date.now());
  };
  return (
    <div className="two-col appearance">
      <div className="panel">
        <h2>
          <Palette size={22} /> Make it yours
        </h2>
        <Field label="Server display name">
          <input
            value={name}
            maxLength={48}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Message of the day"
          hint="Two lines, up to 160 characters. Use the color buttons to add formatting."
        >
          <textarea
            rows={3}
            value={motd}
            maxLength={160}
            onChange={(e) => setMotd(e.target.value)}
          />
        </Field>
        <div className="swatches">
          {[
            ["b", "#55ffff"],
            ["d", "#ff55ff"],
            ["a", "#55ff55"],
            ["e", "#ffff55"],
            ["6", "#ffaa00"],
            ["c", "#ff5555"],
            ["f", "#ffffff"],
            ["7", "#aaa"],
          ].map(([code, color]) => (
            <button
              key={code}
              aria-label={"Add color " + code}
              style={{ background: color }}
              onClick={() => setMotd(motd + "§" + code)}
            />
          ))}
          <button onClick={() => setMotd(motd + "§l")}>Bold</button>
          <button onClick={() => setMotd(motd + "§r")}>Reset</button>
        </div>
        <button
          className="primary"
          disabled={working || motd.split("\n").length > 2}
          onClick={() =>
            act(
              () => send(base + "/appearance", { name, motd }, "PUT"),
              "Appearance saved. Restart to apply the Minecraft message.",
            )
          }
        >
          Save appearance
        </button>
        <h3>Multiplayer list preview</h3>
        <div className="minecraft-preview">
          <img
            src={
              s.icon ? "/api" + base + "/image/icon?t=" + stamp : "/icon.svg"
            }
            alt="Server icon"
          />
          <div>
            <strong>{name}</strong>
            <Motd text={motd} />
          </div>
          <span className="muted">0/{s.settings.maxPlayers}</span>
        </div>
        <small className="muted">
          Representative preview; Minecraft fonts and rendering can differ.
        </small>
      </div>
      <div className="panel">
        <h2>Server artwork</h2>
        <p className="muted">
          Images are cropped automatically. Banner: 3:1. Minecraft icon: 64 × 64
          pixels.
        </p>
        <UploadBox
          accept="image/png,image/jpeg,image/webp"
          disabled={working}
          label="Upload dashboard banner"
          action={upload("banner")}
        />
        <UploadBox
          accept="image/png,image/jpeg,image/webp"
          disabled={working}
          label="Upload Minecraft icon"
          action={upload("icon")}
        />
        <small className="muted">
          PNG, JPEG, or WebP · up to 10 MB · icons require a restart.
        </small>
      </div>
    </div>
  );
}
function Players({ s, act, working }: PageProps) {
  const base = "/servers/" + s.id;
  const p = useLoad<any>(() => api(base + "/players"), [s.id], 15000);
  const [name, setName] = useState("");
  const [action, setAction] = useState("whitelist add");
  return (
    <div className="panel">
      <h2>
        <Users size={22} /> Players & permissions
      </h2>
      {p.error && <Notice error>{p.error}</Notice>}
      <p>{p.data?.online || "Loading…"}</p>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await act(
            () => send(base + "/players", { name, action }),
            "Player command sent",
          );
          void p.reload();
        }}
      >
        <input
          aria-label="Minecraft username"
          placeholder="Minecraft username"
          value={name}
          pattern="[A-Za-z0-9_]{1,16}"
          required
          onChange={(e) => setName(e.target.value)}
        />
        <select
          aria-label="Player action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          {["whitelist add", "whitelist remove", "op", "deop", "kick"].map(
            (a) => (
              <option key={a}>{a}</option>
            ),
          )}
        </select>
        <button className="primary" disabled={working}>
          Apply
        </button>
      </form>
      <div className="two-col">
        {["whitelist", "ops"].map((key) => (
          <section key={key}>
            <h3>{key === "ops" ? "Operators" : "Whitelist"}</h3>
            {p.data?.[key]?.length ? (
              p.data[key].map((p: any) => (
                <div className="list-row" key={p.uuid}>
                  <Users size={16} />
                  {p.name}
                </div>
              ))
            ) : (
              <p className="muted">No players added yet.</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
function Backups({ s, act, working }: PageProps) {
  const base = "/servers/" + s.id;
  const list = useLoad<any[]>(() => api(base + "/backups"), [s.id], 5000);
  const [hours, setHours] = useState(s.backupHours);
  const [retention, setRetention] = useState(s.retention);
  const [restore, setRestore] = useState<string | null>(null);
  return (
    <div className="panel">
      <div className="section-heading">
        <h2>
          <Archive size={22} /> Backups & restore
        </h2>
        <button
          className="primary"
          disabled={working}
          onClick={() =>
            act(
              () => send(base + "/actions", { action: "backup" }),
              "Backup started",
            )
          }
        >
          <Plus size={16} /> Back up now
        </button>
      </div>
      <p className="muted">
        Backups briefly stop the server for consistency, then restart it if it
        was running. Restoring creates a safety backup and leaves the server
        stopped.
      </p>
      <div className="form-grid">
        <Field label="Automatic backups">
          <select value={hours} onChange={(e) => setHours(+e.target.value)}>
            <option value={0}>Manual only</option>
            {[6, 12, 24, 48, 168].map((h) => (
              <option key={h} value={h}>
                Every {h} hours
              </option>
            ))}
          </select>
        </Field>
        <Field label="Backups to keep">
          <input
            type="number"
            min={1}
            max={50}
            value={retention}
            onChange={(e) => setRetention(+e.target.value)}
          />
        </Field>
      </div>
      <button
        disabled={working}
        onClick={() =>
          act(() =>
            send(base + "/backups", { backupHours: hours, retention }, "PUT"),
          )
        }
      >
        Save schedule
      </button>
      {list.error && <Notice error>{list.error}</Notice>}
      <div className="backup-list">
        {list.data?.map((b) => (
          <div className="list-row" key={b.name}>
            <Archive size={18} />
            <div>
              <strong>{b.name}</strong>
              <small>{(b.size / 1024 ** 2).toFixed(1)} MB</small>
            </div>
            <a
              className="button"
              href={"/api" + base + "/backup/" + encodeURIComponent(b.name)}
              aria-label={"Download " + b.name}
            >
              <Download size={16} />
            </a>
            <button disabled={working} onClick={() => setRestore(b.name)}>
              Restore
            </button>
          </div>
        ))}
        {!list.data?.length && (
          <Empty icon={Archive} title="A little peace of mind">
            Your backups will appear here.
          </Empty>
        )}
      </div>
      {restore && (
        <Notice>
          <p>
            Restore <strong>{restore}</strong>? Current files will be backed up
            before replacement.
          </p>
          <div className="button-row">
            <button
              disabled={working}
              className="primary"
              onClick={async () => {
                await act(
                  () => send(base + "/restore", { name: restore }),
                  "Restore started",
                );
                setRestore(null);
              }}
            >
              Restore this backup
            </button>
            <button onClick={() => setRestore(null)}>Cancel</button>
          </div>
        </Notice>
      )}
    </div>
  );
}
function Files({ s, act, working }: PageProps) {
  const base = "/servers/" + s.id;
  const [folder, setFolder] = useState("");
  const [file, setFile] = useState("");
  const [text, setText] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const list = useLoad<any[]>(
    () => api(base + "/files?path=" + encodeURIComponent(folder)),
    [s.id, folder],
  );
  return (
    <div className="panel">
      <h2>
        <Folder size={22} /> Server files
      </h2>
      <p className="muted">
        Edit text configuration while the server is stopped. Gameplay settings
        are managed in the Settings tab.
      </p>
      {list.error && <Notice error>{list.error}</Notice>}
      <div className="file-path">
        <button
          onClick={() => {
            setFolder(folder.split("/").slice(0, -1).join("/"));
            setFile("");
          }}
          disabled={!folder}
        >
          <ArrowLeft size={16} />
        </button>
        <code>/ {folder}</code>
      </div>
      {file ? (
        <>
          <h3>{file}</h3>
          <textarea
            className="file-editor"
            aria-label="File contents"
            readOnly={readOnly}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="button-row">
            <button onClick={() => setFile("")}>Close file</button>
            <button
              className="primary"
              disabled={
                readOnly || working || !["stopped", "failed"].includes(s.status)
              }
              onClick={() =>
                act(() => send(base + "/file", { path: file, text }, "PUT"))
              }
            >
              Save file
            </button>
          </div>
        </>
      ) : (
        <div className="file-list">
          {list.data?.map((e) => (
            <button
              className="file-row"
              key={e.name}
              onClick={async () => {
                const next = [folder, e.name].filter(Boolean).join("/");
                if (e.directory) setFolder(next);
                else {
                  const r = await act(
                    () => api(base + "/file?path=" + encodeURIComponent(next)),
                    "File opened",
                  );
                  if (r) {
                    setFile(next);
                    setText(r.text);
                    setReadOnly(r.readOnly);
                  }
                }
              }}
            >
              {e.directory ? <Folder size={18} /> : <FileText size={18} />}
              <span>{e.name}</span>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
function Mods({ s, act, working }: PageProps) {
  const base = "/servers/" + s.id;
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [preview, setPreview] = useState<any[] | null>(null);
  const [project, setProject] = useState("");
  const [pending, setPending] = useState<File | null>(null);
  const [check, setCheck] = useState<any>(null);
  const installed = useLoad<string[]>(
    () => (s.type === "VANILLA" ? Promise.resolve([]) : api(base + "/mods")),
    [s.id],
    8000,
  );
  const search = useLoad<any>(
    () =>
      term
        ? api(base + "/mods/search?q=" + encodeURIComponent(term))
        : Promise.resolve(null),
    [s.id, term],
  );
  const upload = async (f: File, confirm = false) => {
    const data = new FormData();
    data.append("file", f);
    const r = await act(
      () =>
        api(base + "/mods/upload?confirm=" + confirm, {
          method: "POST",
          body: data,
        }),
      confirm ? "File installed" : "Compatibility checked",
    );
    if (r) {
      setCheck(r.check);
      setPending(r.installed ? null : f);
      await installed.reload();
    }
  };
  if (s.type === "VANILLA")
    return (
      <div className="panel">
        <Empty icon={Blocks} title="Vanilla keeps things classic">
          Create a Paper server for plugins, or a Fabric/Forge server for mods.
        </Empty>
      </div>
    );
  return (
    <div className="two-col mods">
      <section className="panel">
        <h2>
          <Blocks size={22} /> Discover on Modrinth
        </h2>
        <p className="muted">
          Filtered for {pretty(s.type)} {s.version}. Required dependencies are
          included.
        </p>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            setTerm(query);
          }}
        >
          <input
            aria-label="Search mods"
            placeholder="Search mods or plugins…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="primary">
            <Search size={18} /> Search
          </button>
        </form>
        {search.error && <Notice error>{search.error}</Notice>}
        <div className="mod-results">
          {search.data?.hits?.map((m: any) => (
            <div className="mod-item" key={m.project_id}>
              {m.icon_url ? (
                <img src={m.icon_url} alt="" />
              ) : (
                <Blocks size={28} />
              )}
              <div>
                <strong>{m.title}</strong>
                <p>{m.description}</p>
              </div>
              <button
                disabled={working}
                onClick={async () => {
                  const r = await act(
                    () => api(base + "/mods/preview?project=" + m.project_id),
                    "Compatibility checked",
                  );
                  if (r) {
                    setPreview(r);
                    setProject(m.project_id);
                  }
                }}
              >
                Review
              </button>
            </div>
          ))}
        </div>
        {preview && (
          <div className="review">
            <h3>Compatible metadata</h3>
            {preview.map((m) => (
              <p key={m.project}>
                {m.title}{" "}
                {m.clientRequired && <small> · Players need this too</small>}
              </p>
            ))}
            <p className="muted">
              Installation stops the server and creates a backup. Metadata
              checks cannot guarantee runtime compatibility.
            </p>
            <button
              className="primary"
              disabled={working}
              onClick={async () => {
                await act(
                  () => send(base + "/mods/install", { project }),
                  "Mod installation started",
                );
                setPreview(null);
              }}
            >
              Install {preview.length} file{preview.length === 1 ? "" : "s"}
            </button>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Installed files</h2>
        <p className="muted">
          Stop the server before uploading or toggling files.
        </p>
        {installed.error && <Notice error>{installed.error}</Notice>}
        {installed.data?.map((name) => (
          <div className="list-row" key={name}>
            <Blocks size={16} />
            <span className="truncate">{name}</span>
            <button
              disabled={working || !["stopped", "failed"].includes(s.status)}
              onClick={async () => {
                await act(() => send(base + "/mods/toggle", { name }));
                void installed.reload();
              }}
            >
              {name.endsWith(".disabled") ? "Enable" : "Disable"}
            </button>
          </div>
        ))}
        {!installed.data?.length && (
          <p className="muted">No files installed yet.</p>
        )}
        <UploadBox
          accept=".jar"
          disabled={working || !["stopped", "failed"].includes(s.status)}
          label="Upload a mod or plugin JAR"
          action={(f) => upload(f)}
        />
        {check && (
          <Notice error={check.status === "Incompatible"}>
            <strong>{check.status}</strong>
            {check.reasons.map((r: string) => (
              <p key={r}>{r}</p>
            ))}
            {check.clientRequired && (
              <p>Players may also need this mod installed.</p>
            )}
            {pending && check.status !== "Incompatible" && (
              <button disabled={working} onClick={() => upload(pending, true)}>
                Install with these requirements
              </button>
            )}
          </Notice>
        )}
      </section>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
