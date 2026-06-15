# Claude Connector Remover

Unpacked Chrome extension for removing remote MCP connectors from Claude's connectors page.

Claude currently exposes a working delete endpoint, but the web UI does not provide a delete action for every account. This extension observes Claude's own connector bootstrap requests, extracts the organization UUID and connector server UUIDs, and calls:

```txt
DELETE /api/organizations/{ORG_UUID}/mcp/remote_servers/{SERVER_UUID}
```

using your existing signed-in `claude.ai` browser session.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `remove-claude-connectors`.
5. Open or reload `https://claude.ai/customize/connectors`.

## Use

1. Visit `https://claude.ai/customize/connectors` while signed in.
2. Use the **Connector Remover** panel in the upper-right corner.
3. If the list is empty, click **Reload page** so the extension can observe Claude's bootstrap calls from page start.
4. Confirm deletion for the specific connector.
5. Refresh Claude's connectors page after deletion. Claude Desktop may also need `Ctrl+R` or `Ctrl+Shift+R` because it caches connector data locally.

## Notes

- The extension only runs on `https://claude.ai/customize/connectors*`.
- It does not store connector data outside the page.
- Delete requests are performed in Claude's page context so normal Claude authentication cookies are used.
- Claude may change these private endpoints or response shapes at any time.
