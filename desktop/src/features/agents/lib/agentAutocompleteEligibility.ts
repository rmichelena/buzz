import type { Channel, ChannelMember, RelayAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

export function computeChannelMemberAgentPubkeys(
  mentionChannelId: string | null,
  members: readonly ChannelMember[] | undefined,
  membersLoading: boolean,
  hasExternalMembers: boolean,
): ReadonlySet<string> | undefined {
  if (!mentionChannelId) {
    return undefined;
  }
  if (!hasExternalMembers && membersLoading) {
    return new Set<string>();
  }
  return new Set(
    (members ?? [])
      .filter((member) => member.isAgent === true || member.role === "bot")
      .map((member) => normalizePubkey(member.pubkey)),
  );
}

export function getSharedChannelIds(channels: readonly Channel[] | undefined) {
  return new Set(
    (channels ?? [])
      .filter((channel) => channel.isMember && channel.archivedAt === null)
      .map((channel) => channel.id),
  );
}

export function relayAgentIsSharedWithUser(
  agent: Pick<
    RelayAgent,
    "pubkey" | "channelIds" | "respondTo" | "respondToAllowlist"
  >,
  sharedChannelIds: ReadonlySet<string>,
  currentPubkey?: string | null,
  channelMemberAgentPubkeys?: ReadonlySet<string>,
) {
  const normalizedCurrentPubkey = currentPubkey
    ? normalizePubkey(currentPubkey)
    : null;

  // Allowlist agents skip the shared-channel overlap check; once the viewer is
  // allowlisted, live NIP-29 membership can admit them during 39002 lag windows.
  if (agent.respondTo === "allowlist" && normalizedCurrentPubkey) {
    return agent.respondToAllowlist
      .map((pubkey) => normalizePubkey(pubkey))
      .includes(normalizedCurrentPubkey);
  }

  // `respondTo === null` means the directory has no policy for this agent (no
  // kind:10100 `respond_to`, or a membership-derived entry). Unknown policy is
  // not a denial: membership decides visibility, `respond_to` decides whether a
  // send is answered. Only an explicit not-invocable mode hides the agent.
  if (agent.respondTo != null && agent.respondTo !== "anyone") {
    return false;
  }

  if (agent.channelIds.some((channelId) => sharedChannelIds.has(channelId))) {
    return true;
  }

  // Relay directory channel_ids can lag behind live channel membership; callers
  // pass bot members from the active channel composer as a fresher signal.
  return channelMemberAgentPubkeys?.has(normalizePubkey(agent.pubkey)) === true;
}

export function relayAgentCanRespondInChannel(
  agent: Pick<
    RelayAgent,
    "pubkey" | "channelIds" | "respondTo" | "respondToAllowlist"
  >,
  channelId: string,
  currentPubkey?: string | null,
  channelMemberAgentPubkeys?: ReadonlySet<string>,
) {
  const normalizedPubkey = normalizePubkey(agent.pubkey);
  const inChannel =
    agent.channelIds.includes(channelId) ||
    channelMemberAgentPubkeys?.has(normalizedPubkey) === true;
  if (!inChannel) {
    return false;
  }

  return relayAgentIsSharedWithUser(
    agent,
    new Set([channelId]),
    currentPubkey,
    channelMemberAgentPubkeys,
  );
}

export type AgentEligibilityScope =
  | { type: "community" }
  | {
      type: "channel";
      channelId: string;
      channelMembers?: readonly ChannelMember[];
      membersLoading?: boolean;
      hasExternalMembers?: boolean;
    }
  | { type: "managed-only" };

export function getMentionableAgentPubkeys({
  channelMemberAgentPubkeys,
  currentPubkey,
  eligibilityScope,
  managedAgentPubkeys,
  relayAgents,
  sharedChannelIds,
}: {
  channelMemberAgentPubkeys?: ReadonlySet<string>;
  currentPubkey?: string | null;
  eligibilityScope: AgentEligibilityScope;
  managedAgentPubkeys: Iterable<string>;
  relayAgents: readonly RelayAgent[] | undefined;
  sharedChannelIds: ReadonlySet<string>;
}) {
  const resolvedChannelMemberAgentPubkeys =
    channelMemberAgentPubkeys ??
    (eligibilityScope.type === "channel"
      ? computeChannelMemberAgentPubkeys(
          eligibilityScope.channelId,
          eligibilityScope.channelMembers,
          eligibilityScope.membersLoading ?? false,
          eligibilityScope.hasExternalMembers ?? false,
        )
      : undefined);

  const pubkeys = new Set(
    [...managedAgentPubkeys].map((pubkey) => normalizePubkey(pubkey)),
  );

  for (const agent of relayAgents ?? []) {
    const isAllowed =
      eligibilityScope.type === "managed-only"
        ? false
        : eligibilityScope.type === "community"
          ? // SECURITY: community/global autocomplete has no single channel context;
            // omit live-membership fallback so relay agents are not shown based on
            // channel-scoped membership hints alone (trust model: directory + shared channels).
            relayAgentIsSharedWithUser(agent, sharedChannelIds, currentPubkey)
          : relayAgentCanRespondInChannel(
              agent,
              eligibilityScope.channelId,
              currentPubkey,
              resolvedChannelMemberAgentPubkeys,
            );
    if (isAllowed) {
      pubkeys.add(normalizePubkey(agent.pubkey));
    }
  }

  // The relay agent directory is seeded from kind:10100, an event each agent
  // publishes about itself — a `bot` channel member that never published it is
  // absent from `relayAgents` entirely, so the loop above can't reach it and the
  // agent becomes unmentionable, un-DM-able and un-addable from the UI. Channel
  // membership is the authoritative signal that the agent is here, so seed from
  // it too. Directory entries still win: an agent the directory knows about was
  // already judged above by its `respond_to`, so a not-invocable one stays out.
  // In `community` scope there is no single channel context, so this only uses
  // the set a caller passes explicitly — callers must pass bot members of
  // channels the viewer actually shares, never a channel-scoped hint from
  // elsewhere.
  if (eligibilityScope.type !== "managed-only") {
    const directoryPubkeys = new Set(
      (relayAgents ?? []).map((agent) => normalizePubkey(agent.pubkey)),
    );
    for (const memberPubkey of resolvedChannelMemberAgentPubkeys ?? []) {
      const normalized = normalizePubkey(memberPubkey);
      if (!directoryPubkeys.has(normalized)) {
        pubkeys.add(normalized);
      }
    }
  }

  return pubkeys;
}

export function getMentionableAgentPubkeysFromComposer({
  mentionChannelId,
  channelMembers,
  membersLoading,
  hasExternalMembers,
  currentPubkey,
  managedAgentPubkeys,
  relayAgents,
  sharedChannelIds,
}: {
  mentionChannelId: string | null;
  channelMembers: readonly ChannelMember[] | undefined;
  membersLoading: boolean;
  hasExternalMembers: boolean;
  currentPubkey?: string | null;
  managedAgentPubkeys: Iterable<string>;
  relayAgents: readonly RelayAgent[] | undefined;
  sharedChannelIds: ReadonlySet<string>;
}) {
  return getMentionableAgentPubkeys({
    currentPubkey,
    eligibilityScope: mentionChannelId
      ? {
          type: "channel",
          channelId: mentionChannelId,
          channelMembers,
          membersLoading,
          hasExternalMembers,
        }
      : { type: "managed-only" },
    managedAgentPubkeys,
    relayAgents,
    sharedChannelIds,
  });
}

export function isAgentIdentityInAllowedList(
  candidate: { isAgent?: boolean; pubkey: string },
  allowedAgentPubkeys: ReadonlySet<string>,
) {
  return (
    candidate.isAgent !== true ||
    allowedAgentPubkeys.has(normalizePubkey(candidate.pubkey))
  );
}

export function shouldHideAgentFromMentions({
  isAgent,
  isMember,
  pubkey,
  mentionableAgentPubkeys,
  directoryAgentPubkeys,
}: {
  isAgent: boolean;
  isMember: boolean;
  pubkey: string;
  mentionableAgentPubkeys: ReadonlySet<string>;
  directoryAgentPubkeys: ReadonlySet<string>;
}) {
  if (!isAgent) return false;
  const normalized = normalizePubkey(pubkey);
  // Invocable => always show.
  if (mentionableAgentPubkeys.has(normalized)) return false;
  // Non-member, non-invocable => hide (preserves prior behavior).
  if (!isMember) return true;
  // Member (Option B): hide only when we have an explicit not-invocable
  // signal — a relay directory (kind:10100) entry that excludes us.
  // Unknown invocability (not in directory) => show.
  //
  // NOTE: this assumes `directoryAgentPubkeys` and `mentionableAgentPubkeys`
  // share the same source query (`relayAgentsQuery.data`), so directory
  // presence without membership in `mentionableAgentPubkeys` is a real
  // explicit-exclusion signal. If a future change sources the directory set
  // from a different query, an agent that's directory-present but whose
  // mentionability is still loading could be hidden prematurely — keep the
  // two sets derived from the same query.
  return directoryAgentPubkeys.has(normalized);
}

export function isAgentMentionChannelType(type?: string | null) {
  return type === "stream" || type === "forum";
}

export function uniqueAutocompleteLabels(
  candidates: readonly AgentAutocompleteCandidate[],
) {
  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    for (const label of [
      candidate.displayName,
      candidate.personaName,
      candidate.secondaryLabel,
    ]) {
      const trimmed = label?.trim();
      if (trimmed && !unique.has(trimmed.toLowerCase())) {
        unique.set(trimmed.toLowerCase(), trimmed);
      }
    }
  }
  return [...unique.values()];
}

