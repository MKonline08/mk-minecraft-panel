import { useState } from "react";
import { api, send, useLoad } from "./api.js";

type Props = {
  s: { id: string; name: string; version: string; status: string };
  working: boolean;
  act: (fn: () => Promise<any>, message?: string) => Promise<any>;
};
export function uploadArchive(
  url: string,
  file: File,
  progress: (s: string) => void,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api" + url);
    request.setRequestHeader("X-MK-Request", "1");
    request.upload.onprogress = (e) =>
      progress(
        e.lengthComputable
          ? `Uploading ${Math.round((e.loaded / e.total) * 100)}%`
          : "Uploading…",
      );
    request.upload.onload = () => progress("Validating archive…");
    request.onerror = () =>
      reject(
        new Error(
          "Upload connection failed. Your current server files were not replaced.",
        ),
      );
    request.onabort = () => reject(new Error("Upload cancelled"));
    request.onload = () => {
      try {
        const result = JSON.parse(request.responseText);
        if (request.status >= 200 && request.status < 300) resolve(result);
        else reject(new Error(result.error || "Upload failed"));
      } catch {
        reject(new Error("Invalid upload response"));
      }
    };
    const data = new FormData();
    data.append("file", file);
    request.send(data);
  });
}
export function ImportPanel({
  s,
  act,
  working,
  kind,
}: Props & { kind: "world" | "backup" | "modpack" }) {
  const base = `/servers/${s.id}`;
  const [record, setRecord] = useState<any>(null),
    [progress, setProgress] = useState("");
  const [runtime, setRuntime] = useState({
    type: "FABRIC",
    version: s.version,
    loaderVersion: "",
  });
  const [world, setWorld] = useState(""),
    [keep, setKeep] = useState(false),
    [optional, setOptional] = useState<string[]>([]);
  const [query, setQuery] = useState(""),
    [hits, setHits] = useState<any[]>([]),
    [versions, setVersions] = useState<any[]>([]);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const recovery = useLoad<any>(
    () => api(base + "/import-recovery"),
    [s.id],
    5000,
  );
  const acceptRecord = (r: any) => {
    if (!r) return;
    setRecord(r);
    setKeep(false);
    setOptional([]);
    setUploaded([]);
    setWorld(r.worlds?.[0] ?? "");
    if (r.runtime)
      setRuntime({
        ...r.runtime,
        loaderVersion: r.runtime.loaderVersion || "",
      });
  };
  const upload = async (file: File) => {
    try {
      acceptRecord(
        await act(
          () =>
            uploadArchive(base + `/imports?kind=${kind}`, file, setProgress),
          "Archive inspected",
        ),
      );
    } finally {
      setProgress("");
    }
  };
  const busy = working || !!progress;
  return (
    <section className="panel import-panel">
      <h2>
        {kind === "modpack"
          ? "Modpacks"
          : kind === "world"
            ? "Upload world"
            : "Upload backup"}
      </h2>
      <p className="muted">
        {kind === "modpack"
          ? "Install a complete server pack. Review the exact Minecraft and loader versions before replacing files."
          : kind === "world"
            ? "Import a Java world ZIP. A safety backup is created before replacing the current world."
            : "Upload an MK backup or a full Java server ZIP. Uploading does not restore it; choose Restore from the backup list when ready."}
      </p>
      {kind === "modpack" && (
        <>
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await act(
                () => api("/modpacks?query=" + encodeURIComponent(query)),
                "Search complete",
              );
              if (r) setHits(r.hits);
            }}
          >
            <input
              aria-label="Search Modrinth modpacks"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Modrinth modpacks"
            />
            <button disabled={busy}>Search packs</button>
          </form>
          <div className="pack-results">
            {hits.map((h) => (
              <article className="list-row" key={h.project_id}>
                <div>
                  <strong>{h.title}</strong>
                  <p className="muted">{h.description}</p>
                </div>
                <button
                  disabled={busy}
                  onClick={async () => {
                    const r = await act(
                      () => api(`/modpacks/${h.project_id}/versions`),
                      "Versions loaded",
                    );
                    if (r) setVersions(r);
                  }}
                >
                  Versions
                </button>
              </article>
            ))}
          </div>
          {!!versions.length && (
            <label>
              Pack version
              <select
                aria-label="Pack version"
                disabled={busy}
                defaultValue=""
                onChange={async (e) => {
                  const id = e.target.value;
                  if (id)
                    acceptRecord(
                      await act(
                        () => send(base + "/imports/modrinth", { version: id }),
                        "Pack inspected",
                      ),
                    );
                }}
              >
                <option value="">Select a version to inspect</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.game_versions.join(", ")}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      <label className="upload-box">
        {kind === "modpack"
          ? "Upload .mrpack or server / CurseForge ZIP"
          : kind === "world"
            ? "Choose world ZIP"
            : "Choose backup ZIP"}
        <input
          type="file"
          accept={kind === "modpack" ? ".mrpack,.zip" : ".zip"}
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
        />
      </label>
      {progress && <p role="status">{progress}</p>}
      {record && (
        <div className="import-review">
          <h3>Review: {record.name}</h3>
          <p>
            {record.format}
            {record.version ? ` · ${record.version}` : ""}
          </p>
          {record.warnings.map((w: string) => (
            <p className="notice" key={w}>
              {w}
            </p>
          ))}
          {kind !== "world" && (
            <div className="form-grid">
              <label>
                Server software
                <select
                  aria-label="Import server software"
                  disabled={!!record.runtime || busy}
                  value={runtime.type}
                  onChange={(e) =>
                    setRuntime({ ...runtime, type: e.target.value })
                  }
                >
                  {[
                    "VANILLA",
                    "PAPER",
                    "SPIGOT",
                    "PURPUR",
                    "FABRIC",
                    "FORGE",
                    "NEOFORGE",
                    "QUILT",
                  ].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label>
                Minecraft version
                <input
                  aria-label="Import Minecraft version"
                  disabled={!!record.runtime || busy}
                  value={runtime.version}
                  onChange={(e) =>
                    setRuntime({ ...runtime, version: e.target.value })
                  }
                />
              </label>
              <label>
                Exact loader version
                <input
                  aria-label="Import loader version"
                  disabled={!!record.runtime || busy}
                  value={runtime.loaderVersion}
                  onChange={(e) =>
                    setRuntime({ ...runtime, loaderVersion: e.target.value })
                  }
                  placeholder="Required for Fabric, Forge, NeoForge or Quilt"
                />
              </label>
            </div>
          )}
          {kind === "world" && record.worlds.length > 1 && (
            <label>
              World to import
              <select
                aria-label="World to import"
                value={world}
                onChange={(e) => setWorld(e.target.value)}
              >
                {record.worlds.map((w: string) => (
                  <option key={w} value={w}>
                    {w || "Archive root"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === "modpack" && (
            <>
              <p>
                Server files: {record.files.length}. Memory requirements are not
                guaranteed by pack metadata; review the author's guidance before
                starting.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={keep}
                  disabled={busy || runtime.version !== s.version}
                  onChange={(e) => setKeep(e.target.checked)}
                />{" "}
                Keep current world (same Minecraft version only)
              </label>
              {keep && (
                <p className="notice">
                  Changing mods can remove blocks, items, or dimensions even on
                  the same Minecraft version. The safety backup preserves the
                  old installation.
                </p>
              )}
              {record.files
                .filter((f: any) => f.optional)
                .map((f: any) => (
                  <label className="list-row" key={f.path}>
                    <input
                      type="checkbox"
                      checked={optional.includes(f.path)}
                      onChange={(e) =>
                        setOptional(
                          e.target.checked
                            ? [...optional, f.path]
                            : optional.filter((p) => p !== f.path),
                        )
                      }
                    />
                    {f.path}
                  </label>
                ))}
              {record.files
                .filter((f: any) => !f.urls.length)
                .map((f: any) => (
                  <label className="list-row" key={f.path}>
                    {uploaded.includes(f.path)
                      ? "Verified upload: "
                      : "Missing file: "}
                    {f.path}
                    <input
                      type="file"
                      disabled={busy}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        try {
                          const r = await act(
                            () =>
                              uploadArchive(
                                base +
                                  `/imports/${record.id}/file?path=${encodeURIComponent(f.path)}`,
                                file,
                                setProgress,
                              ),
                            "File verified",
                          );
                          if (r) setUploaded([...uploaded, f.path]);
                        } finally {
                          setProgress("");
                        }
                      }}
                    />
                  </label>
                ))}
            </>
          )}
          <p>
            {kind === "backup"
              ? "This adds the archive to Backups without changing live files."
              : `This stops ${s.name}, creates a safety backup, and ${kind === "world" ? "replaces its world. The server stays stopped." : keep ? "replaces its mods and configuration while keeping the world." : "replaces its installation with the pack's fresh world."}`}
          </p>
          <div className="button-row">
            <button disabled={busy} onClick={() => setRecord(null)}>
              Cancel review
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                record.files.some(
                  (f: any) =>
                    !f.optional && !f.urls.length && !uploaded.includes(f.path),
                )
              }
              onClick={async () => {
                if (
                  !window.confirm(
                    kind === "backup"
                      ? `Add ${record.name} to backups?`
                      : `Apply this import to ${s.name}? A safety backup will be created before replacement.`,
                  )
                )
                  return;
                const r = await act(
                  () =>
                    send(base + `/imports/${record.id}/apply`, {
                      confirm: true,
                      runtime: {
                        ...runtime,
                        loaderVersion: runtime.loaderVersion || undefined,
                      },
                      world,
                      keepWorld: keep,
                      optional,
                    }),
                  kind === "backup"
                    ? "Backup uploaded; use Restore when ready"
                    : "Import started",
                );
                if (r) setRecord(null);
              }}
            >
              {kind === "backup" ? "Add to backups" : "Confirm import"}
            </button>
          </div>
        </div>
      )}
      {recovery.data?.pack && (
        <div className="notice">
          <strong>{recovery.data.pack.name}</strong>:{" "}
          {
            (
              {
                installed: "Installed",
                verified: "Startup verified",
                failed: "Startup failed",
              } as any
            )[recovery.data.pack.status]
          }
          {recovery.data.pack.log && (
            <details>
              <summary>Startup log</summary>
              <pre>{recovery.data.pack.log}</pre>
            </details>
          )}
        </div>
      )}
      {recovery.data?.available && (
        <div className="import-review">
          <h3>
            {recovery.data.recoveryRequired
              ? "Import recovery required"
              : "Previous installation retained"}
          </h3>
          <p>
            Roll back to the previous files and runtime, or keep this
            installation and discard the rollback copy. Safety backups remain
            subject to backup retention.
          </p>
          <div className="button-row">
            <button
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Stop the server and restore the previous installation?",
                  )
                )
                  void act(
                    () => send(base + "/import-recovery", { confirm: true }),
                    "Rollback started",
                  );
              }}
            >
              Roll back import
            </button>
            <button
              disabled={
                busy ||
                recovery.data.recoveryRequired ||
                !["stopped", "failed"].includes(s.status)
              }
              onClick={async () => {
                if (
                  window.confirm(
                    "Permanently discard the previous installation's rollback copy?",
                  )
                ) {
                  await act(
                    () =>
                      send(
                        base + "/import-recovery",
                        { confirm: true },
                        "DELETE",
                      ),
                    "Current installation kept",
                  );
                  void recovery.reload();
                }
              }}
            >
              Keep this installation
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function TrashPanel({ s, act, working }: Props) {
  const base = `/servers/${s.id}/trash`,
    list = useLoad<any[]>(() => api(base), [s.id], 3000);
  const stopped = ["stopped", "failed"].includes(s.status);
  const entries = Array.isArray(list.data) ? list.data : [];
  return (
    <details className="trash-panel">
      <summary>
        Trash · {entries.length} items ·{" "}
        {(entries.reduce((n, e) => n + e.bytes, 0) / 1024 ** 2).toFixed(1)} MiB
      </summary>
      <p className="muted">
        Items remain here until you empty trash. Stop Minecraft to restore or
        permanently delete them.
      </p>
      {list.error && <p role="alert">{list.error}</p>}
      {entries.map((e) => (
        <div className="list-row" key={e.id}>
          <code>{e.path}</code>
          <span>{new Date(e.deletedAt).toLocaleString()}</span>
          <button
            disabled={working || !stopped}
            onClick={async () => {
              await act(
                () => send(base + `/${e.id}/restore`),
                "Restored from trash",
              );
              void list.reload();
            }}
          >
            Restore
          </button>
        </div>
      ))}
      <button
        disabled={working || !stopped || !entries.length}
        onClick={async () => {
          if (
            window.confirm(
              "Permanently delete everything in this server's trash? This cannot be undone.",
            )
          ) {
            await act(
              () => send(base, { confirm: true }, "DELETE"),
              "Trash emptied",
            );
            void list.reload();
          }
        }}
      >
        Empty trash
      </button>
    </details>
  );
}
