import { App } from "@modelcontextprotocol/ext-apps";

import type { ConsoleState as StoreConsoleState } from "./state.js";

type ConsoleState = Partial<StoreConsoleState> & {
  workspace?: { items?: unknown[] };
  changes?: { workspaceId?: string; gitStatus?: unknown; stale?: boolean };
  processes?: { operations?: unknown[] };
  security?: { health?: unknown };
  diagnostics?: { value?: unknown };
};

const app = new App(
  { name: "KodeGPT Dev Console", version: "0.1.0" },
  {},
  { autoResize: true, strict: true }
);

let state: ConsoleState = {};
let activeView = "Dashboard";
let localNotice = "";
let showMore = false;

app.ontoolresult = (result) => {
  const candidate = result.structuredContent;
  if (isRecord(candidate) && candidate.schemaVersion === 1) {
    state = candidate as ConsoleState;
    render();
  }
};

app.ontoolcancelled = (params) => {
  localNotice = params.reason ? `Host cancelled the operation: ${params.reason}` : "Host cancelled the operation.";
  render();
};

function render(): void {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) return;
  const views = ["Dashboard", "Evidence", "Processes", "Remote", "Security", "Diagnostics"];
  root.innerHTML = `
    <header>
      <div><strong>KodeGPT</strong><span class="subtle"> Dev Console</span></div>
      <span class="status">${escapeHtml(state.status ?? "READY")}</span>
    </header>
    <nav aria-label="Dev Console views">${views
      .map(
        (view) =>
          `<button data-view="${view}" class="${activeView === view ? "active" : ""}">${view}</button>`
      )
      .join("")}</nav>
    <main>${viewContent(activeView)}</main>
    <footer>
      <button data-action="continue">Continue</button>
      <button data-action="run">Run</button>
      <button data-action="changes">Changes</button>
      <button data-action="more">More</button>
    </footer>
    ${localNotice ? `<aside role="status">${escapeHtml(localNotice)}</aside>` : ""}
    ${showMore ? `<section class="more">All privileged work stays behind KodeGPT MCP tools and host confirmation.</section>` : ""}
  `;

  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      activeView = button.dataset.view ?? "Dashboard";
      render();
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => void handleAction(button.dataset.action ?? ""));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-stop]").forEach((button) => {
    button.addEventListener("click", () => void stopOperation(button.dataset.stop ?? ""));
  });
}

function viewContent(view: string): string {
  if (view === "Dashboard") return dashboardView();
  if (view === "Evidence") return evidenceView();
  if (view === "Processes") return processesView();
  if (view === "Remote") return remoteView();
  if (view === "Security") return securityView();
  return diagnosticsView();
}

function dashboardView(): string {
  const cockpit = state.cockpit;
  const workspace = cockpit?.workspace;
  const objective = cockpit?.objective;
  const verification = cockpit?.verification.items ?? [];
  const activeProcesses = cockpit?.processes.active ?? [];
  const activePreviews = cockpit?.previews.active ?? [];
  const remote = cockpit?.remote;
  const freshPassing = verification.filter(
    (item) => item.state === "completed" && item.exitCode === 0 && item.freshness === "fresh"
  ).length;
  const stale = verification.filter((item) => item.freshness === "stale").length;
  const remoteSummary = remote?.pullRequest
    ? `PR #${remote.pullRequest.number}${remote.pullRequest.state ? ` · ${remote.pullRequest.state}` : ""}`
    : remote?.ci
      ? `CI ${remote.ci.state ?? "observed"}`
      : "Not observed";

  return `
    <div class="card-grid">
      ${card(
        "Workspace",
        facts([
          ["Branch", workspace?.branch ?? "Unknown"],
          ["Head", shortOid(workspace?.headOid)],
          ["Source", workspace?.dirty === undefined ? "Unknown" : workspace.dirty ? "Dirty" : "Clean"],
          ["Freshness", workspace?.freshness ?? "unknown"]
        ])
      )}
      ${card(
        "Objective",
        facts([
          ["Objective", objective?.objective ?? "No active checkpoint"],
          ["Status", objective?.status ?? "Unknown"],
          ["Relation", objective?.relation ?? "Unknown"],
          ["Revision", objective?.revision === undefined ? "—" : String(objective.revision)]
        ])
      )}
      ${card(
        "Verification",
        facts([
          ["Observed", String(verification.length)],
          ["Fresh passing", String(freshPassing)],
          ["Stale", String(stale)]
        ])
      )}
      ${card(
        "Execution",
        facts([
          ["Active processes", String(activeProcesses.length)],
          ["Active previews", String(activePreviews.length)]
        ])
      )}
      ${card(
        "Remote",
        facts([
          ["Latest", remoteSummary],
          ["CI", remote?.ci?.state ?? "Not observed"]
        ])
      )}
      ${card("Next actions", nextActions(cockpit?.nextActions ?? []))}
    </div>
  `;
}