export function filterCachedAgentSuggestions<
  T extends {
    isAgent?: boolean;
    pubkey?: string;
  },
>(
  suggestions: readonly T[],
  currentCandidates: readonly AgentAutocompleteCandidate[],
) {
  const admittedAgentPubkeys = new Set(
    currentCandidates.flatMap((candidate) =>
      candidate.isAgent && candidate.pubkey
        ? [normalizePubkey(candidate.pubkey)]
        : [],
    ),
  );
  return suggestions.filter(
    (suggestion) =>
      !suggestion.isAgent ||
      !suggestion.pubkey ||
      admittedAgentPubkeys.has(normalizePubkey(suggestion.pubkey)),
  );
}

type AgentAutocompleteCandidate = {
  pubkey?: string;
  displayName?: string | null;
  personaName?: string | null;
  secondaryLabel?: string | null;
  ownerPubkey?: string | null;
  isAgent?: boolean;
  isManagedAgent?: boolean;
  isMember?: boolean;
  personaId?: string | null;
};

function agentIdentityKey<T extends AgentAutocompleteCandidate>(candidate: T) {
  if (candidate.isAgent !== true || !candidate.pubkey) {
    return null;
  }

  // Pubkeys—not persona metadata or a display name—are agent identities.
  // A persona may be installed more than once, and an owner may intentionally
  // create multiple same-named agents. Collapsing either case makes one agent
  // impossible to choose from autocomplete.
  return `pubkey:${normalizePubkey(candidate.pubkey)}`;
}

