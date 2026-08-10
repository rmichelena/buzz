//! Enrich kind:10100 relay agent directory entries with kind:30177 policy and
//! kind:39002 channel membership (#4913 / #5363).

use std::collections::{HashMap, HashSet};

use buzz_core_pkg::kind::KIND_MANAGED_AGENT;

use crate::{
    app_state::AppState,
    managed_agents::{agent_events::managed_agent_content_from_event, RelayAgentInfo},
    nostr_convert,
    relay::query_relay,
};

/// Relay HTTP `/query` default page size when `limit` is omitted.
const RELAY_DEFAULT_QUERY_LIMIT: usize = 100;
/// Relay hard cap for explicit `limit` (`DEFAULT_MAX_PAGE_LIMIT` in buzz-db).
const RELAY_MAX_QUERY_LIMIT: usize = 1000;

/// kind:39002 returns one members-list event per channel, not per agent.
fn channel_membership_query_limit(agents: &[RelayAgentInfo]) -> usize {
    let agent_count = agents.len();
    let sparse_10100 = agents.iter().all(|agent| agent.channel_ids.is_empty());
    if sparse_10100 {
        // kind:10100 often omits channel_ids; cardinality is unknown — request max page.
        return RELAY_MAX_QUERY_LIMIT;
    }

    let mut channel_ids = HashSet::new();
    for agent in agents {
        channel_ids.extend(agent.channel_ids.iter().cloned());
    }
    // One 39002 event per channel where any agent is a member.
    let channel_cardinality = channel_ids.len().max(agent_count);
    channel_cardinality
        .saturating_mul(2)
        .clamp(RELAY_DEFAULT_QUERY_LIMIT, RELAY_MAX_QUERY_LIMIT)
}

/// kind:30177 is replaceable by (author, kind, d): several events can share a d-tag.
fn managed_agent_definition_query_limit(agent_count: usize) -> usize {
    agent_count
        .saturating_mul(4)
        .clamp(RELAY_DEFAULT_QUERY_LIMIT, RELAY_MAX_QUERY_LIMIT)
}

fn d_tag_from_event(event: &nostr::Event) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let slice = tag.as_slice();
        if slice.first().map(String::as_str) == Some("d") {
            slice.get(1).filter(|value| !value.is_empty()).cloned()
        } else {
            None
        }
    })
}

fn channel_ids_by_agent_from_membership_events(
    events: &[nostr::Event],
    agent_pubkeys: &HashSet<String>,
) -> HashMap<String, Vec<String>> {
    let mut by_agent: HashMap<String, HashSet<String>> = HashMap::new();
    for event in events {
        let Some(channel_id) = d_tag_from_event(event) else {
            continue;
        };
        for tag in event.tags.iter() {
            let slice = tag.as_slice();
            if slice.first().map(String::as_str) != Some("p") {
                continue;
            }
            let Some(agent_pubkey) = slice.get(1).filter(|value| !value.is_empty()) else {
                continue;
            };
            if agent_pubkeys.contains(agent_pubkey) {
                by_agent
                    .entry(agent_pubkey.clone())
                    .or_default()
                    .insert(channel_id.clone());
            }
        }
    }

    let mut sorted: HashMap<String, Vec<String>> = HashMap::with_capacity(by_agent.len());
    for (agent_pubkey, channel_ids) in by_agent {
        let mut channel_ids: Vec<String> = channel_ids.into_iter().collect();
        channel_ids.sort();
        sorted.insert(agent_pubkey, channel_ids);
    }
    sorted
}

fn collect_managed_agent_definitions(
    events: &[nostr::Event],
    expected_owners: &HashMap<String, String>,
) -> HashMap<String, (crate::managed_agents::RespondTo, Vec<String>)> {
    let mut definitions: HashMap<
        String,
        (crate::managed_agents::RespondTo, Vec<String>, u64, String),
    > = HashMap::new();
    for event in events {
        let Some(agent_pubkey) = d_tag_from_event(event) else {
            tracing::warn!("list_relay_agents: skipping kind:30177 event without d-tag");
            continue;
        };
        let event_author = event.pubkey.to_hex();
        let Some(expected_owner) = expected_owners.get(&agent_pubkey) else {
            continue;
        };
        if event_author != *expected_owner {
            continue;
        }
        let Ok(content) = managed_agent_content_from_event(event) else {
            tracing::warn!(
                agent_pubkey = %agent_pubkey,
                "list_relay_agents: skipping unparsable kind:30177 content"
            );
            continue;
        };
        let created_at = event.created_at.as_secs();
        let event_id = event.id.to_hex();
        match definitions.get(&agent_pubkey) {
            Some((_, _, existing_created_at, existing_event_id))
                if created_at < *existing_created_at
                    || (created_at == *existing_created_at && event_id <= *existing_event_id) =>
            {
                continue;
            }
            _ => {
                definitions.insert(
                    agent_pubkey,
                    (
                        content.respond_to,
                        content.respond_to_allowlist,
                        created_at,
                        event_id,
                    ),
                );
            }
        }
    }
    definitions
        .into_iter()
        .map(|(agent_pubkey, (respond_to, allowlist, _, _))| {
            (agent_pubkey, (respond_to, allowlist))
        })
        .collect()
}

