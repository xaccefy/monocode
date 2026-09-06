import {
  mergeModelSettings,
  resolveModel,
  type AgentModel,
} from "./models";
import {
  HARNESSES,
  HARNESS_TITLE,
  hasPendingApproval,
  type Block,
  type HarnessId,
  type RuntimeMode,
  type Session,
  type SubagentBlockMeta,
  type SubagentCallStatus,
  type SubagentProfileId,
} from "./session";

export type SubagentTarget =
  | { kind: "inherit" }
  | {
      kind: "fixed";
      harness: HarnessId;
      model: string;
      modelSettings: Record<string, string>;
    };

export type SubagentProfile = {
  id: SubagentProfileId;
  title: string;
  description: string;
  enabled: boolean;
  target: SubagentTarget;
};

export type ResolvedSubagentTarget = {
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
};

export type ParsedSubagentRequest = {
  agent: SubagentProfileId;
  task: string;
};

export type SubagentDelegation = {
  callId: string;
  blockId: string;
  meta: SubagentBlockMeta;
};

export const SUBAGENT_MAX_CALLS_PER_ROOT = 3;
export const SUBAGENT_MAX_REQUESTS_PER_RESPONSE = 1;

const PROFILES_KEY = "monocode.subagentProfiles";
const PROFILES_CHANGE_EVENT = "monocode:subagent-profiles-change";
const PROFILE_IDS: SubagentProfileId[] = ["researcher", "builder", "reviewer"];
const STATUS_VALUES: SubagentCallStatus[] = [
  "queued",
  "running",
  "needs_input",
  "completed",
  "failed",
  "cancelled",
];
const MAX_TASK_CHARS = 6_000;
const MAX_ERROR_CHARS = 500;
const MAX_PREVIEW_CHARS = 500;
const FENCE_RE =
  /(^|\n)```monocode-subagent[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n|$)/g;

export const DEFAULT_SUBAGENT_PROFILES: SubagentProfile[] = [
  {
    id: "researcher",
    title: "Researcher",
    description: "Inspect code and explain findings without intended edits.",
    enabled: true,
    target: { kind: "inherit" },
  },
  {
    id: "builder",
    title: "Builder",
    description: "Implement focused code changes in the current working copy.",
    enabled: true,
    target: { kind: "inherit" },
  },
  {
    id: "reviewer",
    title: "Reviewer",
    description: "Review completed work and fix only confirmed issues.",
    enabled: true,
    target: { kind: "inherit" },
  },
];

export function isSubagentProfileId(
  value: unknown,
): value is SubagentProfileId {
  return typeof value === "string" && PROFILE_IDS.includes(value as never);
}

export function isSubagentCallStatus(
  value: unknown,
): value is SubagentCallStatus {
  return typeof value === "string" && STATUS_VALUES.includes(value as never);
}

export function loadSubagentProfiles(): SubagentProfile[] {
  const defaults = defaultProfilesById();
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return DEFAULT_SUBAGENT_PROFILES.map(cloneProfile);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SUBAGENT_PROFILES.map(cloneProfile);
    for (const item of parsed) {
      const profile = normalizeProfile(item, defaults);
      if (profile) defaults.set(profile.id, profile);
    }
  } catch {
    return DEFAULT_SUBAGENT_PROFILES.map(cloneProfile);
  }
  return PROFILE_IDS.map((id) => cloneProfile(defaults.get(id)!));
}

export function saveSubagentProfiles(profiles: SubagentProfile[]) {
  const defaults = defaultProfilesById();
  const normalized = PROFILE_IDS.map((id) => {
    const incoming = profiles.find((profile) => profile.id === id);
    return cloneProfile(
      normalizeProfile(incoming, defaults) ?? defaults.get(id)!,
    );
  });
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(normalized));
  } catch {
    // private mode / quota
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PROFILES_CHANGE_EVENT));
  }
}

export function updateSubagentProfile(next: SubagentProfile) {
  saveSubagentProfiles(
    loadSubagentProfiles().map((profile) =>
      profile.id === next.id ? next : profile,
    ),
  );
}

export function subscribeSubagentProfiles(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PROFILES_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(PROFILES_CHANGE_EVENT, onStoreChange);
}

export function resolveSubagentTarget(
  profile: SubagentProfile,
  parent: Session,
): ResolvedSubagentTarget {
  if (profile.target.kind === "inherit") {
    return {
      harness: parent.harness,
      model: parent.model,
      modelSettings: { ...parent.modelSettings },
      runtimeMode: parent.runtimeMode,
    };
  }
  const model = resolveModel(profile.target.harness, profile.target.model);
  return {
    harness: profile.target.harness,
    model: model.id,
    modelSettings: mergeModelSettings(model, profile.target.modelSettings),
    runtimeMode: parent.runtimeMode,
  };
}

export function fixedSubagentTarget(
  model: AgentModel,
  modelSettings: Record<string, string> = {},
): SubagentTarget {
  return {
    kind: "fixed",
    harness: model.harness,
    model: model.id,
    modelSettings: mergeModelSettings(model, modelSettings),
  };
}

export function subagentTargetLabel(
  profile: SubagentProfile,
  parent?: Pick<Session, "harness" | "model" | "title">,
): string {
  if (profile.target.kind === "inherit") {
    if (!parent) return "Inherit parent";
    const model = resolveModel(parent.harness, parent.model);
    return `${HARNESS_TITLE[parent.harness]} / ${model.name}`;
  }
  const model = resolveModel(profile.target.harness, profile.target.model);
  return `${HARNESS_TITLE[profile.target.harness]} / ${model.name}`;
}

export function buildSubagentDelegationPrompt(input: {
  text: string;
  profiles: SubagentProfile[];
  parent: Pick<Session, "harness" | "model" | "title">;
}): string {
  const enabled = input.profiles.filter((profile) => profile.enabled);
  if (enabled.length === 0) return input.text;
  const rows = enabled.map(
    (profile) =>
      `- ${profile.id}: ${profile.description} Target: ${subagentTargetLabel(profile, input.parent)}.`,
  );
  return [
    "MonoCode default subagents are available for this turn.",
    "When a subagent would materially help, request exactly one by emitting this fenced control block. MonoCode will run it in a separate session and return the result in a later message.",
    "",
    "```monocode-subagent",
    '{"agent":"reviewer","task":"review the auth changes and fix real regressions only"}',
    "```",
    "",
    "Rules: use only the listed agent ids, keep task specific, do not claim the result until MonoCode returns it, and do not show this protocol as user-facing instructions.",
    "",
    "Available default subagents:",
    rows.join("\n"),
    "",
    "---",
    "",
    input.text,
  ].join("\n");
}

