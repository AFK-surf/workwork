import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { formatAuthQuotaDisplay, formatWeightedWeeklyQuotaScore, remainingPercent, weightedWeeklyQuotaScore, daysUntilReset } from "../auth-profile-quota";

import { profileAccountLabel, profilePlanLabel, profileTitle } from "./auth-profile-display";

import { connectAdminRealtime, getAdminStatusSnapshot, mergeAdminStatusSnapshot, publishAdminStatus, subscribeAdminStatus } from "./admin-status-store";

import { AdminSessionsView } from "./session-view";

import { statusLabel } from "./timeline-display";

import { AdminStatus, AdminView, Tone, OperationsView, DeployPanel, OperationRecords, AuthProfilesPanel, GitHubAccountsPanel } from "./admin-shell-helpers-1.js";
import {
  ReleaseRow,
  DeployTargetOption,
  buildDeployTargetOptions,
  targetLabel,
  ProfileQuotaMetrics,
  ProfileQuotaSummary,
  profileQuotaSummary,
  Badge,
  loadAdminStatus,
  loadAdminSessionsStatus,
  loadAdminOverview,
  loadAdminLogs,
  mergeStatusOverview,
  mergeStatusLogs,
  summarizeSessionRows,
  AdminRequestInit,
  requestJson,
  githubAccountDeviceStartApiPath,
  githubDevicePollApiPath,
  confirmInterruptRisk,
  publishStatusFromPayload,
  loadAdminView,
  persistAdminView,
  uiStateStorageKey,
  authProfileQuotaItems,
  normalizeGitHubAccounts,
} from "./admin-shell-helpers-3.js";
import {
  buildFallbackGitHubAccounts,
  normalizeSlackIdentity,
  mergeSlackIdentity,
  identityFromSessionMessage,
  githubBindingLabel,
  githubBindingTone,
  githubAccountOptionLabel,
  quotaTone,
  statusTone,
  operationLabel,
  pickOperationLabel,
  fmtTime,
  fmtDateTime,
  shortRevision,
  formatRelativeDuration,
  formatResetTime,
  errorMessage,
} from "./admin-shell-helpers-4.js";

export function LogsPanel({ logs }: { readonly logs: readonly Record<string, any>[] }): React.JSX.Element {
  return (
    <section className="panel ops-panel">
      <div className="panel-head">
        <div className="panel-title">系统日志</div>
      </div>
      <div className="log-list">
        {logs.length ? (
          logs.slice(0, 10).map((entry, index) => (
            <div className={"log-entry " + statusTone(entry.level)} key={`${entry.ts || index}-${entry.message || entry.raw || ""}`}>
              <span>{fmtTime(entry.ts)}</span>
              <span>{entry.message || entry.raw || ""}</span>
            </div>
          ))
        ) : (
          <div className="empty-state">暂无日志</div>
        )}
      </div>
    </section>
  );
}

export function ServicePanel({ service }: { readonly service: Record<string, any> }): React.JSX.Element {
  return (
    <section className="panel ops-panel">
      <div className="panel-head">
        <div className="panel-title">运行信息</div>
      </div>
      <div className="panel-body summary-detail" style={{ display: "grid", gap: 6 }}>
        <div>名称：{service.name || "--"}</div>
        <div>模式：{statusLabel(service.mode || "--")}</div>
        <div>端口：{service.port || "--"}</div>
        <div>启动：{fmtDateTime(service.startedAt)}</div>
        <div style={{ wordBreak: "break-all" }}>会话目录：{service.sessionsRoot || "--"}</div>
        <div style={{ wordBreak: "break-all" }}>CODEX_HOME: {service.codexHome || "--"}</div>
      </div>
    </section>
  );
}