async fn fetch_agent_owner_pubkeys(
    state: &AppState,
    agent_pubkeys: &[String],
) -> HashMap<String, String> {
    if agent_pubkeys.is_empty() {
        return HashMap::new();
    }

    match query_relay(
        state,
        &[serde_json::json!({
            "kinds": [0],
            "authors": agent_pubkeys,
            "limit": agent_pubkeys.len(),
        })],
    )
    .await
    {
        Ok(profile_events) => profile_events
            .into_iter()
            .filter_map(|event| {
                nostr_convert::profile_valid_oa_owner_pubkey(&event)
                    .map(|owner| (event.pubkey.to_hex(), owner))
            })
            .collect(),
        Err(error) => {
            tracing::warn!(
                error = %error,
                "list_relay_agents: kind:0 owner lookup failed; skipping kind:30177 enrichment"
            );
            HashMap::new()
        }
    }
}

async fn fetch_managed_agent_definitions(
    state: &AppState,
    agent_pubkeys: &[String],
    expected_owners: &HashMap<String, String>,
) -> HashMap<String, (crate::managed_agents::RespondTo, Vec<String>)> {
    if agent_pubkeys.is_empty() || expected_owners.is_empty() {
        return HashMap::new();
    }

    let owner_pubkeys: Vec<String> = expected_owners
        .values()
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    let filter = serde_json::json!({
        "kinds": [KIND_MANAGED_AGENT],
        "#d": agent_pubkeys,
        "authors": owner_pubkeys,
        "limit": managed_agent_definition_query_limit(agent_pubkeys.len()),
    });

    match query_relay(state, &[filter]).await {
        Ok(definition_events) => {
            collect_managed_agent_definitions(&definition_events, expected_owners)
        }
        Err(error) => {
            tracing::warn!(
                error = %error,
                "list_relay_agents: kind:30177 enrich failed; continuing with kind:10100 only"
            );
            HashMap::new()
        }
    }
}

async fn fetch_channel_ids_by_agent(
    state: &AppState,
    agents: &[RelayAgentInfo],
) -> Option<HashMap<String, Vec<String>>> {
    if agents.is_empty() {
        return Some(HashMap::new());
    }

    let agent_pubkeys: Vec<String> = agents.iter().map(|agent| agent.pubkey.clone()).collect();
    let agent_pubkey_set: HashSet<String> = agent_pubkeys.iter().cloned().collect();

    match query_relay(
        state,
        &[serde_json::json!({
            "kinds": [39002],
            "#p": agent_pubkeys,
            "limit": channel_membership_query_limit(agents),
        })],
    )
    .await
    {
        Ok(membership_events) => Some(channel_ids_by_agent_from_membership_events(
            &membership_events,
            &agent_pubkey_set,
        )),
        Err(error) => {
            tracing::warn!(
                error = %error,
                "list_relay_agents: kind:39002 membership enrich failed"
            );
            None
        }
    }
}

pub(super) async fn list_relay_agents_enriched(
    state: &AppState,
    events: Vec<nostr::Event>,
) -> Result<Vec<RelayAgentInfo>, String> {
    // The convert helper returns `{"agents": [...]}`. Extract and re-deserialize
    // into the strongly-typed `Vec<RelayAgentInfo>` the frontend expects.
    let value = nostr_convert::agents_from_events(&events);
    let agents = value
        .get("agents")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let agents: Vec<RelayAgentInfo> =
        serde_json::from_value(agents).map_err(|e| format!("agent parse failed: {e}"))?;

    // kind:10100 profiles are sparse: respond_to policy lives on kind:30177 and
    // channel membership is on kind:39002. Merge both so Desktop mention
    // eligibility (#4913 / #5363) sees the same data iOS already uses.
    Ok(enrich_relay_agents_from_relay(state, agents).await)
}