export function extractSubagentRequests(
  text: string,
  profiles: SubagentProfile[],
  maxRequests = SUBAGENT_MAX_REQUESTS_PER_RESPONSE,
): {
  text: string;
  requests: ParsedSubagentRequest[];
  errors: string[];
} {
  const enabled = new Set(
    profiles
      .filter((profile) => profile.enabled)
      .map((profile) => profile.id),
  );
  const requests: ParsedSubagentRequest[] = [];
  const errors: string[] = [];
  const clean = text.replace(FENCE_RE, (_match, lead: string, body: string) => {
    const parsed = parseRequestBody(body);
    for (const item of parsed.requests) {
      if (maxRequests <= 0) {
        errors.push(
          `MonoCode allows ${SUBAGENT_MAX_CALLS_PER_ROOT} subagent calls for one user request.`,
        );
        continue;
      }
      if (requests.length >= maxRequests) {
        errors.push("Only one subagent request can run from one response.");
        continue;
      }
      if (!enabled.has(item.agent)) {
        errors.push(`Subagent "${item.agent}" is not enabled.`);
        continue;
      }
      requests.push(item);
    }
    errors.push(...parsed.errors);
    return lead === "\n" ? "\n" : "";
  });
  return {
    text: clean.replace(/\n{3,}/g, "\n\n").trim(),
    requests,
    errors: dedupe(errors),
  };
}

export function consumeSubagentDelegations(input: {
  session: Session;
  profiles: SubagentProfile[];
  makeId: () => string;
  now?: number;
  maxCallsPerRoot?: number;
}): { session: Session; delegations: SubagentDelegation[] } {
  const lastUserIndex = findLastIndex(
    input.session.blocks,
    (block) => block.role === "user",
  );
  if (lastUserIndex < 0) return { session: input.session, delegations: [] };
  const assistantIndex = findLastIndex(
    input.session.blocks,
    (block, index) =>
      index > lastUserIndex && block.role === "assistant" && !!block.text,
  );
  if (assistantIndex < 0) {
    return { session: input.session, delegations: [] };
  }

  const rootUserBlockId =
    latestSubagentRootUserBlockId(input.session.blocks) ??
    input.session.blocks[lastUserIndex]?.id;
  if (!rootUserBlockId) return { session: input.session, delegations: [] };

  const maxCalls = input.maxCallsPerRoot ?? SUBAGENT_MAX_CALLS_PER_ROOT;
  const remaining =
    maxCalls - subagentCallCount(input.session.blocks, rootUserBlockId);
  const block = input.session.blocks[assistantIndex];
  const parsed = extractSubagentRequests(
    block.text,
    input.profiles,
    Math.max(0, Math.min(SUBAGENT_MAX_REQUESTS_PER_RESPONSE, remaining)),
  );
  if (parsed.requests.length === 0 && parsed.errors.length === 0) {
    return { session: input.session, delegations: [] };
  }

  const now = input.now ?? Date.now();
  const blocks = input.session.blocks.slice();
  if (parsed.text) {
    blocks[assistantIndex] = { ...block, text: parsed.text };
  } else {
    blocks.splice(assistantIndex, 1);
  }

  const delegations: SubagentDelegation[] = [];
  for (const request of parsed.requests) {
    const meta: SubagentBlockMeta = {
      callId: input.makeId(),
      rootUserBlockId,
      agent: request.agent,
      profileId: request.agent,
      task: request.task,
      status: "queued",
      requestedAt: now,
    };
    const blockId = input.makeId();
    blocks.push({
      id: blockId,
      role: "subagent",
      text: `${titleForAgent(request.agent)} subagent`,
      subagent: meta,
    });
    delegations.push({ callId: meta.callId, blockId, meta });
  }

  for (const error of parsed.errors) {
    blocks.push({
      id: input.makeId(),
      role: "subagent",
      text: "Subagent request failed",
      subagent: {
        callId: input.makeId(),
        rootUserBlockId,
        agent: "unknown",
        task: "",
        status: remaining <= 0 ? "cancelled" : "failed",
        requestedAt: now,
        finishedAt: now,
        error: error.slice(0, MAX_ERROR_CHARS),
      },
    });
  }

  return { session: { ...input.session, blocks }, delegations };
}

