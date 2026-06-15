(function () {
  if (window.__claudeConnectorRemoverAgentInstalled) {
    return;
  }
  window.__claudeConnectorRemoverAgentInstalled = true;

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const state = {
    orgUuid: null,
    connectors: new Map(),
    bootstrapUrls: new Set(),
    observedUrls: new Set()
  };

  function post(type, payload = {}) {
    window.postMessage(
      {
        source: "claude-connector-remover-agent",
        type,
        payload
      },
      window.location.origin
    );
  }

  function normalizeUrl(input) {
    try {
      if (typeof input === "string") {
        return new URL(input, window.location.href);
      }
      if (input && typeof input.url === "string") {
        return new URL(input.url, window.location.href);
      }
    } catch (_error) {
      return null;
    }
    return null;
  }

  function rememberOrgFromUrl(url) {
    if (!url) {
      return;
    }

    state.observedUrls.add(url.href);
    const match =
      url.href.match(/\/edge-api\/bootstrap\/([0-9a-f-]{36})\/app_start\b/i) ||
      url.href.match(/\/api\/organizations\/([0-9a-f-]{36})\b/i);
    if (match && uuidPattern.test(match[1]) && state.orgUuid !== match[1]) {
      state.orgUuid = match[1];
      post("ORG_FOUND", { orgUuid: state.orgUuid, url: url.href });
    }
  }

  function connectorFromObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const uuid = typeof value.uuid === "string" ? value.uuid : null;
    const name = typeof value.name === "string" ? value.name : null;
    if (!uuid || !name || !uuidPattern.test(uuid)) {
      return null;
    }

    return {
      uuid,
      name,
      description: typeof value.description === "string" ? value.description : "",
      url:
        typeof value.url === "string"
          ? value.url
          : typeof value.server_url === "string"
            ? value.server_url
            : typeof value.serverUrl === "string"
              ? value.serverUrl
              : "",
      rawKeys: Object.keys(value).sort()
    };
  }

  function collectConnectors(value, connectors = []) {
    const direct = connectorFromObject(value);
    if (direct) {
      connectors.push(direct);
      return connectors;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectConnectors(item, connectors);
      }
      return connectors;
    }

    if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        collectConnectors(item, connectors);
      }
    }

    return connectors;
  }

  function rememberConnectors(connectors, sourceUrl) {
    const changed = [];
    for (const connector of connectors) {
      const previous = state.connectors.get(connector.uuid);
      const next = {
        ...previous,
        ...connector,
        sourceUrl,
        lastSeenAt: new Date().toISOString()
      };
      state.connectors.set(connector.uuid, next);
      changed.push(next);
    }

    if (changed.length > 0) {
      post("CONNECTORS_FOUND", {
        connectors: Array.from(state.connectors.values()),
        changed
      });
    }
  }

  function parseJsonishPayload(text, sourceUrl) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    try {
      const parsed = JSON.parse(trimmed);
      rememberConnectors(collectConnectors(parsed), sourceUrl);
      return;
    } catch (_jsonError) {
      // SSE chunks may include event metadata. Parse line-oriented data below.
    }

    const dataLines = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    for (const data of dataLines) {
      if (!data || data === "[DONE]") {
        continue;
      }
      try {
        const parsed = JSON.parse(data);
        rememberConnectors(collectConnectors(parsed), sourceUrl);
      } catch (_error) {
        // Ignore incomplete or non-JSON event payloads.
      }
    }
  }

  async function readBootstrapStream(response, sourceUrl) {
    if (!response || !response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const eventText = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          parseJsonishPayload(eventText, sourceUrl);
          boundary = buffer.indexOf("\n\n");
        }

        if (buffer.length > 200000) {
          parseJsonishPayload(buffer, sourceUrl);
          buffer = "";
        }
      }

      buffer += decoder.decode();
      parseJsonishPayload(buffer, sourceUrl);
    } catch (error) {
      post("AGENT_ERROR", {
        message: "Could not read Claude connector bootstrap stream.",
        detail: String(error && error.message ? error.message : error)
      });
    }
  }

  function shouldInspectMcpBootstrap(url) {
    if (!url) {
      return false;
    }
    return /\/mcp\/v2\/bootstrap\b/i.test(url.pathname) || /\/mcp\/v2\/bootstrap\b/i.test(url.href);
  }

  function scanPerformanceEntries() {
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const url = normalizeUrl(entry.name);
        rememberOrgFromUrl(url);
        if (shouldInspectMcpBootstrap(url)) {
          state.bootstrapUrls.add(url.href);
        }
      }
    } catch (_error) {
      // Performance access is best-effort.
    }
  }

  async function rescanBootstrap() {
    scanPerformanceEntries();
    const urls = Array.from(state.bootstrapUrls);
    if (urls.length === 0) {
      post("SCAN_RESULT", {
        ok: false,
        message: "No MCP bootstrap request has been observed yet. Reload the Claude connectors page and try again."
      });
      return;
    }

    for (const url of urls) {
      try {
        const response = await window.fetch(url, { credentials: "include" });
        if (!response.ok) {
          post("SCAN_RESULT", {
            ok: false,
            message: `Bootstrap request returned ${response.status}.`,
            url
          });
          continue;
        }
        readBootstrapStream(response.clone(), url);
      } catch (error) {
        post("SCAN_RESULT", {
          ok: false,
          message: "Could not refetch Claude connector bootstrap data.",
          detail: String(error && error.message ? error.message : error),
          url
        });
      }
    }
  }

  async function deleteConnector(orgUuid, serverUuid) {
    if (!uuidPattern.test(orgUuid || "") || !uuidPattern.test(serverUuid || "")) {
      post("DELETE_RESULT", {
        ok: false,
        orgUuid,
        serverUuid,
        status: 0,
        message: "Missing or invalid organization/server UUID."
      });
      return;
    }

    const endpoint = `/api/organizations/${orgUuid}/mcp/remote_servers/${serverUuid}`;
    try {
      const response = await window.fetch(endpoint, {
        method: "DELETE",
        credentials: "include"
      });

      if (response.status === 204 || response.ok) {
        state.connectors.delete(serverUuid);
      }

      post("DELETE_RESULT", {
        ok: response.status === 204 || response.ok,
        orgUuid,
        serverUuid,
        status: response.status,
        message:
          response.status === 204 || response.ok
            ? "Deleted connector."
            : `Claude returned HTTP ${response.status}.`
      });
      post("CONNECTORS_FOUND", {
        connectors: Array.from(state.connectors.values()),
        changed: []
      });
    } catch (error) {
      post("DELETE_RESULT", {
        ok: false,
        orgUuid,
        serverUuid,
        status: 0,
        message: "Delete request failed.",
        detail: String(error && error.message ? error.message : error)
      });
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function claudeConnectorRemoverFetch(input, init) {
    const url = normalizeUrl(input);
    rememberOrgFromUrl(url);

    const response = await originalFetch.apply(this, arguments);
    if (shouldInspectMcpBootstrap(url)) {
      state.bootstrapUrls.add(url.href);
      readBootstrapStream(response.clone(), url.href);
    }
    return response;
  };

  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
    const originalOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function open(method, url) {
      rememberOrgFromUrl(normalizeUrl(url));
      return originalOpen.apply(this, arguments);
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }

    const message = event.data;
    if (!message || message.source !== "claude-connector-remover-content") {
      return;
    }

    if (message.type === "GET_STATE") {
      scanPerformanceEntries();
      post("STATE", {
        orgUuid: state.orgUuid,
        connectors: Array.from(state.connectors.values()),
        bootstrapUrls: Array.from(state.bootstrapUrls)
      });
      return;
    }

    if (message.type === "RESCAN") {
      rescanBootstrap();
      return;
    }

    if (message.type === "DELETE_CONNECTOR") {
      deleteConnector(message.payload.orgUuid || state.orgUuid, message.payload.serverUuid);
    }
  });

  scanPerformanceEntries();
  post("READY", {
    orgUuid: state.orgUuid,
    connectors: Array.from(state.connectors.values())
  });
})();
