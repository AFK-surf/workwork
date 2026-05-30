import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { profileDisplayLabel, profileIsSelectable, profileOptionLabel, profileQuotaLabel, profileSessionActionLabel, profileTitle } from "./auth-profile-display";

import { applyAdminRealtimeEvent, getAdminStatusSnapshot, getTimelineSnapshot, publishTimelinePayload, subscribeAdminStatus, subscribeTimeline } from "./admin-status-store";

import { agentTranscriptAvatar, agentTranscriptKind, agentTranscriptSpeaker } from "./agent-transcript-display";

import { requestCancelSessionJob } from "./session-job-actions";

import { stableSessionOrder } from "./session-order";

import { activeBackgroundJobCount, activeBackgroundJobs, buildChannelLabelById, renderSessionMeta, resolveSessionChannelLabel, sessionActivityAt, sessionActivityMs, sessionAuthBlockActive, sessionQueueState, shouldShowSessionState } from "./session-row-display";

import type { SessionQueueState } from "./session-row-display";

import { filterVisibleTimelineEvents, getTimelineEventDisplay, statusLabel, type TimelineEvent } from "./timeline-display";

import {
  UiState,
  SessionRecord,
  TimelinePayload,
  timelinePayloadSession,
  mergeSessionRecords,
  sessionFilters,
  AUTO_AUTH_PROFILE_VALUE,
  TIMELINE_PAGE_SIZE,
  TIMELINE_AUTO_LOAD_THRESHOLD,
  GitHubBindPage,
  SessionPermalinkView,
  SessionRow,
  SessionDetail,
  AgentSessionHero,
  SessionActions,
} from "./session-view-helpers-1.js";
import { GitHubIdentityPanel, GitHubBindingFlow, GitHubBindingIntro, SessionResetButton, SessionRuntimePanel, MetaLine, SessionDebugPanel, SessionTraceStats } from "./session-view-helpers-2.js";
import { SessionTimeline, AuthProfilePanel, initialAuthProfileSelection, TimelinePayloadView, mergeTimelinePayloads, mergeTimelineEvents, TraceSummary, Timeline } from "./session-view-helpers-3.js";
import {
  sessionTimelineApiPath,
  sessionTimelineEventApiPath,
  slackThreadUrlApiPath,
  githubIdentityApiPath,
  githubDeviceStartApiPath,
  githubDevicePollApiPath,
  adminSessionPath,
  readGitHubBindSessionKey,
  readPermalinkSessionKey,
  decodePathSegment,
  loadUiState,
  persistUiState,
  uiStateStorageKey,
  defaultUiState,
  normalizeUiState,
  classSafeValue,
  statusTone,
  toolTimelineStatusLabel,
  jobCancellable,
  sourceLabel,
  timelineEventKey,
  timelineEventIdentity,
  timestampMs,
  newestTimestamp,
  fmtTime,
  fmtDateTime,
  fmtRelativeTime,
  fmtTokens,
  fmtPercent,
  shortValue,
} from "./session-view-helpers-5.js";