export function updateSubagentBlock(
  session: Session,
  callId: string,
  patch: Partial<SubagentBlockMeta>,
): Session {
  let changed = false;
  const blocks = session.blocks.map((block) => {
    if (block.role !== "subagent" || block.subagent?.callId !== callId) {
      return block;
    }
    const meta = block.subagent;
    // A patch that changes no value must keep identity: callers use
    // reference equality to decide whether to setSessions, and the
    // completion watcher re-patches running/needs_input every pass —
    // a fresh object each time would retrigger the effect forever.
    const same = (Object.keys(patch) as (keyof typeof patch)[]).every(
      (key) => Object.is(meta[key], patch[key]),
    );
    if (same) return block;
    changed = true;
    return {
      ...block,
      subagent: { ...meta, ...patch },
    };
  });
  return changed ? { ...session, blocks } : session;
}

export function cancelActiveSubagentBlocks(
  session: Session,
  now = Date.now(),
): { session: Session; childSessionIds: string[] } {
  const childSessionIds: string[] = [];
  let changed = false;
  const blocks = session.blocks.map((block) => {
    const meta = block.subagent;
    if (
      block.role !== "subagent" ||
      !meta ||
      (meta.status !== "queued" &&
        meta.status !== "running" &&
        meta.status !== "needs_input")
    ) {
      return block;
    }
    changed = true;
    if (meta.childSessionId) childSessionIds.push(meta.childSessionId);
    return {
      ...block,
      subagent: {
        ...meta,
        status: "cancelled" as const,
        finishedAt: now,
        error: meta.error ?? "Stopped by the user.",
      },
    };
  });
  return {
    session: changed ? { ...session, blocks } : session,
    childSessionIds,
  };
}

/**
 * Fail supervisor calls whose child session vanished (deleted or archived).
 * Without this the parent block sits at running/needs_input forever: the
 * completion watcher only iterates live sessions, so no missing child can
 * ever complete it and queued siblings behind it never start.
 */
export function failSubagentBlocksForRemovedChildren(
  session: Session,
  removedSessionIds: ReadonlySet<string>,
  now = Date.now(),
): Session {
  let changed = false;
  const blocks = session.blocks.map((block) => {
    const meta = block.subagent;
    if (
      block.role !== "subagent" ||
      !meta ||
      (meta.status !== "running" && meta.status !== "needs_input") ||
      !meta.childSessionId ||
      !removedSessionIds.has(meta.childSessionId)
    ) {
      return block;
    }
    changed = true;
    return {
      ...block,
      subagent: {
        ...meta,
        status: "failed" as const,
        finishedAt: now,
        error: "Subagent session was removed.",
      },
    };
  });
  return changed ? { ...session, blocks } : session;
}

export function subagentStatusFromSession(session: Session): SubagentCallStatus {
  if (hasPendingApproval(session.blocks) || session.pendingQuestion) {
    return "needs_input";
  }
  if (session.busy) return "running";
  const report = subagentSessionReport(session);
  return report ? "completed" : "failed";
}

