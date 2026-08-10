import { App } from "@modelcontextprotocol/ext-apps";

type ConsoleState = {
  status?: string;
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
let activeView = "Workspace";
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
  const views = ["Workspace", "Changes", "Processes", "Security", "Diagnostics"];
  root.innerHTML = `
    <header>
      <div><strong>KodeGPT</strong><span class="subtle"> Dev Console</span></div>
      <span class="status">${escapeHtml(state.status ?? "READY")}</span>
    </header>
    <nav>${views
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
      activeView = button.dataset.view ?? "Workspace";
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
  if (view === "Workspace") {
    return panel("Workspace", state.workspace?.items ?? []);
  }
  if (view === "Changes") {
    return panel("Changes", state.changes ?? { stale: true });
  }
  if (view === "Processes") {
    const operations = state.processes?.operations ?? [];
    return `<section><h2>Processes</h2>${operations
      .map((operation) => {
        if (!isRecord(operation)) return "";
        const operationId = typeof operation.operationId === "string" ? operation.operationId : "";
        const currentState = typeof operation.state === "string" ? operation.state : "unknown";
        return `<div class="row"><code>${escapeHtml(operationId)}</code><span>${escapeHtml(currentState)}</span>${
          currentState === "running" && operationId.startsWith("op_")
            ? `<button data-stop="${escapeHtml(operationId)}">Stop</button>`
            : ""
        }</div>`;
      })
      .join("")}</section>`;
  }
  if (view === "Security") {
    return panel("Security", state.security?.health ?? {});
  }
  return panel("Diagnostics", state.diagnostics?.value ?? {});
}

function panel(title: string, value: unknown): string {
  return `<section><h2>${title}</h2><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></section>`;
}

async function handleAction(action: string): Promise<void> {
  if (action === "more") {
    showMore = !showMore;
    render();
    return;
  }
  if (action === "changes") {
    const workspaceId = state.changes?.workspaceId;
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
  const workspaceId = state.changes?.workspaceId ?? firstWorkspaceId();
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
