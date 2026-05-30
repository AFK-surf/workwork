import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("RFC PR template", () => {
  it("keeps RFC trace, TDD, observability, and verification prompts in every PR", async () => {
    const content = await fs.readFile(
      path.join(process.cwd(), ".github", "pull_request_template.md"),
      "utf8"
    );

    expect(content).toContain("## RFC Trace");
    expect(content).toContain("- RED:");
    expect(content).toContain("- GREEN:");
    expect(content).toContain("- REFACTOR:");
    expect(content).toContain("- REGRESSION:");
    expect(content).toContain("- OBSERVE:");
    expect(content).toContain("Docs-only PRs: explain under RED why no failing behavior test applies.");
    expect(content).toContain("- Slack regression:");
    expect(content).toContain("- Feishu unit/mock evidence:");
    expect(content).toContain("- Real smoke evidence:");
    expect(content).toContain("- Feishu setup evidence:");
    expect(content).toContain("<!-- 请补充 CC 之外的验证 -->");
    expect(content).toContain("No RFC update needed because this PR stays within current invariants.");
    expect(content).toContain("RFC updated in this PR because a contract/default/gate changed.");
    expect(content).toContain("Follow-up issue linked for deferred compatible work.");
  });
});
