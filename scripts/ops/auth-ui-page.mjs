export function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderPage(options) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Broker Auth Admin</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f141b;
      --panel: #161d26;
      --panel-soft: #1d2631;
      --text: #edf2f7;
      --muted: #96a3b3;
      --line: #2b3642;
      --accent: #3fa7ff;
      --danger: #ff6b6b;
      --good: #4ade80;
      --warn: #fbbf24;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      margin: 0;
      background: linear-gradient(180deg, #0b1016 0%, #111a24 100%);
      color: var(--text);
      font-family: var(--sans);
    }
    .wrap {
      max-width: 1280px;
      margin: 0 auto;
      padding: 24px;
    }
    h1, h2, h3 {
      margin: 0;
      font-weight: 650;
      letter-spacing: -0.02em;
    }
    h1 {
      font-size: 30px;
      margin-bottom: 8px;
    }
    p {
      margin: 0;
      color: var(--muted);
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    button {
      border: 0;
      border-radius: 10px;
      background: var(--accent);
      color: white;
      padding: 10px 14px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    button.secondary {
      background: var(--panel-soft);
      color: var(--text);
      border: 1px solid var(--line);
    }
    button[disabled] {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 16px;
    }
    .card {
      background: rgba(22, 29, 38, 0.92);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 16px;
      padding: 18px;
      box-shadow: 0 12px 36px rgba(0,0,0,0.22);
    }
    .span-4 { grid-column: span 4; }
    .span-6 { grid-column: span 6; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .kv {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 8px 12px;
      margin-top: 14px;
    }
    .kv dt {
      color: var(--muted);
    }
    .kv dd {
      margin: 0;
      word-break: break-word;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 700;
      background: var(--panel-soft);
      border: 1px solid var(--line);
    }
    .good { color: var(--good); }
    .warn { color: var(--warn); }
    .danger { color: var(--danger); }
    .muted { color: var(--muted); }
    .mono {
      font-family: var(--mono);
      font-size: 12px;
    }
    .list {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: rgba(255,255,255,0.02);
    }
    .item-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      align-items: center;
    }
    .item-title {
      font-weight: 650;
      word-break: break-word;
    }
    .meta {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 13px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 14px;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
    }
    pre {
      margin: 0;
      padding: 12px;
      border-radius: 12px;
      background: #0a0f14;
      overflow: auto;
      border: 1px solid var(--line);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.45;
    }
    .form-grid {
      display: grid;
      gap: 12px;
      margin-top: 16px;
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 14px;
      color: var(--muted);
    }
    input[type="file"], input[type="number"] {
      width: 100%;
      border-radius: 10px;
      border: 1px solid var(--line);
      padding: 10px 12px;
      background: #0a0f14;
      color: var(--text);
      font: inherit;
    }
    .checkbox {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text);
    }
    .status-line {
      margin-top: 12px;
      min-height: 22px;
      color: var(--muted);
    }
    .hint {
      margin-top: 10px;
      font-size: 13px;
      color: var(--muted);
    }
    @media (max-width: 960px) {
      .span-4, .span-6, .span-8, .span-12 {
        grid-column: span 12;
      }
      .topbar {
        flex-direction: column;
        align-items: flex-start;
      }
      .kv {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div>
        <h1>Broker Auth Admin</h1>
        <p>Local-only control panel for the live Docker broker container.</p>
      </div>
      <div class="actions">
        <div class="badge mono">container: ${escapeHtml(options.containerName)}</div>
        <button class="secondary" id="refresh-button">Refresh now</button>
      </div>
    </div>

    <div class="grid">
      <section class="card span-4">
        <h2>Container</h2>
        <dl class="kv" id="container-card"></dl>
      </section>

      <section class="card span-4">
        <h2>Account</h2>
        <div id="account-card" class="list"></div>
      </section>

      <section class="card span-4">
        <h2>Auth Files</h2>
        <div id="auth-files-card" class="list"></div>
      </section>

      <section class="card span-8">
        <h2>Sessions</h2>
        <div class="hint">Shows the current live state under the mounted data root, including active turns and open inbound backlog.</div>
        <div id="sessions-panel" class="list"></div>
      </section>

      <section class="card span-4">
        <h2>Replace Auth</h2>
        <p>Upload a new <span class="mono">auth.json</span>. Optional MCP credential files can be replaced at the same time.</p>
        <form id="replace-form" class="form-grid">
          <label>
            auth.json
            <input type="file" name="authJson" accept=".json,application/json" required />
          </label>
          <label>
            .credentials.json (optional)
            <input type="file" name="credentialsJson" accept=".json,application/json" />
          </label>
          <label>
            config.toml (optional)
            <input type="file" name="configToml" accept=".toml,text/plain" />
          </label>
          <label class="checkbox">
            <input type="checkbox" name="allowActive" />
            Allow restart even if active sessions exist
          </label>
          <button id="replace-button" type="submit">Replace auth and restart</button>
          <div id="replace-status" class="status-line"></div>
        </form>
      </section>

      <section class="card span-6">
        <h2>Background Jobs</h2>
        <div id="jobs-panel" class="list"></div>
      </section>

      <section class="card span-6">
        <h2>Recent Broker Logs</h2>
        <pre id="logs-panel">Loading…</pre>
      </section>

      <section class="card span-12">
        <h2>Raw Status JSON</h2>
        <pre id="raw-status">Loading…</pre>
      </section>
    </div>
  </div>

  <script>
    const refreshButton = document.getElementById("refresh-button");
    const replaceForm = document.getElementById("replace-form");
    const replaceButton = document.getElementById("replace-button");
    const replaceStatus = document.getElementById("replace-status");
    const rawStatus = document.getElementById("raw-status");

    function esc(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function formatTime(value) {
      if (!value) return "—";
      try {
        return new Date(value).toLocaleString();
      } catch {
        return String(value);
      }
    }

    function renderContainer(data) {
      const card = document.getElementById("container-card");
      const healthBadge = data.health?.ok ? '<span class="good">healthy</span>' : '<span class="danger">unhealthy</span>';
      const readyBadge = data.ready?.ok ? '<span class="good">ready</span>' : '<span class="danger">not ready</span>';
      card.innerHTML = [
        ["Running", data.container.running ? "yes" : "no"],
        ["Status", esc(data.container.status ?? "unknown")],
        ["Started", esc(formatTime(data.container.startedAt))],
        ["Restart count", esc(data.container.restartCount ?? 0)],
        ["Host port", esc(data.container.hostPort ?? "—")],
        ["Data root", '<span class="mono">' + esc(data.container.dataRootSource ?? "—") + "</span>"],
        ["Health", healthBadge],
        ["Codex", readyBadge]
      ].map(([k, v]) => "<dt>" + k + "</dt><dd>" + v + "</dd>").join("");
    }

    function renderAccount(data) {
      const card = document.getElementById("account-card");
      const account = data.account ?? {};
      const rows = [];
      if (account.ok && account.account) {
        rows.push('<div class="item"><div class="item-head"><div class="item-title">Runtime account</div></div><div class="meta"><span>type: ' + esc(account.account.type ?? "—") + '</span><span>plan: ' + esc(account.account.planType ?? "—") + '</span><span>email: ' + esc(account.account.email ?? "—") + "</span></div></div>");
      } else {
        rows.push('<div class="item danger">Account lookup failed: ' + esc(account.error ?? "unknown error") + "</div>");
      }

      if (account.quota) {
        rows.push('<pre>' + esc(JSON.stringify(account.quota, null, 2)) + "</pre>");
      } else {
        rows.push('<div class="item"><div class="muted">' + esc(account.note ?? "No quota or usage fields were exposed by account/read.") + "</div></div>");
      }
      card.innerHTML = rows.join("");
    }

    function renderAuthFiles(data) {
      const card = document.getElementById("auth-files-card");
      const files = [
        ["auth.json", data.authFiles.authJson],
        [".credentials.json", data.authFiles.credentialsJson],
        ["config.toml", data.authFiles.configToml]
      ];
      card.innerHTML = files.map(([name, file]) => {
        const head = file.exists
          ? '<div class="meta"><span>size: ' + esc(file.size) + '</span><span>mtime: ' + esc(formatTime(file.mtime)) + "</span></div>"
          : '<div class="meta"><span class="warn">missing</span></div>';
        return '<div class="item"><div class="item-head"><div class="item-title mono">' + esc(name) + "</div></div>" + head + '<div class="hint mono">' + esc(file.path) + "</div></div>";
      }).join("");
    }

    function renderSessions(data) {
      const panel = document.getElementById("sessions-panel");
      const state = data.state;
      const active = state.activeSessions ?? [];
      const inbound = state.openInbound ?? [];
      const parts = [];

      parts.push(
        '<div class="item"><div class="item-head"><div class="item-title">Summary</div></div><div class="meta"><span>sessions: ' + esc(state.sessionCount) + '</span><span>active: ' + esc(state.activeCount) + '</span><span>open inbound: ' + esc(state.openInboundCount) + "</span></div></div>"
      );

      if (active.length === 0) {
        parts.push('<div class="item"><div class="muted">No active sessions.</div></div>');
      } else {
        parts.push(
          '<table><thead><tr><th>Session</th><th>Turn</th><th>Updated</th><th>Workspace</th></tr></thead><tbody>' +
            active.map((session) => '<tr><td class="mono">' + esc(session.sessionKey ?? "—") + '</td><td class="mono">' + esc(session.activeTurnId ?? "—") + '</td><td>' + esc(formatTime(session.updatedAt)) + '</td><td class="mono">' + esc(session.workspacePath ?? "—") + "</td></tr>").join("") +
          "</tbody></table>"
        );
      }

      if (inbound.length > 0) {
        parts.push(
          '<table><thead><tr><th>Status</th><th>Session</th><th>TS</th><th>Source</th><th>Preview</th></tr></thead><tbody>' +
            inbound.map((message) => '<tr><td>' + esc(message.status ?? "—") + '</td><td class="mono">' + esc(message.sessionKey ?? "—") + '</td><td class="mono">' + esc(message.messageTs ?? "—") + '</td><td>' + esc(message.source ?? "—") + '</td><td>' + esc(message.textPreview ?? message.text ?? message.eventType ?? "—") + "</td></tr>").join("") +
          "</tbody></table>"
        );
      }

      panel.innerHTML = parts.join("");
    }

    function renderJobs(data) {
      const panel = document.getElementById("jobs-panel");
      const jobs = data.state.backgroundJobs ?? [];
      if (jobs.length === 0) {
        panel.innerHTML = '<div class="item"><div class="muted">No background jobs.</div></div>';
        return;
      }

      panel.innerHTML = jobs.slice(0, 20).map((job) => {
        return '<div class="item"><div class="item-head"><div class="item-title mono">' + esc(job.jobId ?? "—") + '</div><div class="badge">' + esc(job.status ?? "unknown") + '</div></div><div class="meta"><span>session: ' + esc(job.sessionKey ?? "—") + '</span><span>updated: ' + esc(formatTime(job.updatedAt)) + '</span></div><div class="hint">' + esc(job.command ?? job.kind ?? "—") + "</div></div>";
      }).join("");
    }

    function renderLogs(data) {
      const panel = document.getElementById("logs-panel");
      panel.textContent = JSON.stringify(data.state.recentBrokerLogs ?? [], null, 2);
    }

    function renderStatus(data) {
      renderContainer(data);
      renderAccount(data);
      renderAuthFiles(data);
      renderSessions(data);
      renderJobs(data);
      renderLogs(data);
      rawStatus.textContent = JSON.stringify(data, null, 2);
    }

    async function refreshStatus() {
      refreshButton.disabled = true;
      try {
        const response = await fetch("/api/status", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to fetch status");
        renderStatus(payload);
      } catch (error) {
        rawStatus.textContent = String(error?.stack || error);
      } finally {
        refreshButton.disabled = false;
      }
    }

    refreshButton.addEventListener("click", refreshStatus);

    replaceForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      replaceButton.disabled = true;
      replaceStatus.textContent = "Uploading and replacing auth files…";
      try {
        const formData = new FormData(replaceForm);
        const response = await fetch("/api/replace-auth", {
          method: "POST",
          body: formData
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Auth replacement failed");
        replaceStatus.innerHTML = '<span class="good">Done.</span> ' + esc(payload.restartAction || "updated");
        await refreshStatus();
      } catch (error) {
        replaceStatus.innerHTML = '<span class="danger">' + esc(error.message || String(error)) + "</span>";
      } finally {
        replaceButton.disabled = false;
      }
    });

    refreshStatus();
    setInterval(refreshStatus, 10000);
  </script>
</body>
</html>`;
}