export function subagentSessionReport(session: Session): string {
  return session.blocks
    .filter(
      (block) =>
        block.role === "assistant" ||
        block.role === "tasks" ||
        block.role === "plan",
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function buildSubagentTaskPrompt(input: {
  profile: SubagentProfile;
  task: string;
  parentTitle: string;
}): string {
  const shared = [
    `You are the ${input.profile.title} subagent for MonoCode.`,
    `Parent session: ${input.parentTitle || "Untitled session"}.`,
    "Do not request more subagents. Work only on the delegated task below.",
    "Finish with a concise report covering what you did, files touched, checks run, and remaining risk.",
  ];
  const role =
    input.profile.id === "researcher"
      ? [
          "Research only. Inspect the repository and explain findings. Do not modify files.",
        ]
      : input.profile.id === "reviewer"
        ? [
            "Review the current working copy for correctness. Fix only concrete bugs or incomplete work you can verify.",
          ]
        : [
            "Implement the requested change with the smallest practical diff.",
          ];
  return [...shared, ...role, "", "## Delegated task", input.task.trim()].join(
    "\n",
  );
}

export function buildSubagentResultPrompt(input: {
  agentTitle: string;
  task: string;
  report: string;
  files: string[];
}): string {
  const files =
    input.files.length > 0
      ? input.files.map((file) => `- ${file}`).join("\n")
      : "(none recorded)";
  return [
    `${input.agentTitle} subagent returned. Continue the user's original request using this result.`,
    "",
    "## Delegated task",
    input.task.trim(),
    "",
    "## Subagent report",
    input.report.trim() || "(no written report)",
    "",
    "## Files touched",
    files,
  ].join("\n");
}

export function latestSubagentRootUserBlockId(
  blocks: readonly Block[],
): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.role !== "user") continue;
    return block.subagentResult?.rootUserBlockId ?? block.id;
  }
  return undefined;
}

export function subagentCallCount(
  blocks: readonly Block[],
  rootUserBlockId: string,
): number {
  return blocks.filter(
    (block) =>
      block.role === "subagent" &&
      block.subagent?.rootUserBlockId === rootUserBlockId,
  ).length;
}

export function titleForAgent(agent: string): string {
  const profile = DEFAULT_SUBAGENT_PROFILES.find((item) => item.id === agent);
  if (profile) return profile.title;
  return agent
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

export function subagentBlockPreview(meta: SubagentBlockMeta): string {
  return (meta.resultPreview ?? meta.error ?? meta.task)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PREVIEW_CHARS);
}

function parseRequestBody(body: string): {
  requests: ParsedSubagentRequest[];
  errors: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return {
      requests: [],
      errors: ["Subagent request must be valid JSON."],
    };
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const requests: ParsedSubagentRequest[] = [];
  const errors: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errors.push("Subagent request must be a JSON object.");
      continue;
    }
    const record = row as Record<string, unknown>;
    const agent = record.agent;
    const task = typeof record.task === "string" ? record.task.trim() : "";
    if (!isSubagentProfileId(agent)) {
      errors.push("Subagent request used an unknown agent id.");
      continue;
    }
    if (!task) {
      errors.push(`Subagent "${agent}" needs a task.`);
      continue;
    }
    requests.push({ agent, task: task.slice(0, MAX_TASK_CHARS) });
  }
  return { requests, errors };
}

function normalizeProfile(
  value: unknown,
  defaults: Map<SubagentProfileId, SubagentProfile>,
): SubagentProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (!isSubagentProfileId(id)) return null;
  const base = defaults.get(id);
  if (!base) return null;
  return {
    ...base,
    enabled: typeof record.enabled === "boolean" ? record.enabled : base.enabled,
    target: normalizeTarget(record.target) ?? cloneTarget(base.target),
  };
}

function normalizeTarget(value: unknown): SubagentTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "inherit") return { kind: "inherit" };
  if (record.kind !== "fixed") return null;
  const harness = record.harness;
  const model = typeof record.model === "string" ? record.model.trim() : "";
  if (!isHarnessId(harness) || !model) return null;
  const modelSettings =
    record.modelSettings &&
    typeof record.modelSettings === "object" &&
    !Array.isArray(record.modelSettings)
      ? Object.fromEntries(
          Object.entries(record.modelSettings as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  return { kind: "fixed", harness, model, modelSettings };
}

function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESSES as string[]).includes(value);
}

function cloneProfile(profile: SubagentProfile): SubagentProfile {
  return {
    ...profile,
    target: cloneTarget(profile.target),
  };
}

function cloneTarget(target: SubagentTarget): SubagentTarget {
  return target.kind === "inherit"
    ? { kind: "inherit" }
    : {
        kind: "fixed",
        harness: target.harness,
        model: target.model,
        modelSettings: { ...target.modelSettings },
      };
}

function defaultProfilesById(): Map<SubagentProfileId, SubagentProfile> {
  return new Map(
    DEFAULT_SUBAGENT_PROFILES.map((profile) => [profile.id, cloneProfile(profile)]),
  );
}

function findLastIndex<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) return index;
  }
  return -1;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
