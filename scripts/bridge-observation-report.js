#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const archiveDir = process.env.ARCHIVE_DIR || path.resolve('data');
const observationsDir = path.join(archiveDir, 'observations');
const bridgeFile = path.join(observationsDir, 'bridge-events.jsonl');
const requestTimingFile = path.join(observationsDir, 'request-timing.jsonl');

function readJsonl(file) {
  if (!fs.existsSync(file)) return { events: [], damagedLines: [], exists: false };
  const events = [];
  const damagedLines = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((raw, index) => {
    const line = raw.replace(/\0/g, '').trim();
    if (!line) {
      if (raw.length) damagedLines.push(index + 1);
      return;
    }
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('expected an object');
      events.push(event);
    } catch {
      damagedLines.push(index + 1);
    }
  });
  if (damagedLines.length) {
    console.error(`warning: skipped ${damagedLines.length} damaged line(s) in ${path.basename(file)}: ${damagedLines.slice(0, 20).join(', ')}${damagedLines.length > 20 ? ', ...' : ''}`);
  }
  return { events, damagedLines, exists: true };
}

function countBy(events, key) {
  return Object.fromEntries(Object.entries(events.reduce((counts, event) => {
    const value = event[key] ?? 'null';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {})).sort(([a], [b]) => a.localeCompare(b)));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function timestampMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const valueMs = Date.parse(value);
  return Number.isFinite(valueMs) ? valueMs : null;
}

function rounded(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function summarizeGaps(starts) {
  const sorted = [...starts].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((start, index) => start - sorted[index]);
  return {
    count: gaps.length,
    min_ms: gaps.length ? rounded(gaps.reduce((lowest, gap) => Math.min(lowest, gap), Infinity)) : null,
    median_ms: rounded(median(gaps)),
    p95_ms: rounded(percentile(gaps, 0.95)),
    max_ms: gaps.length ? rounded(gaps.reduce((highest, gap) => Math.max(highest, gap), -Infinity)) : null,
  };
}

function summarizeRequestTiming(events) {
  const apiEvents = events.filter((event) => event.event_type === 'api_request');
  const groups = new Map();
  const states = new Map();
  const legacyTabs = new Map();
  const invalidWithoutTab = [];

  const groupFor = (event) => {
    const account = event.account || 'unknown';
    const endpointClass = event.endpoint_class || 'unknown';
    const key = JSON.stringify([account, endpointClass]);
    if (!groups.has(key)) {
      groups.set(key, {
        account,
        endpoint_class: endpointClass,
        events: [],
        starts: [],
        status_counts: {},
        timing_basis_counts: {},
        invalid_timing_reason_counts: {},
        valid_timing_rows: 0,
      });
    }
    return groups.get(key);
  };

  for (const event of apiEvents) {
    const group = groupFor(event);
    group.events.push(event);
    const status = event.api_status == null ? 'missing' : String(event.api_status);
    group.status_counts[status] = (group.status_counts[status] || 0) + 1;
    const basis = event.timing_basis || `schema_v${event.schema_version ?? 'unknown'}_legacy_or_unset`;
    group.timing_basis_counts[basis] = (group.timing_basis_counts[basis] || 0) + 1;
    states.set(event, { valid: false, startMs: null, reason: null });

    if (Number(event.schema_version) === 3) {
      if (event.timing_basis !== 'broker_receipt_minus_page_monotonic_age') {
        states.get(event).reason = 'unsupported_schema_v3_timing_basis';
      } else {
        const startMs = timestampMs(event.request_started_at);
        if (startMs == null) states.get(event).reason = 'invalid_request_started_at';
        else if (!event.account) states.get(event).reason = 'missing_account';
        else states.set(event, { valid: true, startMs, reason: null });
      }
      continue;
    }

    if (Number(event.schema_version) !== 2) {
      states.get(event).reason = 'unsupported_schema_version';
      continue;
    }

    if (!event.account) {
      states.get(event).reason = 'missing_account';
      invalidWithoutTab.push(event);
      continue;
    }
    if (!event.tab) {
      states.get(event).reason = 'missing_tab_identity';
      invalidWithoutTab.push(event);
      continue;
    }
    const key = JSON.stringify([event.account, event.tab]);
    if (!legacyTabs.has(key)) legacyTabs.set(key, { account: event.account, tab: event.tab, events: [] });
    const completedMs = timestampMs(event.completed_at);
    const brokerMs = timestampMs(event.ts);
    legacyTabs.get(key).events.push({ event, completedMs, offsetMs: completedMs == null || brokerMs == null ? null : brokerMs - completedMs });
  }

  const tabClockValidation = [];
  for (const tab of legacyTabs.values()) {
    const offsetRows = tab.events.filter((row) => Number.isFinite(row.offsetMs));
    const offsets = offsetRows.map((row) => row.offsetMs);
    const offsetMedian = median(offsets);
    const mad = offsetMedian == null ? null : median(offsets.map((offset) => Math.abs(offset - offsetMedian)));
    const split = Math.floor(offsets.length / 2);
    const halfShift = split > 0 && offsets.length - split > 0
      ? Math.abs(median(offsets.slice(0, split)) - median(offsets.slice(split)))
      : null;
    const reasons = [];
    if (offsetRows.length !== tab.events.length) reasons.push('missing_clock_offset_sample');
    if (offsets.length < 2 || halfShift == null) reasons.push('insufficient_offset_samples');
    if (mad != null && mad > 1000) reasons.push('median_absolute_deviation_exceeds_1000_ms');
    if (halfShift != null && halfShift > 2000) reasons.push('half_window_shift_exceeds_2000_ms');
    const timingValid = reasons.length === 0;

    tabClockValidation.push({
      account: tab.account,
      tab: tab.tab,
      rows: tab.events.length,
      offset_samples: offsets.length,
      median_offset_ms: rounded(offsetMedian),
      median_absolute_deviation_ms: rounded(mad),
      first_half_vs_second_half_shift_ms: rounded(halfShift),
      timing_valid: timingValid,
      invalid_reasons: reasons,
    });

    for (const row of tab.events) {
      const state = states.get(row.event);
      if (!timingValid) {
        state.reason = reasons[0] || 'unstable_legacy_clock_offset';
        continue;
      }
      if (row.completedMs == null || !Number.isFinite(row.event.duration_ms) || row.event.duration_ms < 0) {
        state.reason = 'invalid_page_completion_or_duration';
        continue;
      }
      state.valid = true;
      state.startMs = row.completedMs + offsetMedian - row.event.duration_ms;
      state.reason = null;
    }
  }

  for (const event of invalidWithoutTab) {
    const state = states.get(event);
    if (!state.reason) state.reason = 'legacy_timing_not_validated';
  }

  for (const event of apiEvents) {
    const state = states.get(event);
    const group = groupFor(event);
    if (state.valid) {
      group.valid_timing_rows++;
      group.starts.push(state.startMs);
    } else {
      const reason = state.reason || 'invalid_timing';
      group.invalid_timing_reason_counts[reason] = (group.invalid_timing_reason_counts[reason] || 0) + 1;
    }
  }

  const byAccountEndpoint = [...groups.values()].map((group) => {
    const requestCount = group.events.length;
    const rateLimitedCount = group.status_counts['429'] || 0;
    return {
      account: group.account,
      endpoint_class: group.endpoint_class,
      request_count: requestCount,
      status_counts: Object.fromEntries(Object.entries(group.status_counts).sort(([a], [b]) => a.localeCompare(b))),
      missing_status_count: group.status_counts.missing || 0,
      rate_limited_count: rateLimitedCount,
      rate_limited_share: requestCount ? rateLimitedCount / requestCount : null,
      valid_timing_rows: group.valid_timing_rows,
      invalid_timing_rows: requestCount - group.valid_timing_rows,
      timing_basis_counts: Object.fromEntries(Object.entries(group.timing_basis_counts).sort(([a], [b]) => a.localeCompare(b))),
      invalid_timing_reason_counts: Object.fromEntries(Object.entries(group.invalid_timing_reason_counts).sort(([a], [b]) => a.localeCompare(b))),
      observed_start_gaps_ms: summarizeGaps(group.starts),
    };
  }).sort((a, b) => a.account.localeCompare(b.account) || a.endpoint_class.localeCompare(b.endpoint_class));

  const accountGroups = new Map();
  for (const endpointGroup of byAccountEndpoint) {
    const account = accountGroups.get(endpointGroup.account) || {
      account: endpointGroup.account,
      request_count: 0,
      status_counts: {},
      missing_status_count: 0,
      rate_limited_count: 0,
      valid_timing_rows: 0,
      invalid_timing_rows: 0,
      endpoint_classes: [],
    };
    account.request_count += endpointGroup.request_count;
    account.missing_status_count += endpointGroup.missing_status_count;
    account.rate_limited_count += endpointGroup.rate_limited_count;
    account.valid_timing_rows += endpointGroup.valid_timing_rows;
    account.invalid_timing_rows += endpointGroup.invalid_timing_rows;
    for (const [status, count] of Object.entries(endpointGroup.status_counts)) {
      account.status_counts[status] = (account.status_counts[status] || 0) + count;
    }
    account.endpoint_classes.push({
      endpoint_class: endpointGroup.endpoint_class,
      request_count: endpointGroup.request_count,
      rate_limited_count: endpointGroup.rate_limited_count,
      observed_start_gaps_ms: endpointGroup.observed_start_gaps_ms,
    });
    accountGroups.set(endpointGroup.account, account);
  }
  const byAccount = [...accountGroups.values()].map((account) => ({
    ...account,
    rate_limited_share: account.request_count ? account.rate_limited_count / account.request_count : null,
    status_counts: Object.fromEntries(Object.entries(account.status_counts).sort(([a], [b]) => a.localeCompare(b))),
  })).sort((a, b) => a.account.localeCompare(b.account));

  const gapEvents = events.filter((event) => event.event_type === 'telemetry_gap');
  return {
    event_rows: events.length,
    api_request_rows: apiEvents.length,
    api_schema_versions: countBy(apiEvents, 'schema_version'),
    valid_timing_rows: apiEvents.filter((event) => states.get(event).valid).length,
    invalid_timing_rows: apiEvents.filter((event) => !states.get(event).valid).length,
    damaged_lines_skipped: 0,
    by_account: byAccount,
    by_account_endpoint: byAccountEndpoint,
    legacy_tab_clock_validation: tabClockValidation.sort((a, b) => a.account.localeCompare(b.account) || a.tab.localeCompare(b.tab)),
    legacy_rows_without_tab_or_account: invalidWithoutTab.length,
    telemetry_gaps: {
      event_rows: gapEvents.length,
      dropped_observations: gapEvents.reduce((sum, event) => sum + (Number.isInteger(event.dropped) && event.dropped > 0 ? event.dropped : 0), 0),
    },
  };
}

function groupOutcomeCounts(events, accountField = 'account') {
  const groups = new Map();
  for (const event of events) {
    const account = event[accountField] || 'unknown';
    const outcome = event.outcome || (event.ok === true ? 'success' : event.ok === false ? 'failed' : 'unknown');
    const key = JSON.stringify([account, outcome]);
    groups.set(key, { account, outcome, count: (groups.get(key)?.count || 0) + 1 });
  }
  return [...groups.values()].sort((a, b) => a.account.localeCompare(b.account) || a.outcome.localeCompare(b.outcome));
}

function summarizeBrokerActions(events) {
  const groups = new Map();
  for (const event of events) {
    const account = event.account || 'unknown';
    const action = event.action || 'unknown';
    const outcome = event.ok === true ? 'success' : event.ok === false ? 'failed' : 'unknown';
    const rateLimited = event.rate_limited === true;
    const key = JSON.stringify([account, action, outcome, rateLimited]);
    const group = groups.get(key) || { account, action, outcome, rate_limited: rateLimited, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.account.localeCompare(b.account)
    || a.action.localeCompare(b.action) || a.outcome.localeCompare(b.outcome));
}

function summarizeRoutes(requestEvents, bridgeEvents) {
  const decisions = requestEvents.filter((event) => event.event_type === 'account_route');
  const routedOutcomes = bridgeEvents.filter((event) => event.route_id);
  const decisionsById = new Map();
  const outcomesById = new Map();
  let decisionsMissingId = 0;
  for (const decision of decisions) {
    if (!decision.route_id) { decisionsMissingId++; continue; }
    if (!decisionsById.has(decision.route_id)) decisionsById.set(decision.route_id, []);
    decisionsById.get(decision.route_id).push(decision);
  }
  for (const outcome of routedOutcomes) {
    if (!outcomesById.has(outcome.route_id)) outcomesById.set(outcome.route_id, []);
    outcomesById.get(outcome.route_id).push(outcome);
  }

  let linkedOneToOne = 0;
  let decisionsWithoutOutcome = 0;
  let decisionsWithMultipleOutcomes = 0;
  let duplicateDecisionIds = 0;
  let accountMismatches = 0;
  const linkedOutcomeCounts = [];
  for (const [routeId, routeDecisions] of decisionsById) {
    const routeOutcomes = outcomesById.get(routeId) || [];
    if (routeDecisions.length > 1) duplicateDecisionIds++;
    if (!routeOutcomes.length) { decisionsWithoutOutcome += routeDecisions.length; continue; }
    if (routeOutcomes.length > 1) { decisionsWithMultipleOutcomes += routeDecisions.length; continue; }
    if (routeDecisions.length !== 1) continue;
    const decision = routeDecisions[0];
    const outcome = routeOutcomes[0];
    linkedOneToOne++;
    const accountMatches = decision.selected_account === outcome.account;
    if (!accountMatches) accountMismatches++;
    linkedOutcomeCounts.push({ account: outcome.account || decision.selected_account || 'unknown', outcome: outcome.outcome || 'unknown' });
  }

  const outcomesWithoutDecision = routedOutcomes.filter((outcome) => !decisionsById.has(outcome.route_id)).length;
  return {
    route_decisions: decisions.length,
    route_decisions_missing_route_id: decisionsMissingId,
    route_decision_ids_with_multiple_records: duplicateDecisionIds,
    route_decisions_linked_to_one_outcome: linkedOneToOne,
    route_decisions_without_outcome: decisionsWithoutOutcome,
    route_decisions_with_multiple_outcomes: decisionsWithMultipleOutcomes,
    linked_route_outcomes_with_account_mismatch: accountMismatches,
    bridge_outcomes_with_route_id: routedOutcomes.length,
    bridge_outcomes_without_matching_route_decision: outcomesWithoutDecision,
    linked_outcomes_by_account: groupOutcomeCounts(linkedOutcomeCounts),
  };
}

function reportLabels(events, field, prefix) {
  const identities = [...new Set(events
    .map((event) => event[field])
    .filter((identity) => typeof identity === 'string' && identity && identity !== 'unknown'))]
    .sort((a, b) => a.localeCompare(b));
  return new Map(identities.map((identity, index) => [identity, `${prefix}_${index + 1}`]));
}

function anonymizeReportIdentifiers(value, labels) {
  if (Array.isArray(value)) return value.map((item) => anonymizeReportIdentifiers(item, labels));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const identifierFields = {
      account: { output: 'account', labels: labels.account },
      selected_account: { output: 'selected_account', labels: labels.account },
      tab: { output: 'tab_ref', labels: labels.tab },
      thread_id: { output: 'thread_ref', labels: labels.thread },
    };
    const identifier = identifierFields[key];
    if (identifier && typeof item === 'string') {
      const label = item === 'unknown' ? item : identifier.labels.get(item) || 'unknown';
      return [identifier.output, label];
    }
    if (key === 'file' && typeof item === 'string') return [key, path.basename(item)];
    return [key, anonymizeReportIdentifiers(item, labels)];
  }));
}

