import { buildAdminSessionUrl } from "../../admin-session-url.js";
import type { SlackSessionRecord } from "../../types.js";
import type { GitHubPrIdentityService } from "../github-pr-identity-service.js";

export type SessionPageLinkMessageStyle = "slack_mrkdwn" | "plain";

export function formatSessionPageLinkMessage(options: { readonly adminBaseUrl: string; readonly session: SlackSessionRecord; readonly githubPrIdentity?: GitHubPrIdentityService | undefined; readonly style: SessionPageLinkMessageStyle }): string {
  const url = buildAdminSessionUrl(options.adminBaseUrl, options.session.key);
  const lines = [formatLink(options.style, url, "查看会话活动时间线")];
  const identity = options.githubPrIdentity?.getSessionIdentityStatus(options.session);

  if (identity?.binding?.state === "unbound") {
    const warning = identity.defaultAccount.available ? `当前发起人还没有绑定 GitHub 账号。不绑定时，后续创建 PR 会使用默认账号 ${identity.defaultAccount.githubLogin}。` : "当前发起人还没有绑定 GitHub 账号。当前没有默认 GitHub PR 账号，创建 PR 前需要先绑定。";
    lines.push("", warning, formatLink(options.style, `${url}/github/bind`, "绑定 GitHub"));
  }

  return lines.join("\n");
}

function formatLink(style: SessionPageLinkMessageStyle, url: string, label: string): string {
  if (style === "slack_mrkdwn") {
    return `<${url}|${label}>`;
  }

  return `${label}: ${url}`;
}
