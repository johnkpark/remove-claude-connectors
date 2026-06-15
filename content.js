(function () {
  if (window.__claudeConnectorRemoverContentInstalled) {
    return;
  }
  window.__claudeConnectorRemoverContentInstalled = true;

  const state = {
    orgUuid: null,
    connectors: new Map(),
    status: "Waiting for Claude connector data...",
    lastDelete: null,
    expanded: true
  };

  function injectAgent() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-agent.js");
    script.async = false;
    script.onload = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  }

  function post(type, payload = {}) {
    window.postMessage(
      {
        source: "claude-connector-remover-content",
        type,
        payload
      },
      window.location.origin
    );
  }

  function ensureRoot() {
    let root = document.getElementById("ccr-root");
    if (root) {
      return root;
    }

    root = document.createElement("div");
    root.id = "ccr-root";
    root.innerHTML = `
      <button class="ccr-toggle" type="button" aria-label="Toggle connector remover">Connectors</button>
      <section class="ccr-panel" aria-live="polite">
        <header class="ccr-header">
          <div>
            <strong>Connector Remover</strong>
            <span class="ccr-subtitle">Claude remote MCP servers</span>
          </div>
          <button class="ccr-icon-button" type="button" data-action="collapse" aria-label="Collapse">x</button>
        </header>
        <div class="ccr-status"></div>
        <div class="ccr-org"></div>
        <div class="ccr-actions">
          <button type="button" data-action="scan">Scan again</button>
          <button type="button" data-action="reload">Reload page</button>
        </div>
        <div class="ccr-list"></div>
        <p class="ccr-note">Deletes use Claude's same-origin API with your current signed-in session. Confirm each deletion carefully.</p>
      </section>
    `;

    document.documentElement.appendChild(root);
    root.querySelector(".ccr-toggle").addEventListener("click", () => {
      state.expanded = !state.expanded;
      render();
    });
    root.querySelector('[data-action="collapse"]').addEventListener("click", () => {
      state.expanded = false;
      render();
    });
    root.querySelector('[data-action="scan"]').addEventListener("click", () => {
      state.status = "Scanning observed Claude bootstrap requests...";
      render();
      post("RESCAN");
    });
    root.querySelector('[data-action="reload"]').addEventListener("click", () => {
      window.location.reload();
    });

    return root;
  }

  function render() {
    const root = ensureRoot();
    root.classList.toggle("ccr-collapsed", !state.expanded);

    const status = root.querySelector(".ccr-status");
    status.textContent = state.status;
    status.className = `ccr-status${state.lastDelete && state.lastDelete.ok ? " ccr-success" : ""}${state.lastDelete && !state.lastDelete.ok ? " ccr-error" : ""}`;

    const org = root.querySelector(".ccr-org");
    org.textContent = state.orgUuid ? `Org: ${state.orgUuid}` : "Org: not detected yet";

    const list = root.querySelector(".ccr-list");
    const connectors = Array.from(state.connectors.values()).sort((a, b) => a.name.localeCompare(b.name));
    if (connectors.length === 0) {
      list.innerHTML = `<div class="ccr-empty">No connectors detected yet. Reload this Claude page if the list stays empty.</div>`;
      return;
    }

    list.replaceChildren(
      ...connectors.map((connector) => {
        const row = document.createElement("article");
        row.className = "ccr-row";

        const details = document.createElement("div");
        details.className = "ccr-details";

        const name = document.createElement("strong");
        name.textContent = connector.name;

        const uuid = document.createElement("code");
        uuid.textContent = connector.uuid;

        details.append(name, uuid);
        if (connector.url) {
          const url = document.createElement("span");
          url.className = "ccr-url";
          url.textContent = connector.url;
          details.append(url);
        }

        const button = document.createElement("button");
        button.type = "button";
        button.className = "ccr-delete";
        button.textContent = "Delete";
        button.disabled = !state.orgUuid;
        button.addEventListener("click", () => {
          const confirmed = window.confirm(
            `Delete the Claude connector "${connector.name}"?\n\nServer UUID: ${connector.uuid}\n\nThis calls Claude's DELETE endpoint for your current account.`
          );
          if (!confirmed) {
            return;
          }

          state.lastDelete = null;
          state.status = `Deleting ${connector.name}...`;
          render();
          post("DELETE_CONNECTOR", {
            orgUuid: state.orgUuid,
            serverUuid: connector.uuid
          });
        });

        row.append(details, button);
        return row;
      })
    );
  }

  function mergeConnectors(connectors) {
    for (const connector of connectors || []) {
      if (connector && connector.uuid) {
        state.connectors.set(connector.uuid, connector);
      }
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }

    const message = event.data;
    if (!message || message.source !== "claude-connector-remover-agent") {
      return;
    }

    if (message.type === "READY" || message.type === "STATE") {
      state.orgUuid = message.payload.orgUuid || state.orgUuid;
      mergeConnectors(message.payload.connectors);
      state.status = state.connectors.size
        ? `Found ${state.connectors.size} connector${state.connectors.size === 1 ? "" : "s"}.`
        : "Waiting for Claude connector data...";
      render();
      return;
    }

    if (message.type === "ORG_FOUND") {
      state.orgUuid = message.payload.orgUuid;
      state.status = "Found Claude organization UUID.";
      render();
      return;
    }

    if (message.type === "CONNECTORS_FOUND") {
      state.connectors.clear();
      mergeConnectors(message.payload.connectors);
      state.status = `Found ${state.connectors.size} connector${state.connectors.size === 1 ? "" : "s"}.`;
      state.lastDelete = null;
      render();
      return;
    }

    if (message.type === "SCAN_RESULT") {
      state.status = message.payload.message || "Scan finished.";
      render();
      return;
    }

    if (message.type === "DELETE_RESULT") {
      state.lastDelete = message.payload;
      state.status = message.payload.ok
        ? `Deleted connector. Refresh Claude if it still appears in the page UI.`
        : message.payload.message || "Delete failed.";
      if (message.payload.ok && message.payload.serverUuid) {
        state.connectors.delete(message.payload.serverUuid);
      }
      render();
      return;
    }

    if (message.type === "AGENT_ERROR") {
      state.status = message.payload.message || "Extension agent error.";
      render();
    }
  });

  injectAgent();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureRoot();
      post("GET_STATE");
      render();
    });
  } else {
    ensureRoot();
    post("GET_STATE");
    render();
  }
})();
