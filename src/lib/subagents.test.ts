import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHarnessModelOverlays, setHarnessModels } from "./models";
import { newSession, type Block, type Session } from "./session";
import {
  DEFAULT_SUBAGENT_PROFILES,
  buildSubagentDelegationPrompt,
  buildSubagentTaskPrompt,
  cancelActiveSubagentBlocks,
  consumeSubagentDelegations,
  extractSubagentRequests,
  failSubagentBlocksForRemovedChildren,
  fixedSubagentTarget,
  loadSubagentProfiles,
  resolveSubagentTarget,
  saveSubagentProfiles,
  subagentSessionReport,
  subagentStatusFromSession,
  subagentTargetLabel,
  updateSubagentBlock,
  type SubagentProfile,
} from "./subagents";

function mockLocalStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
}

function profile(id: SubagentProfile["id"]): SubagentProfile {
  const found = DEFAULT_SUBAGENT_PROFILES.find((item) => item.id === id);
  if (!found) throw new Error(`missing profile ${id}`);
  return { ...found, target: { ...found.target } };
}

describe("subagent profiles", () => {
  beforeEach(() => {
    mockLocalStorage();
    resetHarnessModelOverlays();
  });

  afterEach(() => {
    mockLocalStorage();
    resetHarnessModelOverlays();
  });

  it("loads the default inherited profiles", () => {
    expect(loadSubagentProfiles()).toEqual(DEFAULT_SUBAGENT_PROFILES);
  });

  it("persists a fixed OpenCode target including its agent setting", () => {
    setHarnessModels("opencode", [
      {
        id: "opencode:muse-1.3",
        harness: "opencode",
        name: "Muse 1.3",
        settings: [
          {
            id: "agent",
            label: "Agent",
            kind: "select",
            value: "build",
            options: [
              { value: "build", label: "Build" },
              { value: "review", label: "Review" },
            ],
          },
        ],
      },
    ]);
    const reviewer = {
      ...profile("reviewer"),
      target: fixedSubagentTarget(
        {
          id: "opencode:muse-1.3",
          harness: "opencode",
          name: "Muse 1.3",
          settings: [
            {
              id: "agent",
              label: "Agent",
              kind: "select",
              value: "build",
              options: [
                { value: "build", label: "Build" },
                { value: "review", label: "Review" },
              ],
            },
          ],
        },
        { agent: "review" },
      ),
    };
    saveSubagentProfiles([
      profile("researcher"),
      profile("builder"),
      reviewer,
    ]);

    const loaded = loadSubagentProfiles().find((item) => item.id === "reviewer");
    const parent = newSession("claude", "/tmp/project", "claude:opus-5");
    expect(loaded?.target).toEqual({
      kind: "fixed",
      harness: "opencode",
      model: "opencode:muse-1.3",
      modelSettings: { agent: "review" },
    });
    expect(loaded ? resolveSubagentTarget(loaded, parent) : undefined).toEqual({
      harness: "opencode",
      model: "opencode:muse-1.3",
      modelSettings: { agent: "review" },
      runtimeMode: "supervised",
    });
    expect(loaded ? subagentTargetLabel(loaded, parent) : "").toBe(
      "OpenCode / Muse 1.3",
    );
  });

  it("labels inherited targets by the parent model", () => {
    const parent = newSession("claude", "/tmp/project", "claude:opus-5");
    expect(subagentTargetLabel(profile("builder"), parent)).toBe(
      "Claude Code / Claude Opus 5",
    );
  });
});

