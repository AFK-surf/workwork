import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

const adminUiRoot = new URL("../src/admin-ui/", import.meta.url);

describe("agent session UI", () => {
  it("documents the agent workbench target", async () => {
    const doc = await fs.readFile(new URL("../docs/agent-session-ui.md", import.meta.url), "utf8");

    expect(doc).toContain("real agent session product UI");
    expect(doc).toContain("Agent 工作台");
    expect(doc).toContain("工作时间线");
    expect(doc).toContain("接管 / 链接");
    expect(doc).toContain("技术上下文");
  });

  it("uses agent-session language instead of backend admin section labels", async () => {
    const sessionView = await fs.readFile(new URL("session-view.tsx", adminUiRoot), "utf8");
    const css = await fs.readFile(new URL("admin.css", adminUiRoot), "utf8");

    expect(sessionView).toContain("AgentSessionHero");
    expect(sessionView).toContain("Agent 会话");
    expect(sessionView).toContain("Agent 工作台");
    expect(sessionView).toContain("工作时间线");
    expect(sessionView).toContain("接管 / 链接");
    expect(sessionView).toContain("当前状态");
    expect(sessionView).toContain("等待输入 / 后台任务");
    expect(sessionView).toContain("时间线统计");
    expect(sessionView).toContain("技术上下文");
    expect(sessionView).not.toContain("会话索引");
    expect(sessionView).not.toContain("会话详情");
    expect(sessionView).not.toContain("Agent 活动时间线");
    expect(sessionView).not.toContain('<div className="mini-title">操作</div>');
    expect(sessionView).not.toContain('<div className="mini-title">运行状态</div>');
    expect(sessionView).not.toContain('<div className="mini-title">消息 / 任务</div>');
    expect(sessionView).not.toContain('<div className="mini-title">活动构成</div>');
    expect(sessionView).not.toContain('<div className="mini-title">调试信息</div>');

    expect(css).toContain(".agent-session-hero");
    expect(css).toContain(".agent-session-stat-grid");
    expect(css).toContain(".agent-session-request");
  });
});
