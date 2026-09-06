import { describe, expect, it } from "vitest";
import { newSession, type Block, type Session } from "./session";
import {
  isPersistableId,
  persistFingerprint,
  sanitizeSessionForPersist,
} from "./sessionStore";

describe("isPersistableId", () => {
  it("accepts alphanumeric ids with hyphens and underscores", () => {
    expect(isPersistableId("acp-session-1")).toBe(true);
    expect(isPersistableId("abc_123")).toBe(true);
  });

  it("rejects filesystem paths", () => {
    expect(isPersistableId("/Users/me/.pi/agent/sessions/abc.jsonl")).toBe(
      false,
    );
  });
});

describe("sanitizeSessionForPersist", () => {
  it("omits a path-like provider session id so upsert can still snapshot git", () => {
    const session = newSession("pi", "/tmp/project");
    session.providerSessionId = "/Users/me/.pi/agent/sessions/abc.jsonl";
    session.blocks = [{ id: "u1", role: "user", text: "hey" }];

    expect(
      sanitizeSessionForPersist(session).providerSessionId,
    ).toBeUndefined();
  });

  it("keeps a UUID provider session id", () => {
    const session = newSession("pi", "/tmp/project");
    session.providerSessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    session.blocks = [{ id: "u1", role: "user", text: "hey" }];

    expect(sanitizeSessionForPersist(session).providerSessionId).toBe(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
  });

  it("keeps a handoff divider and settles a preparing one", () => {
    const session = newSession("cursor", "/tmp/project");
    session.blocks = [
      { id: "u1", role: "user", text: "hey" },
      {
        id: "h1",
        role: "handoff",
        text: "",
        handoff: { from: "cursor", to: "claude", status: "preparing" },
      },
    ];
    const persisted = sanitizeSessionForPersist(session);
    expect(persisted.blocks[1]).toMatchObject({
      role: "handoff",
      handoff: { from: "cursor", to: "claude", status: "ready", pending: true },
    });
  });

  it("keeps a second-opinion card on the user turn", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
      {
        id: "u1",
        role: "user",
        text: "Second opinion",
        secondOpinion: {
          from: "claude",
          to: "codex",
          request: "fix the footer",
          files: 2,
        },
      },
    ];
    expect(sanitizeSessionForPersist(session).blocks[0]).toMatchObject({
      role: "user",
      text: "Second opinion",
      secondOpinion: {
        from: "claude",
        to: "codex",
        request: "fix the footer",
        files: 2,
      },
    });
  });

  it("keeps completed subagent call and result metadata", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
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
          startedAt: 2,
          finishedAt: 3,
          childSessionId: "child_1",
          harness: "opencode",
          model: "opencode:muse-1.3",
          title: "Reviewer subagent",
          files: ["src/App.tsx"],
          resultPreview: "Looks good.",
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
    ];

    expect(sanitizeSessionForPersist(session).blocks).toEqual(session.blocks);
  });

  it("settles active subagent calls before persisting history", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
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
          status: "running",
          requestedAt: 1,
          startedAt: 2,
          childSessionId: "child_1",
        },
      },
    ];

    const persisted = sanitizeSessionForPersist(session).blocks[1];
    expect(persisted.subagent).toMatchObject({
      callId: "call_1",
      rootUserBlockId: "u1",
      agent: "reviewer",
      profileId: "reviewer",
      task: "review auth",
      status: "cancelled",
      requestedAt: 1,
      startedAt: 2,
      childSessionId: "child_1",
      error: "Interrupted before subagent completed.",
    });
    expect(typeof persisted.subagent?.finishedAt).toBe("number");
  });

  it("keeps a handoff card kind on the user turn", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
      {
        id: "u1",
        role: "user",
        text: "Handoff",
        secondOpinion: {
          from: "claude",
          to: "codex",
          kind: "handoff",
        },
      },
    ];
    expect(sanitizeSessionForPersist(session).blocks[0]).toMatchObject({
      role: "user",
      text: "Handoff",
      secondOpinion: { from: "claude", to: "codex", kind: "handoff" },
    });
  });

  it("keeps a note card on the user turn without the note body", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
      {
        id: "u1",
        role: "user",
        text: "hi",
        noteCard: {
          id: "n1",
          slug: "overview",
          title: "agent-os project overview",
          sourceCwd: "/tmp/project",
        },
      },
    ];
    expect(sanitizeSessionForPersist(session).blocks[0]).toEqual({
      id: "u1",
      role: "user",
      text: "hi",
      noteCard: {
        id: "n1",
        slug: "overview",
        title: "agent-os project overview",
        sourceCwd: "/tmp/project",
      },
    });
  });

  it("keeps edited and approved plan metadata", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
      { id: "u1", role: "user", text: "plan this" },
      {
        id: "p1",
        role: "plan",
        text: "# Edited plan",
        plan: {
          key: "turn:1",
          status: "built",
          originalText: "# Original plan",
          approvedText: "# Edited plan",
          edited: true,
        },
      },
    ];
    expect(sanitizeSessionForPersist(session).blocks[1]).toMatchObject({
      role: "plan",
      text: "# Edited plan",
      plan: {
        key: "turn:1",
        status: "built",
        originalText: "# Original plan",
        approvedText: "# Edited plan",
        edited: true,
      },
    });
  });

  it("keeps structured task lists", () => {
    const session = newSession("codex", "/tmp/project");
    session.blocks = [
      { id: "u1", role: "user", text: "fix it" },
      {
        id: "tasks1",
        role: "tasks",
        text: "[x] Inspect\n[~] Implement",
        taskList: {
          key: "turn_1",
          explanation: "Inspection complete.",
          items: [
            { id: "1", text: "Inspect", status: "completed" },
            { id: "2", text: "Implement", status: "in_progress" },
          ],
        },
      },
    ];
    expect(sanitizeSessionForPersist(session).blocks[1]).toEqual(
      session.blocks[1],
    );
  });
});