function evidenceView(): string {
  const cockpit = state.cockpit;
  const workspace = cockpit?.workspace;
  const verification = cockpit?.verification.items ?? [];
  const previews = cockpit?.previews.active ?? [];
  return `
    <section>
      <div class="section-heading"><h2>Evidence</h2><span class="badge">${escapeHtml(workspace?.freshness ?? "unknown")}</span></div>
      ${facts([
        ["Workspace", workspace?.workspaceId ?? "Not selected"],
        ["Branch", workspace?.branch ?? "Unknown"],
        ["Head", shortOid(workspace?.headOid)],
        ["Source", workspace?.dirty === undefined ? "Unknown" : workspace.dirty ? "Dirty" : "Clean"]
      ])}
    </section>
    <section>
      <h2>Verification</h2>
      ${verification.length === 0
        ? empty("No verification evidence has been observed for this workspace.")
        : `<div class="stack">${verification
            .map(
              (item) => `<article class="evidence-row">
                <div><strong>${escapeHtml(item.label)}</strong><div class="subtle mono">${escapeHtml(item.recipeId)}</div></div>
                <div class="row-meta"><span>${escapeHtml(item.state)}</span><span class="badge">${escapeHtml(item.freshness)}</span></div>
              </article>`
            )
            .join("")}</div>`}
    </section>
    <section>
      <h2>Preview evidence</h2>
      ${previews.length === 0
        ? empty("No active preview evidence has been observed.")
        : `<div class="stack">${previews
            .map(
              (preview) => `<article class="evidence-row">
                <div><strong>${escapeHtml(preview.previewId)}</strong><div class="subtle">${escapeHtml(preview.processState)}</div></div>
                <div class="row-meta"><span>${preview.reachable === undefined ? "Unknown" : preview.reachable ? "Reachable" : "Unreachable"}</span><span class="badge">${escapeHtml(preview.freshness)}</span></div>
              </article>`
            )
            .join("")}</div>`}
    </section>
  `;
}

function processesView(): string {
  const operations = state.processes?.operations ?? [];
  const previews = state.cockpit?.previews.active ?? [];
  return `
    <section>
      <div class="section-heading"><h2>Processes</h2><span class="badge">${state.cockpit?.processes.active.length ?? 0} active</span></div>
      ${operations.length === 0
        ? empty("No process operations have been observed.")
        : `<div class="stack">${operations
            .map((operation) => {
              if (!isRecord(operation)) return "";
              const operationId = typeof operation.operationId === "string" ? operation.operationId : "";
              const currentState = typeof operation.state === "string" ? operation.state : "unknown";
              return `<article class="evidence-row"><code>${escapeHtml(operationId)}</code><div class="row-meta"><span>${escapeHtml(currentState)}</span>${
                currentState === "running" && operationId.startsWith("op_")
                  ? `<button data-stop="${escapeHtml(operationId)}">Stop</button>`
                  : ""
              }</div></article>`;
            })
            .join("")}</div>`}
    </section>
    <section>
      <h2>Active previews</h2>
      ${previews.length === 0
        ? empty("No active previews.")
        : `<div class="stack">${previews
            .map(
              (preview) => `<article class="evidence-row"><code>${escapeHtml(preview.previewId)}</code><div class="row-meta"><span>${escapeHtml(preview.processState)}</span><span class="badge">${escapeHtml(preview.freshness)}</span></div></article>`
            )
            .join("")}</div>`}
    </section>
  `;
}

