import { useState } from "react";
import { api, send, useLoad } from "./api.js";
export function RepairPanel({
  id,
  name,
  working,
  act,
}: {
  id: string;
  name: string;
  working: boolean;
  act: (fn: () => Promise<any>, message?: string) => Promise<any>;
}) {
  const base = `/servers/${id}/repairs`,
    state = useLoad<any>(() => api(base), [id], 3000),
    [selected, setSelected] = useState("");
  const report = state.data?.report;
  return (
    <section className="panel import-panel">
      <h2>Startup diagnosis &amp; repair</h2>
      <p className="muted">
        Diagnose reads the latest server log and installed JARs. Review and
        confirm a proposed change before anything is modified. Repairs keep the
        current Minecraft and loader versions, make a safety backup, then test
        startup. Failed tests restore the original files and leave Minecraft
        stopped.
      </p>
      <button
        disabled={working}
        onClick={async () => {
          setSelected("");
          await act(
            () => send(base + "/diagnose"),
            "Diagnosis started. Results appear here when complete.",
          );
        }}
      >
        Diagnose startup
      </button>
      {state.error && <p role="alert">{state.error}</p>}
      {report && (
        <div className="import-review">
          <p>{report.explanation}</p>
          <small>
            Diagnosis from {new Date(report.created).toLocaleString()}. File
            changes require a new diagnosis.
          </small>
          <details>
            <summary>Log evidence</summary>
            <pre>
              {report.evidence?.join("\n") ||
                "No definitive startup error found in the available log."}
            </pre>
          </details>
          {report.warnings?.map((w: string) => (
            <p className="notice" key={w}>
              {w}
            </p>
          ))}
          {report.proposals?.map((proposal: any) => (
            <label className="import-review" key={proposal.id}>
              <input
                type="radio"
                name="repair-proposal"
                checked={selected === proposal.id}
                disabled={working}
                onChange={() => setSelected(proposal.id)}
              />
              <strong>{proposal.title}</strong>
              <ul>
                {proposal.files.map((f: any) => (
                  <li key={f.name}>
                    {f.old ? `${f.old} → ${f.name}` : `Install ${f.name}`}
                  </li>
                ))}
              </ul>
              {proposal.clientRequired && (
                <p>
                  Players may need these exact mod versions in their clients.
                </p>
              )}
            </label>
          ))}
          {!report.proposals?.length && (
            <p>
              No safe file change was identified. Review the crash report and
              the pack author's server requirements.
            </p>
          )}
          <button
            className="primary"
            disabled={working || !selected || state.data?.rollback}
            onClick={async () => {
              if (
                !window.confirm(
                  `Apply the selected repair to ${name}? Minecraft will stop, a full backup will be created, and startup will be tested. Failed tests roll back automatically.`,
                )
              )
                return;
              await act(
                () =>
                  send(base + "/apply", {
                    confirm: true,
                    diagnosisId: report.id,
                    proposalId: selected,
                  }),
                "Confirmed repair started",
              );
            }}
          >
            Confirm selected repair
          </button>
        </div>
      )}
      {state.data?.result && (
        <div className="notice">
          <strong>
            {state.data.result.status === "verified"
              ? "Repair startup verified"
              : "Repair attempt failed"}
          </strong>
          <p>{state.data.result.error}</p>
          <p>Safety backup: {state.data.result.backup}</p>
          {state.data.result.logs && (
            <details>
              <summary>Repair test logs</summary>
              <pre>{state.data.result.logs}</pre>
            </details>
          )}
        </div>
      )}
      {state.data?.rollback && (
        <div className="button-row">
          <button
            disabled={working}
            onClick={() => {
              if (
                window.confirm(
                  "Stop Minecraft and restore the complete pre-repair installation?",
                )
              )
                void act(
                  () => send(base + "/rollback", { confirm: true }),
                  "Repair rollback started",
                );
            }}
          >
            Roll back repair
          </button>
          <button
            disabled={working}
            onClick={async () => {
              if (
                window.confirm(
                  "Discard the repair rollback copy? Stop Minecraft first. The backup remains subject to retention.",
                )
              ) {
                await act(
                  () => send(base + "/rollback", { confirm: true }, "DELETE"),
                  "Repair kept",
                );
                void state.reload();
              }
            }}
          >
            Keep this repair
          </button>
        </div>
      )}
    </section>
  );
}