describe("subagent protocol", () => {
  const profiles = DEFAULT_SUBAGENT_PROFILES;

  it("adds the delegation instructions without changing the visible user text", () => {
    const parent = newSession("codex", "/tmp/project");
    const prompt = buildSubagentDelegationPrompt({
      text: "Fix the auth flow",
      profiles: profiles.map((item) =>
        item.id === "builder" ? { ...item, enabled: false } : item,
      ),
      parent,
    });
    expect(prompt).toContain("```monocode-subagent");
    expect(prompt).toContain("- reviewer:");
    expect(prompt).not.toContain("- builder:");
    expect(prompt.endsWith("Fix the auth flow")).toBe(true);
  });

  it("extracts one valid fenced request and removes the control block", () => {
    const parsed = extractSubagentRequests(
      [
        "I will delegate this.",
        "```monocode-subagent",
        '{"agent":"reviewer","task":"review auth changes"}',
        "```",
        "Back after it returns.",
      ].join("\n"),
      profiles,
    );
    expect(parsed).toEqual({
      text: "I will delegate this.\nBack after it returns.",
      requests: [{ agent: "reviewer", task: "review auth changes" }],
      errors: [],
    });
  });

  it("limits one request per assistant response", () => {
    const parsed = extractSubagentRequests(
      [
        "```monocode-subagent",
        JSON.stringify([
          { agent: "researcher", task: "inspect" },
          { agent: "reviewer", task: "review" },
        ]),
        "```",
      ].join("\n"),
      profiles,
    );
    expect(parsed.requests).toEqual([{ agent: "researcher", task: "inspect" }]);
    expect(parsed.errors).toEqual([
      "Only one subagent request can run from one response.",
    ]);
  });

  it("reports the per-root call limit before queuing another request", () => {
    const parsed = extractSubagentRequests(
      [
        "```monocode-subagent",
        '{"agent":"reviewer","task":"review"}',
        "```",
      ].join("\n"),
      profiles,
      0,
    );
    expect(parsed.requests).toEqual([]);
    expect(parsed.errors).toEqual([
      "MonoCode allows 3 subagent calls for one user request.",
    ]);
  });

  it("turns assistant control blocks into queued subagent transcript blocks", () => {
    const session: Session = {
      ...newSession("codex", "/tmp/project"),
      blocks: [
        { id: "u1", role: "user", text: "fix auth" },
        {
          id: "a1",
          role: "assistant",
          text: [
            "I need a review.",
            "```monocode-subagent",
            '{"agent":"reviewer","task":"review auth"}',
            "```",
          ].join("\n"),
        },
      ],
    };
    const ids = ["call_1", "block_1"];
    const result = consumeSubagentDelegations({
      session,
      profiles,
      makeId: () => ids.shift() ?? "extra",
      now: 123,
    });

    expect(result.session.blocks[1].text).toBe("I need a review.");
    expect(result.session.blocks[2]).toMatchObject({
      id: "block_1",
      role: "subagent",
      text: "Reviewer subagent",
      subagent: {
        callId: "call_1",
        rootUserBlockId: "u1",
        agent: "reviewer",
        profileId: "reviewer",
        task: "review auth",
        status: "queued",
        requestedAt: 123,
      },
    });
    expect(result.delegations).toHaveLength(1);
  });

  it("uses the original user turn as the root after a subagent result comes back", () => {
    const session: Session = {
      ...newSession("codex", "/tmp/project"),
      blocks: [
        { id: "u1", role: "user", text: "fix auth" },
        {
          id: "s1",
          role: "subagent",
          text: "Reviewer subagent",
          subagent: {
            callId: "call_1",
            rootUserBlockId: "u1",
            agent: "reviewer",
            profileId: "reviewer",
            task: "review auth",
            status: "completed",
            requestedAt: 1,
            finishedAt: 2,
          },
        },
        {
          id: "u2",
          role: "user",
          text: "Reviewer subagent returned",
          subagentResult: {
            callId: "call_1",
            rootUserBlockId: "u1",
            agent: "reviewer",
            childSessionId: "child_1",
          },
        },
        {
          id: "a1",
          role: "assistant",
          text: [
            "I need implementation help.",
            "```monocode-subagent",
            '{"agent":"builder","task":"apply the review fix"}',
            "```",
          ].join("\n"),
        },
      ],
    };
    const ids = ["call_2", "block_2"];
    const result = consumeSubagentDelegations({
      session,
      profiles,
      makeId: () => ids.shift() ?? "extra",
      now: 456,
    });
    const subagent = result.session.blocks.at(-1)?.subagent;
    expect(subagent?.rootUserBlockId).toBe("u1");
  });

  it("builds child task prompts that disable recursive delegation", () => {
    expect(
      buildSubagentTaskPrompt({
        profile: profile("researcher"),
        task: "inspect auth",
        parentTitle: "Auth change",
      }),
    ).toContain("Do not request more subagents.");
  });
});