function agentCandidateRank<T extends AgentAutocompleteCandidate>(
  candidate: T,
  preferredPubkeys: ReadonlySet<string>,
) {
  const pubkey = candidate.pubkey ? normalizePubkey(candidate.pubkey) : null;

  return [
    candidate.isMember === true ? 0 : 1,
    pubkey && preferredPubkeys.has(pubkey) ? 0 : 1,
    candidate.isManagedAgent === true ? 0 : 1,
    candidate.personaId ? 0 : 1,
  ];
}

function isPreferredAgentCandidate<T extends AgentAutocompleteCandidate>(
  next: T,
  current: T,
  preferredPubkeys: ReadonlySet<string>,
) {
  const nextRank = agentCandidateRank(next, preferredPubkeys);
  const currentRank = agentCandidateRank(current, preferredPubkeys);

  for (let index = 0; index < nextRank.length; index++) {
    if (nextRank[index] !== currentRank[index]) {
      return nextRank[index] < currentRank[index];
    }
  }

  return false;
}

export function coalesceAutocompleteCandidatesByKey<T>(
  candidates: readonly T[],
  getKey: (candidate: T) => string | null,
) {
  const output: T[] = [];
  const indexesByKey = new Map<string, number>();

  for (const candidate of candidates) {
    const key = getKey(candidate);
    if (!key) {
      output.push(candidate);
      continue;
    }

    if (!indexesByKey.has(key)) {
      indexesByKey.set(key, output.length);
      output.push(candidate);
    }
  }

  return output;
}

export function coalesceAgentAutocompleteCandidates<
  T extends AgentAutocompleteCandidate,
>(
  candidates: readonly T[],
  {
    currentPubkey: _currentPubkey,
    getLabel: _getLabel,
    preferredPubkeys = new Set(),
  }: {
    currentPubkey?: string | null;
    getLabel: (candidate: T) => string | null | undefined;
    preferredPubkeys?: ReadonlySet<string>;
  },
) {
  const output: T[] = [];
  const indexesByKey = new Map<string, number>();

  for (const candidate of candidates) {
    const key = agentIdentityKey(candidate);
    if (!key) {
      output.push(candidate);
      continue;
    }

    const currentIndex = indexesByKey.get(key);
    if (currentIndex === undefined) {
      indexesByKey.set(key, output.length);
      output.push(candidate);
      continue;
    }

    if (
      isPreferredAgentCandidate(
        candidate,
        output[currentIndex],
        preferredPubkeys,
      )
    ) {
      output[currentIndex] = candidate;
    }
  }

  return output;
}