describe("persistFingerprint", () => {
  const user: Block = { id: "u1", role: "user", text: "hi" };
  const answer: Block = { id: "a1", role: "assistant", text: "done" };

  // One base session: `newSession` mints a fresh id, and the id is part of the
  // fingerprint, so variants have to be spread off a single session.
  const base = (blocks: Block[] = [user, answer]): Session => ({
    ...newSession("codex", "/tmp/project"),
    blocks,
  });

  it("is stable while nothing changes", () => {
    const session = base();
    expect(persistFingerprint(session)).toBe(persistFingerprint(session));
  });

  it("matches a copy holding the same blocks", () => {
    const session = base();
    expect(persistFingerprint({ ...session })).toBe(
      persistFingerprint(session),
    );
  });

  it("changes when a block in the middle is replaced", () => {
    const tool: Block = {
      id: "t1",
      role: "tool",
      text: "run",
      tool: { status: "running" },
    };
    const before = base([user, tool, answer]);
    const after = {
      ...before,
      blocks: [user, { ...tool, tool: { status: "completed" } }, answer],
    };
    expect(persistFingerprint(after)).not.toBe(persistFingerprint(before));
  });

  it("changes when an approval is decided", () => {
    const approval: Block = {
      id: "p1",
      role: "approval",
      text: "allow?",
      approval: { requestId: 1 },
    };
    const before = base([user, approval]);
    const after = {
      ...before,
      blocks: [
        user,
        { ...approval, approval: { requestId: 1, decided: "allow" as const } },
      ],
    };
    expect(persistFingerprint(after)).not.toBe(persistFingerprint(before));
  });

  it("changes when a block is appended", () => {
    const before = base([user]);
    expect(persistFingerprint({ ...before, blocks: [user, answer] })).not.toBe(
      persistFingerprint(before),
    );
  });

  it("changes when a persisted field changes", () => {
    const before = base();
    expect(persistFingerprint({ ...before, title: "Renamed" })).not.toBe(
      persistFingerprint(before),
    );
  });

  it("ignores state that is never written", () => {
    const before = base();
    expect(persistFingerprint({ ...before, busy: true })).toBe(
      persistFingerprint(before),
    );
  });

  it("treats a path-like provider session id as absent", () => {
    const session = base();
    expect(
      persistFingerprint({
        ...session,
        providerSessionId: "/Users/me/.pi/agent/sessions/abc.jsonl",
      }),
    ).toBe(persistFingerprint(session));
  });

  it("matches persist for a zero context window", () => {
    const session = base();
    expect(
      persistFingerprint({ ...session, context: { used: 10, window: 0 } }),
    ).toBe(persistFingerprint({ ...session, context: { used: 10 } }));
  });
});