function remoteView(): string {
  const remote = state.cockpit?.remote;
  const pr = remote?.pullRequest;
  const ci = remote?.ci;
  return `
    <div class="card-grid">
      ${card(
        "Pull request",
        pr
          ? facts([
              ["Repository", pr.repository],
              ["PR", `#${pr.number}${pr.title ? ` · ${pr.title}` : ""}`],
              ["State", pr.merged ? "merged" : pr.state ?? "observed"],
              ["Branch", pr.headBranch && pr.baseBranch ? `${pr.headBranch} → ${pr.baseBranch}` : pr.headBranch ?? "Unknown"]
            ])
          : empty("No pull-request observation yet.")
      )}
      ${card(
        "CI",
        ci
          ? facts([
              ["Repository", ci.repository],
              ["State", ci.state ?? "Unknown"],
              ["Branch", ci.branch ?? "Unknown"],
              ["Revision", shortOid(ci.oid)],
              ["Failures", String(ci.failures)]
            ])
          : empty("No CI observation yet.")
      )}
    </div>
  `;
}

function securityView(): string {
  const health = state.security?.health;
  if (!isRecord(health)) {
    return `<section><h2>Security</h2>${empty("Health/security evidence is not available.")}</section>`;
  }
  return `<section><h2>Security</h2>${facts([
    ["Health", health.ok === true ? "Healthy" : health.ok === false ? "Degraded" : "Unknown"],
    ["Audit", health.auditHealthy === true ? "Healthy" : health.auditHealthy === false ? "Failed" : "Unknown"],
    [
      "Filesystem boundary",
      health.filesystemBoundaryAvailable === true
        ? "Available"
        : health.filesystemBoundaryAvailable === false
          ? "Unavailable"
          : "Unknown"
    ]
  ])}<p class="subtle">Detailed health diagnostics are available in Diagnostics.</p></section>`;
}

function diagnosticsView(): string {
  return `
    ${panel("Diagnostics", state.diagnostics?.value ?? {})}
    ${panel("Legacy workspace state", state.workspace?.items ?? [])}
    ${panel("Legacy changes state", state.changes ?? { stale: true })}
  `;
}

function card(title: string, content: string): string {
  return `<section class="card"><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

function facts(items: Array<[string, string]>): string {
  return `<dl class="facts">${items
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("")}</dl>`;
}

function nextActions(actions: NonNullable<StoreConsoleState["cockpit"]>["nextActions"]): string {
  if (actions.length === 0) return empty("No next-action hints from current evidence.");
  return `<ol class="actions">${actions
    .map(
      (action) => `<li><strong>${escapeHtml(action.label)}</strong><span>${escapeHtml(action.reason)}</span></li>`
    )
    .join("")}</ol>`;
}

function empty(message: string): string {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

function panel(title: string, value: unknown): string {
  return `<section><h2>${escapeHtml(title)}</h2><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></section>`;
}

function shortOid(value: string | undefined): string {
  return value ? value.slice(0, 12) : "Unknown";
}

async function handleAction(action: string): Promise<void> {
  if (action === "more") {
    showMore = !showMore;
    render();
    return;
  }
  if (action === "changes") {
    const workspaceId = activeWorkspaceId();
    if (!workspaceId) {
      localNotice = "Open a workspace before requesting a diff.";
      render();
      return;
    }
    try {
      await app.callServerTool({ name: "git.diff", arguments: { workspaceId } });
    } catch {
      localNotice = "Changes could not be loaded through the host. Ask the model to run git.diff for the active workspace.";
      render();
    }
    return;
  }
  if (action === "continue" || action === "run") {
    const text =
      action === "continue"
        ? "Continue the current KodeGPT implementation using the active workspace state."
        : "Run the next appropriate KodeGPT verification or implementation step for the active workspace.";
    try {
      const result = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      if (result.isError) throw new Error("host rejected message");
    } catch {
      localNotice = `Host messaging is unavailable. Send this manually: ${text}`;
      render();
    }
  }
}

async function stopOperation(operationId: string): Promise<void> {
  const workspaceId = activeWorkspaceId();
  if (!workspaceId || !operationId.startsWith("op_")) return;
  try {
    await app.callServerTool({
      name: "process.cancel",
      arguments: { workspaceId, operationId }
    });
  } catch {
    localNotice = `Stop failed through the host. Ask the model to cancel ${operationId}.`;
    render();
  }
}

function activeWorkspaceId(): string | undefined {
  return state.cockpit?.workspace?.workspaceId ?? state.changes?.workspaceId ?? firstWorkspaceId();
}

function firstWorkspaceId(): string | undefined {
  for (const item of state.workspace?.items ?? []) {
    if (isRecord(item) && typeof item.id === "string") return item.id;
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

render();
void app.connect().catch(() => {
  localNotice = "The MCP Apps host connection is unavailable. Use the text fallback in the chat.";
  render();
});
