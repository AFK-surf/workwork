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
import { TimelineRow, SessionUsagePanel, SessionUsage, UsageMetric, QuotaLine, InboundTable, JobsTable, Badge, sessionMatchesFilter, resolveSelectedSession, sessionPrimaryText, sessionFirstText, messagePreview, summarizeSessionLead, compareSessionsForMode, requestJson } from "./session-view-helpers-4.js";
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

export function SessionTimeline({ session }: { readonly session: SessionRecord }): React.JSX.Element {
  const sessionKey = String(session.key || "");
  const timelineSnapshot = useSyncExternalStore(
    (listener) => subscribeTimeline(sessionKey, listener),
    () => getTimelineSnapshot(sessionKey),
    () => getTimelineSnapshot(sessionKey),
  );
  const payload = timelineSnapshot.payload as TimelinePayload | null;
  const [error, setError] = useState<string | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void requestJson(sessionTimelineApiPath(sessionKey, { limit: TIMELINE_PAGE_SIZE }))
      .then((nextPayload) => {
        if (cancelled) return;
        publishTimelinePayload(sessionKey, nextPayload as TimelinePayload);
      })
      .catch((nextError: unknown) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (!payload || Array.isArray(payload) || olderBusy || !payload.page?.hasMore || !payload.page.nextBeforeSequence) {
      return;
    }
    setOlderBusy(true);
    setError(null);
    try {
      const olderPayload = (await requestJson(
        sessionTimelineApiPath(sessionKey, {
          limit: TIMELINE_PAGE_SIZE,
          beforeSequence: payload.page.nextBeforeSequence,
        }),
      )) as TimelinePayload;
      publishTimelinePayload(sessionKey, mergeTimelinePayloads(getTimelineSnapshot(sessionKey).payload as TimelinePayload | null, olderPayload));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setOlderBusy(false);
    }
  }, [olderBusy, payload, sessionKey]);

  useEffect(() => {
    if (!payload || Array.isArray(payload) || olderBusy || !payload.page?.hasMore) {
      return;
    }
    const visibleCount = filterVisibleTimelineEvents(payload.events || []).length;
    if (visibleCount >= TIMELINE_PAGE_SIZE) {
      return;
    }
    void loadOlder();
  }, [loadOlder, olderBusy, payload]);

  if (error) return <div className="summary-detail">{error}</div>;
  if (!payload) return <Timeline events={[{ at: session.createdAt, type: "session", title: "已创建" }]} />;
  const page = !Array.isArray(payload) ? payload.page : null;
  return (
    <div className="timeline-shell">
      <TimelinePayloadView payload={payload} hasMore={Boolean(page?.hasMore)} olderBusy={olderBusy} onLoadOlder={loadOlder} />
    </div>
  );
}