export function AddProfileDialog({ onClose, onStatus }: { readonly onClose: () => void; readonly onStatus: (message: string | null) => void }): React.JSX.Element {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<Record<string, any> | null>(null);
  const [tick, setTick] = useState(0);
  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current != null) window.clearTimeout(pollTimerRef.current);
    };
  }, []);

  async function saveAuthJson(): Promise<void> {
    setBusy(true);
    setMessage("正在保存...");
    try {
      const content = text.trim() || (file ? await file.text() : "");
      if (!content) throw new Error("必须提供 auth.json");
      const payload = await requestJson("/admin/api/auth-profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auth_json_content: content }),
      });
      publishStatusFromPayload(payload);
      onStatus("认证档案已保存");
      onClose();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function startDeviceCode(): Promise<void> {
    if (pollTimerRef.current != null) window.clearTimeout(pollTimerRef.current);
    setBusy(true);
    setMessage("正在申请设备码...");
    setDeviceCode(null);
    try {
      const payload = await requestJson("/admin/api/auth-profiles/device-code/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const nextDeviceCode = payload.deviceCode;
      if (!nextDeviceCode?.deviceAuthId || !nextDeviceCode?.userCode || !nextDeviceCode?.verificationUrl) {
        throw new Error("设备码响应不完整");
      }
      setDeviceCode(nextDeviceCode);
      setMessage("等待登录确认...");
      schedulePoll(nextDeviceCode, Number(nextDeviceCode.intervalSeconds || 5));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function schedulePoll(current: Record<string, any>, intervalSeconds: number): void {
    if (pollTimerRef.current != null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = window.setTimeout(
      () => {
        void pollDeviceCode(current);
      },
      Math.max(1, Number(intervalSeconds) || 5) * 1000,
    );
  }

  async function pollDeviceCode(current: Record<string, any>): Promise<void> {
    if (Date.parse(String(current.expiresAt || "")) <= Date.now()) {
      setMessage("设备码已过期，重新申请一个。");
      setDeviceCode(null);
      return;
    }
    try {
      const payload = await requestJson("/admin/api/auth-profiles/device-code/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_auth_id: current.deviceAuthId,
          user_code: current.userCode,
          retry_after_seconds: current.intervalSeconds || 5,
        }),
      });
      if (payload.deviceCode?.status === "pending") {
        setMessage("等待登录确认...");
        const next = { ...current, ...payload.deviceCode };
        setDeviceCode(next);
        schedulePoll(next, Number(payload.deviceCode.retryAfterSeconds || current.intervalSeconds || 5));
        return;
      }
      if (payload.deviceCode?.status !== "complete") {
        throw new Error("设备码确认响应不完整");
      }
      publishStatusFromPayload(payload);
      onStatus("认证档案已保存");
      onClose();
    } catch (error) {
      setMessage(errorMessage(error));
      setDeviceCode(null);
    }
  }

  const remainingSeconds = deviceCode?.expiresAt ? Math.max(0, Math.ceil((Date.parse(String(deviceCode.expiresAt)) - Date.now() + tick * 0) / 1000)) : null;

  return (
    <dialog open>
      <div className="modal-content add-profile-modal">
        <div className="modal-heading">
          <div className="panel-title">添加账号</div>
          <div className="summary-detail">推荐使用设备码 OAuth</div>
        </div>
        <section className="auth-primary-card">
          <div className="auth-primary-copy">
            <div className="auth-primary-title">设备码 OAuth</div>
            <div className="summary-detail">浏览器完成登录后自动保存账号</div>
          </div>
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={() => {
              void startDeviceCode();
            }}
          >
            开始设备码登录
          </button>
        </section>
        {deviceCode ? (
          <div className="device-code-panel">
            <div className="device-code-row">
              <span>登录页面</span>
              <a className="link-button" href={String(deviceCode.verificationUrl)} target="_blank" rel="noreferrer">
                打开
              </a>
            </div>
            <div className="device-code-label">一次性代码</div>
            <div className="code-block">{String(deviceCode.userCode || "")}</div>
            <div className="summary-detail">{remainingSeconds == null ? "" : `剩余 ${Math.ceil(remainingSeconds / 60)} 分钟`}</div>
          </div>
        ) : null}
        <details className="auth-json-fallback" open={fallbackOpen} onToggle={(event) => setFallbackOpen(event.currentTarget.open)}>
          <summary>备用：导入 auth.json</summary>
          <div className="fallback-body">
            <input type="file" accept="application/json,.json" onChange={(event) => setFile(event.currentTarget.files?.[0] || null)} />
            <textarea placeholder="在这里粘贴 auth.json..." value={text} onChange={(event) => setText(event.target.value)} />
            <div className="fallback-actions">
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  void saveAuthJson();
                }}
              >
                保存 auth.json
              </button>
            </div>
          </div>
        </details>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onClose}>
            取消
          </button>
        </div>
        {message ? <div className="summary-detail">{message}</div> : null}
      </div>
    </dialog>
  );
}

