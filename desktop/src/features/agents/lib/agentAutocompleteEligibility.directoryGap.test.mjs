import assert from "node:assert/strict";
import test from "node:test";

import {
  getMentionableAgentPubkeys,
  getMentionableAgentPubkeysFromComposer,
  isAgentIdentityInAllowedList,
  shouldHideAgentFromMentions,
} from "./agentAutocompleteEligibility.ts";

// Regression suite for the "channel member bot with no kind:10100 directory
// entry" gap (issue #5363 follow-up).
//
// `list_relay_agents` (desktop/src-tauri/src/commands/agent_discovery.rs)
// seeds the relay agent directory from kind:10100 alone, so an agent that is a
// `bot` member of the channel but never published that event is absent from
// `relayAgents`. `getMentionableAgentPubkeys` only iterates `relayAgents`, so
// such a bot never reaches the allowed list and the composer, the DM recipient
// picker and the add-member search all drop it — the viewer cannot mention it,
// DM it, or add it to a channel from the UI at all.
//
// These tests encode the intended behavior: channel membership makes an agent
// *visible*; `respond_to` governs whether a send is allowed, not existence.
// In the upstream PR they belong next to the existing composer/DM suites; kept
// in a separate file here so the current red/green split is unambiguous.

const VIEWER = "a".repeat(64);
// Channel `bot` member that never published kind:10100.
const MEMBER_BOT_WITHOUT_DIRECTORY_ENTRY = "b".repeat(64);
// Relay agent that IS in the directory but refuses everyone but its owner.
const OWNER_ONLY_STRANGER = "c".repeat(64);
const CHANNEL_ID = "general";

function composerAllowedList({ channelMembers = [], relayAgents = [] } = {}) {
  return getMentionableAgentPubkeysFromComposer({
    mentionChannelId: CHANNEL_ID,
    channelMembers,
    membersLoading: false,
    hasExternalMembers: true,
    currentPubkey: VIEWER,
    managedAgentPubkeys: [],
    relayAgents,
    sharedChannelIds: new Set([CHANNEL_ID]),
  });
}

const memberBot = {
  pubkey: MEMBER_BOT_WITHOUT_DIRECTORY_ENTRY,
  role: "bot",
  isAgent: true,
};

// ── @ composer (useMentions.ts) ───────────────────────────────────────────────

test("composer: a channel member bot with no directory entry is mentionable", () => {
  const allowed = composerAllowedList({ channelMembers: [memberBot] });

  assert.equal(allowed.has(MEMBER_BOT_WITHOUT_DIRECTORY_ENTRY), true);
});

test("composer: the two gates, in useMentions order, keep that member bot", () => {
  // Mirrors useMentions.ts:248 (isAgentIdentityInAllowedList, early return)
  // followed by :252 (shouldHideAgentFromMentions). Both receive the same
  // `mentionableAgentPubkeys` set, and `directoryAgentPubkeys` is derived from
  // the same relayAgents query — empty here, because the bot has no kind:10100.
  const allowed = composerAllowedList({ channelMembers: [memberBot] });
  const directoryAgentPubkeys = new Set();
  const candidate = {
    pubkey: MEMBER_BOT_WITHOUT_DIRECTORY_ENTRY,
    isAgent: true,
    isMember: true,
  };

  assert.equal(
    shouldHideAgentFromMentions({
      isAgent: true,
      isMember: true,
      pubkey: MEMBER_BOT_WITHOUT_DIRECTORY_ENTRY,
      mentionableAgentPubkeys: allowed,
      directoryAgentPubkeys,
    }),
    false,
    "gate 2 already intends to show member bots with unknown invocability",
  );
  assert.equal(
    isAgentIdentityInAllowedList(candidate, allowed),
    true,
    "gate 1 (allowed list) drops the member bot before gate 2 can show it",
  );
});

// ── DM recipient picker (useNewMessageRecipients.ts, community scope) ─────────

test("dm recipients: community scope surfaces a shared-channel bot with no directory entry", () => {
  const allowed = getMentionableAgentPubkeys({
    channelMemberAgentPubkeys: new Set([MEMBER_BOT_WITHOUT_DIRECTORY_ENTRY]),
    currentPubkey: VIEWER,
    eligibilityScope: { type: "community" },
    managedAgentPubkeys: [],
    relayAgents: [],
    sharedChannelIds: new Set([CHANNEL_ID]),
  });

  assert.equal(allowed.has(MEMBER_BOT_WITHOUT_DIRECTORY_ENTRY), true);
});

// ── Directory entry with no policy (kind:10100 without respond_to) ───────────

test("composer: a directory agent with an unknown policy is visible when shared", () => {
  // `respondTo: null` = the directory has no policy for this agent. Unknown is
  // not a denial: it must not read as owner-only.
  const allowed = composerAllowedList({
    relayAgents: [
      {
        pubkey: MEMBER_BOT_WITHOUT_DIRECTORY_ENTRY,
        respondTo: null,
        respondToAllowlist: [],
        channelIds: [CHANNEL_ID],
      },
    ],
  });

  assert.equal(allowed.has(MEMBER_BOT_WITHOUT_DIRECTORY_ENTRY), true);
});

// ── Guards: these must stay green after the fix ───────────────────────────────

test("guard: a non-member owner-only relay agent stays out of the composer list", () => {
  const allowed = composerAllowedList({
    relayAgents: [
      {
        pubkey: OWNER_ONLY_STRANGER,
        respondTo: "owner-only",
        respondToAllowlist: [],
        channelIds: [CHANNEL_ID],
      },
    ],
  });

  assert.equal(allowed.has(OWNER_ONLY_STRANGER), false);
});

test("guard: an owner-only agent that IS a channel member still stays out", () => {
  // Membership must grant visibility, never override an explicit
  // not-invocable signal from the directory.
  const allowed = composerAllowedList({
    channelMembers: [
      { pubkey: OWNER_ONLY_STRANGER, role: "bot", isAgent: true },
    ],
    relayAgents: [
      {
        pubkey: OWNER_ONLY_STRANGER,
        respondTo: "owner-only",
        respondToAllowlist: [],
        channelIds: [CHANNEL_ID],
      },
    ],
  });

  assert.equal(allowed.has(OWNER_ONLY_STRANGER), false);
});