async fn enrich_relay_agents_from_relay(
    state: &AppState,
    mut agents: Vec<RelayAgentInfo>,
) -> Vec<RelayAgentInfo> {
    let agent_pubkeys: Vec<String> = agents.iter().map(|agent| agent.pubkey.clone()).collect();
    let (expected_owners, channel_ids_by_agent) = tokio::join!(
        fetch_agent_owner_pubkeys(state, &agent_pubkeys),
        fetch_channel_ids_by_agent(state, &agents),
    );
    let definitions =
        fetch_managed_agent_definitions(state, &agent_pubkeys, &expected_owners).await;

    for agent in &mut agents {
        // Owner-verified kind:30177 overrides kind:10100 self-declared policy when present.
        if let Some((respond_to, allowlist)) = definitions.get(&agent.pubkey) {
            agent.respond_to = Some(*respond_to);
            agent.respond_to_allowlist = allowlist.clone();
        }

        if let Some(discovered_by_agent) = &channel_ids_by_agent {
            // kind:39002 is authoritative for membership; keep 10100 hints on query failure
            // or when an agent is absent from a truncated page (R5 M2).
            let existing_channel_ids = agent.channel_ids.clone();
            agent.channel_ids = discovered_by_agent
                .get(&agent.pubkey)
                .cloned()
                .unwrap_or(existing_channel_ids);
        }
    }

    agents
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_membership_event(channel_id: &str, member_pubkey: &str) -> nostr::Event {
        use nostr::{EventBuilder, Keys, Kind, Tag};
        let keys = Keys::generate();
        EventBuilder::new(Kind::Custom(39_002), "")
            .tags(vec![
                Tag::parse(["d", channel_id]).unwrap(),
                Tag::parse(["p", member_pubkey, "", "member"]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .unwrap()
    }

    fn test_managed_agent_definition_event(
        agent_pubkey: &str,
        respond_to: &str,
        author_keys: &nostr::Keys,
    ) -> nostr::Event {
        use nostr::{EventBuilder, Kind, Tag};
        let content = serde_json::json!({
            "name": "Scout",
            "parallelism": 1,
            "respond_to": respond_to,
        });
        EventBuilder::new(Kind::Custom(KIND_MANAGED_AGENT as u16), content.to_string())
            .tags(vec![Tag::parse(["d", agent_pubkey]).unwrap()])
            .sign_with_keys(author_keys)
            .unwrap()
    }

    #[test]
    fn test_d_tag_from_event_reads_first_non_empty_d_tag() {
        let event = test_membership_event("273e2bad-b694-4a0e-bc2b-aefcc7d027bb", &"a".repeat(64));
        assert_eq!(
            d_tag_from_event(&event).as_deref(),
            Some("273e2bad-b694-4a0e-bc2b-aefcc7d027bb")
        );
    }

    #[test]
    fn test_d_tag_from_event_returns_none_without_d_tag() {
        use nostr::{EventBuilder, Keys, Kind};
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::Custom(39_002), "")
            .sign_with_keys(&keys)
            .unwrap();
        assert!(d_tag_from_event(&event).is_none());
    }

    #[test]
    fn test_channel_ids_by_agent_from_membership_events_groups_by_p_tag() {
        let agent_a = "a".repeat(64);
        let agent_b = "b".repeat(64);
        let events = vec![
            test_membership_event("channel-a", &agent_a),
            test_membership_event("channel-b", &agent_b),
            test_membership_event("channel-c", &agent_a),
        ];
        let agent_pubkeys = HashSet::from([agent_a.clone(), agent_b.clone()]);
        let by_agent = channel_ids_by_agent_from_membership_events(&events, &agent_pubkeys);
        assert_eq!(
            by_agent.get(&agent_a),
            Some(&vec!["channel-a".to_string(), "channel-c".to_string()])
        );
        assert_eq!(by_agent.get(&agent_b), Some(&vec!["channel-b".to_string()]));
    }

    #[test]
    fn test_collect_managed_agent_definitions_indexes_by_d_tag() {
        use nostr::Keys;
        let agent_pubkey = "a".repeat(64);
        let owner_keys = Keys::generate();
        let events = vec![test_managed_agent_definition_event(
            &agent_pubkey,
            "anyone",
            &owner_keys,
        )];
        let expected_owners =
            HashMap::from([(agent_pubkey.clone(), owner_keys.public_key().to_hex())]);
        let definitions = collect_managed_agent_definitions(&events, &expected_owners);
        let (respond_to, allowlist) = definitions.get(&agent_pubkey).unwrap();
        assert_eq!(*respond_to, crate::managed_agents::RespondTo::Anyone);
        assert!(allowlist.is_empty());
    }

    #[test]
    fn test_collect_managed_agent_definitions_prefers_newest_created_at() {
        use nostr::{EventBuilder, Kind, Tag, Timestamp};
        let agent_pubkey = "a".repeat(64);
        let owner_keys = nostr::Keys::generate();
        let older = EventBuilder::new(
            Kind::Custom(KIND_MANAGED_AGENT as u16),
            r#"{"name":"Scout","parallelism":1,"respond_to":"owner-only"}"#,
        )
        .tags(vec![Tag::parse(["d", &agent_pubkey]).unwrap()])
        .custom_created_at(Timestamp::from(100))
        .sign_with_keys(&owner_keys)
        .unwrap();
        let newer = EventBuilder::new(
            Kind::Custom(KIND_MANAGED_AGENT as u16),
            r#"{"name":"Scout","parallelism":1,"respond_to":"anyone"}"#,
        )
        .tags(vec![Tag::parse(["d", &agent_pubkey]).unwrap()])
        .custom_created_at(Timestamp::from(200))
        .sign_with_keys(&owner_keys)
        .unwrap();
        let expected_owners =
            HashMap::from([(agent_pubkey.clone(), owner_keys.public_key().to_hex())]);
        let definitions = collect_managed_agent_definitions(&[older, newer], &expected_owners);
        let (respond_to, _) = definitions.get(&agent_pubkey).unwrap();
        assert_eq!(*respond_to, crate::managed_agents::RespondTo::Anyone);
    }

    #[test]
    fn test_collect_managed_agent_definitions_filters_unexpected_authors() {
        use nostr::Keys;
        let agent_pubkey = "a".repeat(64);
        let owner_keys = Keys::generate();
        let spoof_keys = Keys::generate();
        let expected_owners =
            HashMap::from([(agent_pubkey.clone(), owner_keys.public_key().to_hex())]);
        let legitimate = test_managed_agent_definition_event(&agent_pubkey, "anyone", &owner_keys);
        let spoofed = test_managed_agent_definition_event(&agent_pubkey, "owner-only", &spoof_keys);
        let definitions =
            collect_managed_agent_definitions(&[legitimate, spoofed], &expected_owners);
        let (respond_to, _) = definitions.get(&agent_pubkey).unwrap();
        assert_eq!(*respond_to, crate::managed_agents::RespondTo::Anyone);
    }

    #[test]
    fn test_collect_managed_agent_definitions_skips_when_owner_unverified() {
        use nostr::Keys;
        let agent_pubkey = "a".repeat(64);
        let owner_keys = Keys::generate();
        let events = vec![test_managed_agent_definition_event(
            &agent_pubkey,
            "anyone",
            &owner_keys,
        )];
        let definitions = collect_managed_agent_definitions(&events, &HashMap::new());
        assert!(definitions.is_empty());
    }

    fn test_relay_agent(channel_ids: &[&str]) -> RelayAgentInfo {
        RelayAgentInfo {
            pubkey: "a".repeat(64),
            name: "Scout".to_string(),
            agent_type: "agent".to_string(),
            channels: vec![],
            channel_ids: channel_ids.iter().map(|id| (*id).to_string()).collect(),
            capabilities: vec![],
            status: "offline".to_string(),
            respond_to: None,
            respond_to_allowlist: vec![],
        }
    }

    #[test]
    fn test_channel_membership_query_limit_scales_with_channel_cardinality() {
        let agents = vec![
            test_relay_agent(&["channel-a", "channel-b", "channel-c"]),
            test_relay_agent(&["channel-d"]),
        ];
        assert_eq!(
            channel_membership_query_limit(&agents),
            RELAY_DEFAULT_QUERY_LIMIT
        );
    }

    #[test]
    fn test_channel_membership_query_limit_scales_above_relay_default() {
        let channel_ids: Vec<String> = (0..51).map(|i| format!("channel-{i}")).collect();
        let channel_refs: Vec<&str> = channel_ids.iter().map(String::as_str).collect();
        let agents = vec![test_relay_agent(&channel_refs)];
        assert_eq!(channel_membership_query_limit(&agents), 102);
    }

    #[test]
    fn test_channel_membership_query_limit_uses_max_page_when_10100_sparse() {
        assert_eq!(
            channel_membership_query_limit(&[test_relay_agent(&[])]),
            RELAY_MAX_QUERY_LIMIT
        );
    }

    #[test]
    fn test_managed_agent_definition_query_limit_allows_multiple_authors_per_d_tag() {
        assert_eq!(
            managed_agent_definition_query_limit(5),
            RELAY_DEFAULT_QUERY_LIMIT
        );
        assert_eq!(
            managed_agent_definition_query_limit(1),
            RELAY_DEFAULT_QUERY_LIMIT
        );
    }

    #[test]
    fn test_managed_agent_definition_query_limit_scales_above_relay_default() {
        assert_eq!(managed_agent_definition_query_limit(26), 104);
    }
}
