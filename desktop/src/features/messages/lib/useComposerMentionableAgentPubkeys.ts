import * as React from "react";
import { getMentionableAgentPubkeysFromComposer } from "@/features/agents/lib/agentAutocompleteEligibility";
import type { ChannelMember, RelayAgent } from "@/shared/api/types";

export function useComposerMentionableAgentPubkeys({
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
  return React.useMemo(
    () =>
      getMentionableAgentPubkeysFromComposer({
        mentionChannelId,
        channelMembers,
        membersLoading,
        hasExternalMembers,
        currentPubkey,
        managedAgentPubkeys,
        relayAgents,
        sharedChannelIds,
      }),
    [
      channelMembers,
      currentPubkey,
      hasExternalMembers,
      managedAgentPubkeys,
      membersLoading,
      mentionChannelId,
      relayAgents,
      sharedChannelIds,
    ],
  );
}