describe("subagent transcript state", () => {
  it("updates and cancels active subagent blocks", () => {
    const session: Session = {
      ...newSession("codex", "/tmp/project"),
      blocks: [
        {
          id: "s1",
          role: "subagent",
          text: "Reviewer subagent",
          subagent: {
            callId: "call_1",
            rootUserBlockId: "u1",
            agent: "reviewer",
            profileId: "reviewer",
            task: "review",
            status: "queued",
            requestedAt: 1,
            childSessionId: "child_1",
          },
        },
      ],
    };

    const running = updateSubagentBlock(session, "call_1", {
      status: "running",
    });
    expect(running.blocks[0].subagent?.status).toBe("running");
    // A patch that changes nothing keeps identity so the completion
    // watcher doesn't retrigger itself forever on every pass.
    expect(updateSubagentBlock(running, "call_1", { status: "running" })).toBe(
      running,
    );
    expect(updateSubagentBlock(session, "missing", { status: "failed" })).toBe(
      session,
    );
    const cancelled = cancelActiveSubagentBlocks(running, 99);
    expect(cancelled.childSessionIds).toEqual(["child_1"]);
    expect(cancelled.session.blocks[0].subagent).toMatchObject({
      status: "cancelled",
      finishedAt: 99,
      error: "Stopped by the user.",
    });
  });

  it("fails calls whose child session was removed", () => {
    const session: Session = {
      ...newSession("codex", "/tmp/project"),
      blocks: [
        {
          id: "s1",
          role: "subagent",
          text: "Reviewer subagent",
          subagent: {
            callId: "call_1",
            rootUserBlockId: "u1",
            agent: "reviewer",
            profileId: "reviewer",
            task: "review",
            status: "running",
            requestedAt: 1,
            childSessionId: "child_1",
          },
        },
        {
          id: "s2",
          role: "subagent",
          text: "Builder subagent",
          subagent: {
            callId: "call_2",
            rootUserBlockId: "u1",
            agent: "builder",
            profileId: "builder",
            task: "build",
            status: "completed",
            requestedAt: 1,
            finishedAt: 2,
            childSessionId: "child_2",
          },
        },
      ],
    };

    const settled = failSubagentBlocksForRemovedChildren(
      session,
      new Set(["child_1", "child_2"]),
      99,
    );
    expect(settled.blocks[0].subagent).toMatchObject({
      status: "failed",
      finishedAt: 99,
      error: "Subagent session was removed.",
    });
    // Terminal blocks are untouched even when their child is gone.
    expect(settled.blocks[1].subagent?.status).toBe("completed");
  });

  it("leaves sessions untouched when no child was removed", () => {
    const session: Session = {
      ...newSession("codex", "/tmp/project"),
      blocks: [
        {
          id: "s1",
          role: "subagent",
          text: "Reviewer subagent",
          subagent: {
            callId: "call_1",
            rootUserBlockId: "u1",
            agent: "reviewer",
            profileId: "reviewer",
            task: "review",
            status: "running",
            requestedAt: 1,
            childSessionId: "child_1",
          },
        },
      ],
    };

    expect(
      failSubagentBlocksForRemovedChildren(session, new Set(["other"])),
    ).toBe(session);
  });

  it("classifies child sessions by report and input state", () => {
    const child = newSession("codex", "/tmp/project");
    const completed = {
      ...child,
      blocks: [
        { id: "u1", role: "user", text: "review" },
        { id: "a1", role: "assistant", text: "Looks good." },
      ] satisfies Block[],
    };
    expect(subagentStatusFromSession(completed)).toBe("completed");
    expect(subagentSessionReport(completed)).toBe("Looks good.");
    expect(
      subagentStatusFromSession({
        ...child,
        blocks: [{ id: "e1", role: "system", text: "provider failed" }],
      }),
    ).toBe("failed");
    expect(
      subagentStatusFromSession({
        ...child,
        blocks: [
          {
            id: "p1",
            role: "approval",
            text: "Allow?",
            approval: { requestId: 1 },
          },
        ],
      }),
    ).toBe("needs_input");
  });
});