const bridgeLog = readJsonl(bridgeFile);
const requestLog = readJsonl(requestTimingFile);
const events = bridgeLog.events;
const allEvents = [...requestLog.events, ...events];
const labels = {
  account: reportLabels(allEvents.flatMap((event) => [
    { account: event.account },
    { account: event.selected_account },
  ]), 'account', 'account'),
  tab: reportLabels(allEvents, 'tab', 'tab'),
  thread: reportLabels(allEvents, 'thread_id', 'conversation'),
};
const durations = events.map((event) => event.duration_ms).filter(Number.isFinite).sort((a, b) => a - b);
const oldPercentile = (p) => durations.length ? durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * p))] : null;
const brokerActions = requestLog.events.filter((event) => event.event_type === 'broker_action');
const report = {
  damaged_lines_skipped: bridgeLog.damagedLines.length,
  events: events.length,
  by_outcome: countBy(events, 'outcome'),
  by_failure_kind: countBy(events, 'failure_kind'),
  by_conversation_mode: countBy(events, 'conversation_mode'),
  by_thinking_level: countBy(events, 'thinking_level'),
  bridge_outcomes_by_account: groupOutcomeCounts(events),
  duration_ms: { median: oldPercentile(0.5), p95: oldPercentile(0.95) },
  rate_limited_events: events.filter((event) => event.failure_kind === 'rate_limited').map((event) => ({ started_at: event.started_at, ended_at: event.ended_at, thread_id: event.thread_id, conversation_mode: event.conversation_mode, history_message_count: event.history_message_count })),
  request_timing: {
    ...summarizeRequestTiming(requestLog.events),
    damaged_lines_skipped: requestLog.damagedLines.length,
    file: requestTimingFile,
  },
  broker_actions: {
    event_rows: brokerActions.length,
    by_account_action_outcome: summarizeBrokerActions(brokerActions),
  },
  route_outcome_join: summarizeRoutes(requestLog.events, events),
  limitations: [
    'Passive api_request observations are account and endpoint evidence; they have no route_id and are not causally assigned to individual asks.',
    'route_id joins an automatic account_route decision to its broker ask outcome only; it does not claim that passive API requests came from that ask.',
    'Account, tab, and conversation identifiers are replaced with labels consistent only within this report; source file paths are reduced to basenames.',
    'These observations cover connected browser pages only and do not expose ChatGPT quota counters or activity outside those pages.',
    'Observed counts and gaps do not establish a global optimal or maximum useful throughput rate.',
  ],
  file: bridgeFile,
};
if (!bridgeLog.exists) {
  report.message = requestLog.exists
    ? 'No bridge observations have been captured yet.'
    : 'No bridge or request-timing observations have been captured yet.';
}
console.log(JSON.stringify(anonymizeReportIdentifiers(report, labels), null, 2));