export function GitHubAccountBindDialog({ account, onClose, onStatus }: { readonly account: Record<string, any>; readonly onClose: () => void; readonly onStatus: (message: string | null) => void }): React.JSX.Element {
  const [device, setDevice] = useState<Record<string, any> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const startedRef = useRef(false);
  const identity = account.slackIdentity || {};
  const label = identity.realName || identity.displayName || identity.username || account.slackUserId;

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    void startGitHubAccountDeviceAuthorization();
  }, [account.slackUserId]);

  useEffect(() => {
    if (!device?.id) {
      return;
    }
    let cancelled = false;
    let timeout: number | undefined;
    async function poll(): Promise<void> {
      try {
        const payload = (await requestJson(githubDevicePollApiPath(String(device.id)))) as Record<string, any>;
        const result = payload.result as Record<string, any>;
        if (cancelled) return;
        if (result.status === "completed") {
          setDevice(null);
          setMessage("GitHub 账号已绑定。");
          onStatus("GitHub 账号已绑定");
          publishAdminStatus(await loadAdminStatus());
          return;
        }
        if (result.status === "expired") {
          setMessage("设备码已过期，请重新发起绑定。");
          setDevice(null);
          return;
        }
        if (result.status === "failed") {
          setMessage(String(result.error || "绑定失败"));
          setDevice(null);
          return;
        }
        timeout = window.setTimeout(
          () => {
            void poll();
          },
          Math.max(1, Number(result.retryAfterSeconds || device.intervalSeconds || 5)) * 1000,
        );
      } catch (error) {
        if (!cancelled) setMessage(errorMessage(error));
      }
    }
    timeout = window.setTimeout(() => {
      void poll();
    }, 800);
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [device?.id]);

  async function startGitHubAccountDeviceAuthorization(): Promise<void> {
    setBusy(true);
    setMessage("正在申请 GitHub 设备码...");
    try {
      const payload = (await requestJson(githubAccountDeviceStartApiPath(String(account.slackUserId)), { method: "POST" })) as Record<string, any>;
      setDevice(payload.device as Record<string, any>);
      setMessage("打开 GitHub 验证页，输入下面的代码完成绑定。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog open>
      <div className="modal-content">
        <div className="modal-heading">
          <div className="panel-title">绑定 GitHub</div>
          <div className="summary-detail">
            {label} · {account.slackUserId}
          </div>
        </div>
        {device ? (
          <div className="device-code-panel">
            <div className="device-code-label">GitHub 设备码</div>
            <div className="code-block">{String(device.userCode || "")}</div>
            <a className="link-button" href={String(device.verificationUriComplete || device.verificationUri || "https://github.com/login/device")} target="_blank" rel="noreferrer">
              打开 GitHub 验证页
            </a>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="secondary" type="button" onClick={onClose}>
            取消
          </button>
          {!device && !busy ? (
            <button
              className="primary"
              type="button"
              onClick={() => {
                void startGitHubAccountDeviceAuthorization();
              }}
            >
              重新申请
            </button>
          ) : null}
        </div>
        {message ? <div className="summary-detail">{message}</div> : null}
      </div>
    </dialog>
  );
}

export function TopbarQuota({ profiles }: { readonly profiles: readonly Record<string, any>[] }): React.JSX.Element {
  const quotaItems = useMemo(() => authProfileQuotaItems(profiles), [profiles]);
  return (
    <div className="topbar-center">
      {quotaItems.length ? (
        quotaItems.map((item) => (
          <span className={"quota-pill " + quotaTone(item.remaining)} title={item.title} key={item.title}>
            <strong>{item.label}</strong>
          </span>
        ))
      ) : (
        <span className="quota-meta">账号池额度未知</span>
      )}
    </div>
  );
}

export function RiskPanel({ state }: { readonly state: Record<string, any> }): React.JSX.Element {
  const active = Number(state.activeCount || 0);
  const open = Number(state.openInboundCount || 0);
  const running = Number(state.runningBackgroundJobCount || 0);
  const safe = active + open + running === 0;
  return (
    <>
      <div className="risk-strip">
        <RiskCell label="活跃" value={active} />
        <RiskCell label="待处理" value={open} />
        <RiskCell label="运行" value={running} />
      </div>
      <div className="risk-copy">{safe ? "当前没有活跃工作，发布和回滚不需要额外确认。" : "发布和回滚会中断正在进行的管理工作，执行前必须显式确认。"}</div>
    </>
  );
}

export function RiskCell({ label, value, danger = false }: { readonly label: string; readonly value: number; readonly danger?: boolean }): React.JSX.Element {
  return (
    <div className="risk-cell">
      <div className="risk-number" style={danger ? { color: "var(--red)" } : undefined}>
        {value}
      </div>
      <div className="risk-label">{label}</div>
    </div>
  );
}

export function DeploymentPanel({ deployment }: { readonly deployment: any }): React.JSX.Element {
  if (!deployment) {
    return <div className="summary-detail">发布状态不可用</div>;
  }
  if (deployment.ok === false) {
    return <div className="summary-detail danger">发布状态读取失败：{deployment.error || "unknown"}</div>;
  }
  const admin = deployment.admin || {};
  const worker = deployment.worker || {};
  const targets = deployment.targets || {};
  return (
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Badge label={admin.launchdLoaded ? "管理进程已加载" : "管理进程未运行"} tone={admin.launchdLoaded ? "good" : "danger"} />
        <Badge label={admin.healthOk ? "管理 HTTP 正常" : "管理 HTTP 异常"} tone={admin.healthOk ? "good" : "danger"} />
        <Badge label={worker.launchdLoaded ? "工作进程已加载" : "工作进程未运行"} tone={worker.launchdLoaded ? "good" : "danger"} />
        <Badge label={worker.healthOk ? "HTTP 正常" : "HTTP 异常"} tone={worker.healthOk ? "good" : "danger"} />
        <Badge label={worker.readyOk ? "Codex 就绪" : "Codex 异常"} tone={worker.readyOk ? "good" : "danger"} />
      </div>
      <div className="release-current-grid">
        <ReleaseTargetPanel target="worker" status={targets.worker} />
        <ReleaseTargetPanel target="admin" status={targets.admin} />
      </div>
    </>
  );
}

export function ReleaseTargetPanel({ target, status }: { readonly target: "admin" | "worker"; readonly status: any }): React.JSX.Element {
  return (
    <div className="release-stack">
      <div className="profile-line">
        <span className="profile-account">{targetLabel(target)}</span>
        <span className="profile-plan">{status?.packageName || "package"}</span>
      </div>
      <ReleaseRow label="当前版本" release={status?.currentRelease} />
    </div>
  );
}