export function TimelineRow({ event }: { readonly event: TimelineEvent }): React.JSX.Element {
  const [detail, setDetail] = useState<string | null>(typeof event.detail === "string" ? event.detail : null);
  const [detailStatus, setDetailStatus] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const display = getTimelineEventDisplay(event);
  const badgeTone = statusTone(event.status === "failed" || event.status === "error" ? event.status : event.type);
  const kind = agentTranscriptKind(event);
  const toolTone = kind === "tool" ? statusTone(event.status || event.type) || badgeTone || "info" : "";
  const rowTone = kind === "tool" ? toolTone : badgeTone;
  const speaker = agentTranscriptSpeaker(kind, event);
  const isNotice = kind === "system" || kind === "session";
  const isCommandEvent = event.toolName === "exec_command";
  const canLoadDetail = Boolean(event.detailAvailable && event.id && event.sessionKey);
  const meta = [kind !== "tool" && kind !== "user" && kind !== "assistant" && kind !== "bot" && event.status ? statusLabel(event.status) : "", !isCommandEvent && event.toolName ? "工具 " + event.toolName : "", event.detailTruncated ? "内容已截断" : ""].filter(Boolean).join(" · ");

  useEffect(() => {
    setDetail(typeof event.detail === "string" ? event.detail : null);
    setDetailStatus(null);
    setDetailOpen(false);
  }, [event.id, event.detail]);

  async function loadDetail(): Promise<void> {
    if (detail || detailStatus === "loading" || !canLoadDetail) {
      return;
    }
    setDetailStatus("loading");
    try {
      const payload = (await requestJson(sessionTimelineEventApiPath(String(event.sessionKey), String(event.id)))) as Record<string, any>;
      const nextDetail = typeof payload.event?.detail === "string" ? payload.event.detail : "";
      setDetail(nextDetail || "没有详情");
      setDetailStatus(null);
    } catch (error) {
      setDetailStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function toggleDetail(): Promise<void> {
    const nextOpen = !detailOpen;
    setDetailOpen(nextOpen);
    if (nextOpen) {
      await loadDetail();
    }
  }

  function renderTraceDetails(): React.JSX.Element | null {
    if (!detail && !canLoadDetail) {
      return null;
    }
    return (
      <button
        type="button"
        className={"trace-details-button" + (detailOpen ? " open" : "")}
        aria-label="查看详情"
        title={detailOpen ? "收起详情" : "查看详情"}
        onClick={() => {
          void toggleDetail();
        }}
      >
        <span aria-hidden="true" className="trace-details-icon">
          i
        </span>
      </button>
    );
  }

  function renderTraceDetailPanel(): React.JSX.Element | null {
    if (!detailOpen) {
      return null;
    }
    return <pre className="trace-detail-panel">{detail || (detailStatus === "loading" ? "正在加载" : detailStatus || "")}</pre>;
  }

  return (
    <div className={"agent-message agent-message-" + kind + " " + rowTone}>
      <div className="agent-message-avatar" aria-hidden="true">
        {agentTranscriptAvatar(kind)}
      </div>
      <article className="agent-message-body">
        {isNotice ? (
          <div className="agent-notice">
            <span className="agent-notice-kind">{speaker}</span>
            <time dateTime={String(event.at || "")} title={fmtDateTime(event.at)}>
              {fmtTime(event.at)}
            </time>
            <Badge label={display.badgeLabel} tone={badgeTone} />
            <strong title={display.title}>{display.title}</strong>
            {display.summary ? <span title={display.summary}>{display.summary}</span> : null}
            {meta ? (
              <em className="trace-meta" title={meta}>
                {meta}
              </em>
            ) : null}
            {renderTraceDetails()}
          </div>
        ) : (
          <div className="agent-message-head">
            <strong className="agent-speaker">{speaker}</strong>
            <time dateTime={String(event.at || "")} title={fmtDateTime(event.at)}>
              {fmtTime(event.at)}
            </time>
            {kind === "tool" ? <Badge label={display.badgeLabel} tone={badgeTone} /> : null}
            {meta ? (
              <span className="trace-meta" title={meta}>
                {meta}
              </span>
            ) : null}
            {kind === "tool" ? null : renderTraceDetails()}
          </div>
        )}
        {!isNotice && kind === "tool" ? (
          <div className={"agent-tool-step " + toolTone}>
            <div>
              <strong title={display.title}>{display.title}</strong>
              {display.summary ? <em title={display.summary}>{display.summary}</em> : null}
            </div>
            <span className="agent-tool-status">{toolTimelineStatusLabel(event)}</span>
            {renderTraceDetails()}
          </div>
        ) : !isNotice ? (
          <div className="agent-message-content">
            <p title={display.title}>{display.title}</p>
            {display.summary ? <span title={display.summary}>{display.summary}</span> : null}
          </div>
        ) : null}
        {renderTraceDetailPanel()}
      </article>
    </div>
  );
}

export function SessionUsagePanel({ sessionKey, usage }: { readonly sessionKey: string; readonly usage: Record<string, any> }): React.JSX.Element {
  const timelineSnapshot = useSyncExternalStore(
    (listener) => subscribeTimeline(sessionKey, listener),
    () => getTimelineSnapshot(sessionKey),
    () => getTimelineSnapshot(sessionKey),
  );
  const payload = timelineSnapshot.payload as TimelinePayload | null;
  const trace = payload && !Array.isArray(payload) ? payload.trace : null;
  return <SessionUsage usage={usage} modelRequestCount={Number(trace?.modelRequestCount || 0)} />;
}

export function SessionUsage({ usage, modelRequestCount }: { readonly usage: Record<string, any>; readonly modelRequestCount: number }): React.JSX.Element {
  const exact = Number(usage?.exactTurns || 0);
  const total = Number(usage?.turnCount || 0);
  const totalTokens = Number(usage?.totalTokens || 0);
  const inputTokens = Number(usage?.inputTokens || 0);
  const cachedInputTokens = Number(usage?.cachedInputTokens || 0);
  const outputTokens = Number(usage?.outputTokens || 0);
  const reasoningTokens = Number(usage?.reasoningTokens || 0);
  const missingTurns = Number(usage?.missingTurns || 0);
  const estimatedTurns = Number(usage?.estimatedTurns || 0);
  const cacheHitRate = inputTokens > 0 ? cachedInputTokens / inputTokens : null;
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const generatedTokens = outputTokens + reasoningTokens;
  const exactRate = total > 0 ? exact / total : 0;
  const totalDetail = modelRequestCount > 0 ? total + " 个 Slack 回合 · " + modelRequestCount + " 次模型请求" : total + " 个 Slack 回合";
  if (!total) return <div className="summary-detail">这个会话还没有用量记录</div>;
  return (
    <div className="quota-grid">
      <UsageMetric label="总消耗" value={fmtTokens(totalTokens)} detail={totalDetail} />
      <UsageMetric label="非缓存输入" value={fmtTokens(uncachedInputTokens)} detail={"缓存覆盖 " + (cacheHitRate === null ? "无输入" : fmtPercent(cacheHitRate))} />
      <UsageMetric label="生成 Token" value={fmtTokens(generatedTokens)} detail={"输出 " + fmtTokens(outputTokens) + " · 推理 " + fmtTokens(reasoningTokens)} />
      {missingTurns || estimatedTurns ? <UsageMetric label="记录完整度" value={fmtPercent(exactRate)} detail={"估算 " + estimatedTurns + " · 缺失 " + missingTurns} /> : null}
      <details className="usage-raw-details">
        <summary>原始计数</summary>
        <div className="usage-raw-grid">
          <QuotaLine label="输入" value={fmtTokens(inputTokens)} detail={"缓存 " + fmtTokens(cachedInputTokens)} />
          <QuotaLine label="非缓存" value={fmtTokens(uncachedInputTokens)} detail={"缓存覆盖 " + (cacheHitRate === null ? "无输入" : fmtPercent(cacheHitRate))} />
          <QuotaLine label="输出" value={fmtTokens(outputTokens)} detail={"推理 " + fmtTokens(reasoningTokens)} />
          <QuotaLine label="记录" value={exact + "/" + total} detail={"估算 " + estimatedTurns + " · 缺失 " + missingTurns} />
          {usage.model || usage.effort ? <QuotaLine label="模型" value={String(usage.model || "未知")} detail={String(usage.effort || "默认")} /> : null}
        </div>
      </details>
    </div>
  );
}

export function UsageMetric({ label, value, detail }: { readonly label: string; readonly value: string; readonly detail: string }): React.JSX.Element {
  return (
    <div className="usage-metric">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
      <em title={detail}>{detail}</em>
    </div>
  );
}

export function QuotaLine({ label, value, detail }: { readonly label: string; readonly value: string; readonly detail: string }): React.JSX.Element {
  return (
    <div className="quota-line">
      <span>{label}</span>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

export function InboundTable({ items }: { readonly items: readonly Record<string, any>[] }): React.JSX.Element {
  if (!items.length)
    return (
      <div className="summary-detail" style={{ marginBottom: 8 }}>
        没有待处理消息
      </div>
    );
  return (
    <table className="table">
      <thead>
        <tr>
          <th>来源</th>
          <th>消息</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={(item.id || item.createdAt || item.textPreview || "") + ":" + index}>
            <td>{sourceLabel(item.source)}</td>
            <td>{item.textPreview || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function JobsTable({ session, jobs, expectedCount }: { readonly session: SessionRecord; readonly jobs: readonly Record<string, any>[]; readonly expectedCount?: number }): React.JSX.Element {
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const sessionKey = String(session.key || "");

  async function cancelJob(job: Record<string, any>): Promise<void> {
    const jobId = String(job.id || "");
    if (!sessionKey || !jobId || !jobCancellable(job)) {
      return;
    }
    const confirmed = window.confirm("确认取消这个后台任务？");
    if (!confirmed) {
      return;
    }

    setBusyJobId(jobId);
    setMessage(null);
    try {
      const payload = await requestCancelSessionJob(sessionKey, jobId);
      if (payload.session && typeof payload.session === "object") {
        applyAdminRealtimeEvent({
          sequence: 0,
          kind: "session.update",
          scope: "session",
          sessionKey,
          session: payload.session,
          createdAt: new Date().toISOString(),
        });
      }
      const timelinePayload = await requestJson(sessionTimelineApiPath(sessionKey, { limit: TIMELINE_PAGE_SIZE }));
      publishTimelinePayload(sessionKey, timelinePayload as TimelinePayload);
      setMessage("已取消 job");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyJobId(null);
    }
  }

  if (!jobs.length) return <div className="summary-detail">{expectedCount ? "任务明细加载中" : "没有运行任务"}</div>;
  return (
    <>
      <table className="table" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>状态</th>
            <th>类型</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {jobs.slice(0, 5).map((job, index) => {
            const jobId = String(job.id || "");
            const cancellable = jobCancellable(job);
            return (
              <tr key={(job.id || job.kind || "") + ":" + index}>
                <td>
                  <Badge label={job.status || "unknown"} tone={statusTone(job.status)} />
                </td>
                <td>{job.kind || ""}</td>
                <td>
                  {cancellable ? (
                    <button
                      type="button"
                      className="danger"
                      disabled={busyJobId === jobId || !sessionKey || !jobId}
                      onClick={() => {
                        void cancelJob(job);
                      }}
                    >
                      {busyJobId === jobId ? "取消中" : "取消"}
                    </button>
                  ) : (
                    <span className="summary-detail">-</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {message ? (
        <div className="summary-detail" style={{ marginTop: 8 }}>
          {message}
        </div>
      ) : null}
    </>
  );
}

export function Badge({ label, tone, title }: { readonly label: unknown; readonly tone?: string; readonly title?: string }): React.JSX.Element {
  return (
    <span className={"badge " + (tone || statusTone(label))} title={title}>
      {statusLabel(label)}
    </span>
  );
}

export function sessionMatchesFilter(session: SessionRecord, mode: string, authProfileByName?: ReadonlyMap<string, SessionRecord>): boolean {
  const authProfile = session.authProfileName ? authProfileByName?.get(String(session.authProfileName)) : null;
  if (mode === "ongoing" && !session.activeTurnId && !session.openInboundCount && !activeBackgroundJobCount(session)) return false;
  if (mode === "active" && !session.activeTurnId) return false;
  if (mode === "inbound" && !session.openInboundCount) return false;
  if (mode === "jobs" && !activeBackgroundJobCount(session)) return false;
  if (mode === "issues" && !sessionAuthBlockActive(session, authProfile)) return false;
  if (mode === "usage" && !session.usage?.turnCount) return false;
  return true;
}

export function resolveSelectedSession(sessions: readonly SessionRecord[], selectedSessionKey: string | null): SessionRecord | null {
  if (!sessions.length) return null;
  return sessions.find((session) => session.key === selectedSessionKey) || sessions[0] || null;
}

export function sessionPrimaryText(session: SessionRecord): string {
  return messagePreview(session.lastUserMessage) || summarizeSessionLead(session);
}

export function sessionFirstText(session: SessionRecord): string {
  return messagePreview(session.firstUserMessage) || "没有用户消息";
}

export function messagePreview(message: Record<string, any> | undefined): string {
  return String(message?.textPreview || message?.text || "").trim();
}

export function summarizeSessionLead(session: SessionRecord): string {
  if (session.lastUserMessage) return messagePreview(session.lastUserMessage) || "用户消息";
  if (session.openInbound?.length) return session.openInbound[0].textPreview || "新消息";
  if (session.activeTurnId) {
    const signal = session.lastTurnSignalKind ? statusLabel(session.lastTurnSignalKind) + (session.lastTurnSignalReason ? "：" + session.lastTurnSignalReason : "") : "正在运行";
    return "当前回合：" + shortValue(session.activeTurnId, 18) + " · " + signal;
  }
  const activeJob = activeBackgroundJobs(session)[0];
  if (activeJob) {
    const running = activeJob;
    return (running.kind || "任务") + "（" + statusLabel(running.status || "?") + "）";
  }
  if (session.lastTurnSignalKind) return statusLabel(session.lastTurnSignalKind) + (session.lastTurnSignalReason ? "：" + session.lastTurnSignalReason : "");
  if (session.usage?.turnCount) return "最近消耗：" + fmtTokens(session.usage.totalTokens || 0) + " · " + (session.usage.turnCount || 0) + " 回合";
  return "空闲";
}

export function compareSessionsForMode(mode: string, left: SessionRecord, right: SessionRecord, authProfileByName?: ReadonlyMap<string, SessionRecord>): number {
  if (mode === "usage") {
    const tokenDelta = Number(right.usage?.totalTokens || 0) - Number(left.usage?.totalTokens || 0);
    if (tokenDelta) return tokenDelta;
  }
  if (mode === "all") {
    const activityDelta = sessionActivityMs(right) - sessionActivityMs(left);
    if (activityDelta) return activityDelta;
  }
  const rightProfile = right.authProfileName ? authProfileByName?.get(String(right.authProfileName)) : null;
  const leftProfile = left.authProfileName ? authProfileByName?.get(String(left.authProfileName)) : null;
  const rankDelta = sessionQueueState(right, rightProfile).rank - sessionQueueState(left, leftProfile).rank;
  if (rankDelta) return rankDelta;
  const activityDelta = sessionActivityMs(right) - sessionActivityMs(left);
  if (activityDelta) return activityDelta;
  return String(left.key).localeCompare(String(right.key));
}

export async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const payload = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok || payload.ok === false) throw new Error(payload.error || response.statusText || "请求失败");
  return payload;
}