export function AuthProfilePanel({ session, profiles, currentProfile: providedCurrentProfile }: { readonly session: SessionRecord; readonly profiles: readonly SessionRecord[]; readonly currentProfile?: SessionRecord | undefined }): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const currentProfile = providedCurrentProfile ?? profiles.find((profile) => profile.name === session.authProfileName);
  const currentLabel = currentProfile ? profileDisplayLabel(currentProfile) : session.authProfileName ? "账号状态加载中" : "未绑定";
  const blocked = sessionAuthBlockActive(session, currentProfile);
  const actionLabel = currentProfile ? profileSessionActionLabel(currentProfile) : blocked ? "账号不可用" : "账号";
  const [selected, setSelected] = useState(() => initialAuthProfileSelection(session, blocked));

  useEffect(() => {
    setSelected(initialAuthProfileSelection(session, blocked));
    setMessage(null);
  }, [blocked, session.key, session.authProfileName, session.authBlockedAt]);

  function openDialog(): void {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
      return;
    }
    dialog.setAttribute("open", "");
  }

  function closeDialog(): void {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.close === "function") {
      dialog.close();
      return;
    }
    dialog.removeAttribute("open");
  }

  async function switchProfile(): Promise<void> {
    const autoSelected = selected === AUTO_AUTH_PROFILE_VALUE;
    if (!autoSelected && (!selected || selected === session.authProfileName)) {
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      await requestJson("/admin/api/sessions/" + encodeURIComponent(String(session.key || "")) + "/auth-profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(autoSelected ? { mode: "auto" } : { name: selected }),
      });
      const timelinePayload = await requestJson(sessionTimelineApiPath(String(session.key || ""), { limit: TIMELINE_PAGE_SIZE }));
      publishTimelinePayload(String(session.key || ""), timelinePayload as TimelinePayload);
      setMessage(autoSelected ? "已自动分配，正在恢复待处理消息" : "已切换，正在恢复待处理消息");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-profile-panel">
      <button type="button" className={"auth-profile-detail-button " + (blocked ? "danger" : "")} title={currentProfile ? profileTitle(currentProfile) : currentLabel} onClick={openDialog}>
        <span>账号额度</span>
        <strong>{actionLabel}</strong>
      </button>
      <dialog ref={dialogRef} className="auth-profile-dialog">
        <div className="modal-content">
          <div className="modal-heading">
            <div className="panel-title">账号接管</div>
            <div className="summary-detail" title={currentProfile ? profileTitle(currentProfile) : currentLabel}>
              {currentLabel}
            </div>
          </div>
          {currentProfile ? (
            <div className="auth-profile-dialog-current">
              <span>额度</span>
              <strong>{profileQuotaLabel(currentProfile)}</strong>
            </div>
          ) : null}
          {blocked ? (
            <div className="auth-profile-blocked">
              <Badge label="等待手动切换" tone="danger" />
              <span>{session.authBlockReasonLabel || session.authBlockReason || "账号不可用"}</span>
            </div>
          ) : null}
          <div className="auth-profile-switcher">
            <span className="auth-profile-label">账号</span>
            <select value={selected} title={currentProfile ? profileTitle(currentProfile) : currentLabel} onChange={(event) => setSelected(event.target.value)}>
              <option value="">选择账号</option>
              <option value={AUTO_AUTH_PROFILE_VALUE}>自动分配（按额度规则）</option>
              {profiles.map((profile) => (
                <option key={profile.name} value={profile.name} disabled={!profileIsSelectable(profile)}>
                  {profileOptionLabel(profile)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="link-button"
              disabled={busy || (selected !== AUTO_AUTH_PROFILE_VALUE && (!selected || selected === session.authProfileName))}
              onClick={() => {
                void switchProfile();
              }}
            >
              {selected === AUTO_AUTH_PROFILE_VALUE ? "自动分配并继续处理" : "切换并继续处理"}
            </button>
          </div>
          {message ? <div className="summary-detail">{message}</div> : null}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={closeDialog}>
              关闭
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

export function initialAuthProfileSelection(session: SessionRecord, blocked: boolean): string {
  return blocked ? AUTO_AUTH_PROFILE_VALUE : String(session.authProfileName || "");
}

export function TimelinePayloadView({ payload, hasMore = false, olderBusy = false, onLoadOlder }: { readonly payload: TimelinePayload; readonly hasMore?: boolean; readonly olderBusy?: boolean; readonly onLoadOlder?: (() => Promise<void>) | undefined }): React.JSX.Element {
  const events = filterVisibleTimelineEvents(Array.isArray(payload) ? payload : payload.events || []);
  if (!events.length) return <div className="summary-detail">暂无时间线事件</div>;
  return <Timeline events={events} hasMore={hasMore} olderBusy={olderBusy} onLoadOlder={onLoadOlder} />;
}

export function mergeTimelinePayloads(current: TimelinePayload | null, older: TimelinePayload): TimelinePayload {
  if (Array.isArray(current) || Array.isArray(older)) {
    return mergeTimelineEvents(Array.isArray(older) ? older : older.events || [], Array.isArray(current) ? current : current?.events || []);
  }
  const olderEvents = older.events || [];
  const currentEvents = current?.events || [];
  return {
    ...(current || {}),
    ...older,
    session: current?.session || older.session,
    trace: older.trace || current?.trace,
    events: mergeTimelineEvents(olderEvents, currentEvents),
  };
}

export function mergeTimelineEvents(left: readonly TimelineEvent[], right: readonly TimelineEvent[]): TimelineEvent[] {
  const seen = new Set<string>();
  const merged: TimelineEvent[] = [];
  for (const event of [...left, ...right]) {
    const key = timelineEventIdentity(event);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(event);
  }
  return merged.sort((first, second) => timestampMs(first.at) - timestampMs(second.at) || Number(first.sequence || 0) - Number(second.sequence || 0) || String(first.id || "").localeCompare(String(second.id || "")));
}

export function TraceSummary({ trace }: { readonly trace: Record<string, any> }): React.JSX.Element {
  const categories = trace.categories || {};
  const eventCount = Number(trace.eventCount || 0);
  const items = [
    ["agent_system_prompt", "系统"],
    ["agent_memory", "记忆"],
    ["agent_user_message", "用户"],
    ["agent_runtime_reminder", "提醒"],
    ["agent_assistant_message", "助手"],
    ["agent_tool_call", "工具"],
  ];
  const summary = [
    ["agent_user_message", "用户"],
    ["agent_assistant_message", "助手"],
    ["agent_tool_call", "工具"],
  ]
    .map(([key, label]) => label + " " + Number(categories[key] || 0))
    .join(" · ");
  return (
    <details className="side-disclosure">
      <summary title={summary}>{summary}</summary>
      <div className="trace-stat-panel">
        <div className="trace-stat-head">
          <strong>{eventCount}</strong>
          <span>条 Agent 事件</span>
        </div>
        <div className="trace-stat-grid">
          {items.map(([key, label]) => (
            <div key={key} className={"trace-stat " + classSafeValue(statusTone(key), "")}>
              <span>{label}</span>
              <strong>{Number(categories[key] || 0)}</strong>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

export function Timeline({ events, hasMore = false, olderBusy = false, onLoadOlder }: { readonly events: readonly TimelineEvent[]; readonly hasMore?: boolean; readonly olderBusy?: boolean; readonly onLoadOlder?: (() => Promise<void>) | undefined }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);
  const olderLoadInFlightRef = useRef(false);
  const firstEventKey = events.length ? timelineEventIdentity(events[0]) : "";
  const pendingPrependAnchorRef = useRef<{
    readonly scrollHeight: number;
    readonly scrollTop: number;
    readonly firstEventKey: string;
  } | null>(null);

  const loadOlderWithAnchor = useCallback(() => {
    if (!hasMore || olderBusy || olderLoadInFlightRef.current || !onLoadOlder) {
      return;
    }
    const container = containerRef.current;
    if (container) {
      pendingPrependAnchorRef.current = {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
        firstEventKey,
      };
    }
    shouldFollowRef.current = false;
    olderLoadInFlightRef.current = true;
    void onLoadOlder().finally(() => {
      olderLoadInFlightRef.current = false;
    });
  }, [firstEventKey, hasMore, olderBusy, onLoadOlder]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const anchor = pendingPrependAnchorRef.current;
    if (anchor && firstEventKey && firstEventKey !== anchor.firstEventKey) {
      const insertedHeight = container.scrollHeight - anchor.scrollHeight;
      container.scrollTop = anchor.scrollTop + insertedHeight;
      pendingPrependAnchorRef.current = null;
      updateFollowState();
      return;
    }
    if (!shouldFollowRef.current) {
      updateFollowState();
      return;
    }
    container.scrollTop = container.scrollHeight;
    updateFollowState();
  }, [events.length, firstEventKey]);

  useEffect(() => {
    const anchor = pendingPrependAnchorRef.current;
    if (!olderBusy && anchor && firstEventKey === anchor.firstEventKey) {
      pendingPrependAnchorRef.current = null;
    }
  }, [firstEventKey, olderBusy]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !hasMore || olderBusy || !onLoadOlder) {
      return;
    }
    if (container.scrollHeight <= container.clientHeight + TIMELINE_AUTO_LOAD_THRESHOLD) {
      loadOlderWithAnchor();
    }
  }, [events.length, hasMore, loadOlderWithAnchor, olderBusy, onLoadOlder]);

  function updateFollowState(): void {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    if (container.scrollTop <= TIMELINE_AUTO_LOAD_THRESHOLD && hasMore && !olderBusy && onLoadOlder) {
      loadOlderWithAnchor();
    }
    shouldFollowRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 24;
  }

  return (
    <div className="timeline" ref={containerRef} onScroll={updateFollowState} onMouseEnter={updateFollowState}>
      {hasMore ? (
        <button type="button" className="timeline-load-older" disabled={olderBusy} onClick={loadOlderWithAnchor}>
          {olderBusy ? "正在加载" : "加载更早活动"}
        </button>
      ) : null}
      <div className="agent-transcript">
        {events.map((event, index) => (
          <TimelineRow key={timelineEventKey(event, index)} event={event} />
        ))}
      </div>
    </div>
  );
}
