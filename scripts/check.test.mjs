import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, normalizeMonitor, uptimePct, weightedTime, dailyBuckets, dayWindows, sydneyDateKey,
  pruneHistory, appendSample, checkMonitor, formatDuration, shouldCommit, formatBothZones,
  truncate, show, isBotClosure, shouldReopen, shouldWebhookOnReopen, commentDue, fence, escapeWebhookText, capBody, MAX_ERROR_CHARS,
} from './check.mjs';

const T = (s) => Date.parse(s);
const sample = (t, s, ms = 100) => ({ t, s, ms });

const ping = normalizeMonitor({ id: 'api-ping', url: 'https://x.test/ping/', expect: { status: [200], bodyIncludes: 'PONG' } });
const health = normalizeMonitor({
  id: 'api-health', url: 'https://x.test/health/',
  expect: { status: [200], jsonStatusIn: ['ok', 'degraded'] }, degradedJsonStatusIn: ['degraded'],
});

test('classify: up, wrong status, missing body, network error', () => {
  assert.equal(classify(ping, { status: 200, body: 'PONG', ms: 5 }).state, 'up');
  assert.equal(classify(ping, { status: 500, body: 'PONG' }).state, 'down');
  const missing = classify(ping, { status: 200, body: 'nope' });
  assert.equal(missing.state, 'down');
  assert.match(missing.error, /PONG/);
  assert.equal(classify(ping, { error: 'ECONNREFUSED' }).state, 'down');
});

test('classify: JSON health status ok / degraded / unhealthy / invalid', () => {
  const ok = JSON.stringify({ status: 'ok', checks: { database: 'ok' } });
  assert.equal(classify(health, { status: 200, body: ok }).state, 'up');

  const deg = classify(health, { status: 200, body: JSON.stringify({ status: 'degraded', checks: { database: 'ok', redis: 'error' } }) });
  assert.equal(deg.state, 'degraded');
  assert.match(deg.error, /redis: error/);

  const unhealthy = classify(health, { status: 503, body: JSON.stringify({ status: 'unhealthy' }) });
  assert.equal(unhealthy.state, 'down');
  assert.match(unhealthy.error, /503/);

  assert.equal(classify(health, { status: 200, body: JSON.stringify({ status: 'weird' }) }).state, 'down');
  assert.equal(classify(health, { status: 200, body: '<html>' }).state, 'down');
});

test('checkMonitor retries only failures and takes the best attempt', async () => {
  const seq = [{ status: 500, body: '', ms: 1 }, { status: 200, body: 'PONG', ms: 2 }];
  let calls = 0;
  const r = await checkMonitor(ping, { probeFn: async () => seq[calls++], sleepFn: async () => {} });
  assert.equal(r.state, 'up');
  assert.equal(calls, 2);
  assert.equal(r.attempts, 2);

  calls = 0;
  const down = await checkMonitor(ping, { probeFn: async () => { calls++; return { error: 'boom', ms: 1 }; }, sleepFn: async () => {} });
  assert.equal(down.state, 'down');
  assert.equal(calls, 3);

  calls = 0;
  const first = await checkMonitor(ping, { probeFn: async () => { calls++; return { status: 200, body: 'PONG', ms: 1 }; }, sleepFn: async () => {} });
  assert.equal(calls, 1);
  assert.equal(first.state, 'up');
});

test('uptime is weighted by time between samples, degraded counts as up', () => {
  const now = T('2026-10-12T04:00:00Z');
  const hist = [
    sample('2026-10-12T00:00:00Z', 'u'), // 0:00-1:00 up (1h)
    sample('2026-10-12T01:00:00Z', 'd'), // 1:00-2:00 down (1h)
    sample('2026-10-12T02:00:00Z', 'g'), // 2:00-4:00 degraded (2h, last sample runs until now)
  ];
  const { up, total } = weightedTime(hist, T('2026-10-12T00:00:00Z'), now, now);
  assert.equal(total, 4 * 3600_000);
  assert.equal(up, 3 * 3600_000);
  assert.equal(uptimePct(hist, T('2026-10-12T00:00:00Z'), now), 75);
  // window clipped to the last two hours: all degraded
  assert.equal(uptimePct(hist, now - 2 * 3600_000, now), 100);
  // no data at all
  assert.equal(uptimePct([], now - 3600_000, now), null);
  assert.equal(uptimePct(hist, T('2026-10-11T00:00:00Z'), T('2026-10-11T12:00:00Z'), now), null);
});

test('uptime treats a long silence as no data instead of extending the last state', () => {
  const now = T('2026-10-12T10:00:00Z');
  const hist = [sample('2026-10-12T00:00:00Z', 'd')];
  const { total } = weightedTime(hist, T('2026-10-12T00:00:00Z'), now, now);
  assert.equal(total, 3 * 3600_000); // capped at MAX_GAP_MS
});

test('Sydney date keys and DST-aware day windows', () => {
  assert.equal(sydneyDateKey(T('2026-10-11T12:30:00Z')), '2026-10-11'); // 23:30 AEDT
  assert.equal(sydneyDateKey(T('2026-10-11T13:30:00Z')), '2026-10-12'); // 00:30 AEDT
  assert.equal(sydneyDateKey(T('2026-07-01T13:30:00Z')), '2026-07-01'); // 23:30 AEST (+10)
  assert.equal(sydneyDateKey(T('2026-07-01T14:30:00Z')), '2026-07-02'); // 00:30 AEST

  const wins = dayWindows(T('2026-10-12T06:00:00Z'), 10);
  assert.equal(wins.length, 10);
  assert.equal(wins.at(-1).date, '2026-10-12');
  assert.equal(wins[0].date, '2026-10-03');
  for (let i = 1; i < wins.length; i++) assert.equal(wins[i - 1].end, wins[i].start); // contiguous
  const dstDay = wins.find((w) => w.date === '2026-10-04'); // clocks go forward: 23h day
  assert.equal(dstDay.end - dstDay.start, 23 * 3600_000);
});

test('dailyBuckets splits samples at Sydney midnight', () => {
  const now = T('2026-10-11T15:00:00Z'); // 02:00 on 12 Oct in Sydney
  const hist = [
    sample('2026-10-11T12:00:00Z', 'u'), // 23:00 Sydney 11 Oct
    sample('2026-10-11T13:00:00Z', 'd'), // 00:00 Sydney 12 Oct
    sample('2026-10-11T14:00:00Z', 'u'),
  ];
  const daily = dailyBuckets(hist, now, 3);
  assert.deepEqual(daily.map((d) => d.date), ['2026-10-10', '2026-10-11', '2026-10-12']);
  assert.equal(daily[0].up, null); // before any data
  assert.equal(daily[1].up, 100); // only the 1h up sample falls on the 11th
  assert.equal(daily[2].up, 50); // 1h down + 1h up on the 12th
});

test('history pruning and one-sample-per-run append', () => {
  const now = T('2026-10-12T00:00:00Z');
  const hist = [
    sample('2026-07-01T00:00:00Z', 'u'), // >90d old
    sample('2026-07-15T00:00:00Z', 'u'), // ~89d old
    sample('2026-10-11T00:00:00Z', 'u'),
  ];
  assert.equal(pruneHistory(hist, now).length, 2);
  assert.equal(pruneHistory(hist, now)[0].t, '2026-07-15T00:00:00Z');

  const next = appendSample(hist, sample('2026-10-12T00:00:00Z', 'd'));
  assert.equal(next.length, 4);
  const dup = appendSample(next, sample('2026-10-12T00:00:30Z', 'u')); // re-run within 2 min replaces
  assert.equal(dup.length, 4);
  assert.equal(dup.at(-1).s, 'u');
  assert.equal(hist.length, 3); // input not mutated
});

test('shouldCommit: first run, state change, hourly, otherwise no', () => {
  const base = { stateChanged: false, issueActivity: false };
  assert.equal(shouldCommit({ ...base, prevGeneratedAt: undefined, nowMs: T('2026-10-12T00:10:00Z') }).commit, true);
  assert.equal(shouldCommit({ ...base, stateChanged: true, prevGeneratedAt: '2026-10-12T00:05:00Z', nowMs: T('2026-10-12T00:10:00Z') }).commit, true);
  assert.equal(shouldCommit({ ...base, issueActivity: true, prevGeneratedAt: '2026-10-12T00:05:00Z', nowMs: T('2026-10-12T00:10:00Z') }).commit, true);
  assert.equal(shouldCommit({ ...base, prevGeneratedAt: '2026-10-12T00:00:10Z', nowMs: T('2026-10-12T00:25:00Z') }).commit, false);
  assert.equal(shouldCommit({ ...base, prevGeneratedAt: '2026-10-11T23:01:00Z', nowMs: T('2026-10-12T00:02:00Z') }).commit, true);
  assert.equal(shouldCommit({ ...base, prevGeneratedAt: '2026-10-12T00:03:00Z', nowMs: T('2026-10-12T01:02:00Z') }).commit, true); // overdue
});

test('formatting helpers', () => {
  assert.equal(formatDuration(20_000), 'less than a minute');
  assert.equal(formatDuration(5 * 60_000), '5 minutes');
  assert.equal(formatDuration(72 * 60_000), '1 hour 12 minutes');
  assert.equal(formatDuration(27 * 3600_000), '1 day 3 hours');
  assert.equal(formatBothZones(T('2026-10-12T03:04:00Z')), '2026-10-12 03:04 UTC / 2026-10-12 14:04 AEDT (Sydney)');
});

test('remote text is truncated and non-string JSON status values are stringified', () => {
  assert.equal(truncate('x'.repeat(1000)).length, MAX_ERROR_CHARS);
  assert.equal(truncate('short'), 'short');
  assert.equal(show('ok'), 'ok');
  assert.equal(show({ a: 1 }), '{"a":1}');
  assert.equal(show(undefined), 'undefined');

  const objStatus = classify(health, { status: 200, body: JSON.stringify({ status: { evil: '@everyone' } }) });
  assert.equal(objStatus.state, 'down');
  assert.match(objStatus.error, /\{"evil":"@everyone"\}/);
  assert.equal(classify(health, { status: 200, body: JSON.stringify({ status: 7 }) }).error, 'unexpected JSON status 7');
  assert.equal(classify(health, { status: 200, body: '{}' }).error, 'unexpected JSON status undefined');

  const longStatus = classify(health, { status: 200, body: JSON.stringify({ status: 'x'.repeat(5000) }) });
  assert.ok(longStatus.error.length <= MAX_ERROR_CHARS);
  const longNet = classify(ping, { error: 'e'.repeat(5000) });
  assert.ok(longNet.error.length <= MAX_ERROR_CHARS);
  const longChecks = classify(health, { status: 200, body: JSON.stringify({ status: 'degraded', checks: { db: 'z'.repeat(5000) } }) });
  assert.equal(longChecks.state, 'degraded');
  assert.ok(longChecks.error.length <= MAX_ERROR_CHARS);
});

test('issue/webhook text safety helpers', () => {
  assert.equal(fence('a`b'), "```text\na'b\n```");
  assert.ok(!fence('```\n@everyone').slice(7, -4).includes('`'));
  assert.equal(escapeWebhookText('<!channel> a&b <@123>'), '&lt;!channel&gt; a&amp;b &lt;@123&gt;');
  assert.ok(capBody('y'.repeat(100_000)).length <= 60_000);
  assert.equal(capBody('small'), 'small');
});

test('checksDetail treats "skipped" like "ok"', () => {
  const body = JSON.stringify({ status: 'degraded', checks: { database: 'ok', celery: 'skipped', redis: { status: 'skipped' }, mail: 'error' } });
  const r = classify(health, { status: 200, body });
  assert.equal(r.state, 'degraded');
  assert.equal(r.error, 'mail: error');
  const none = classify(health, { status: 200, body: JSON.stringify({ status: 'degraded', checks: { a: 'skipped' } }) });
  assert.equal(none.error, 'reported status "degraded"');
});

test('checkMonitor reports the real number of attempts', async () => {
  const noSleep = async () => {};
  const allDown = await checkMonitor(ping, { probeFn: async () => ({ error: 'boom', ms: 1 }), sleepFn: noSleep });
  assert.equal(allDown.state, 'down');
  assert.equal(allDown.attempts, 3);

  const seq = [{ error: 'boom', ms: 1 }, { status: 200, body: 'PONG', ms: 2 }];
  let i = 0;
  const recovered = await checkMonitor(ping, { probeFn: async () => seq[i++], sleepFn: noSleep });
  assert.equal(recovered.attempts, 2);

  const first = await checkMonitor(ping, { probeFn: async () => ({ status: 200, body: 'PONG', ms: 1 }), sleepFn: noSleep });
  assert.equal(first.attempts, 1);
});

test('flapping: reopen only when the incident closed less than 30 minutes ago', () => {
  const now = T('2026-10-12T10:00:00Z');
  assert.equal(shouldReopen('2026-10-12T09:45:00Z', now), true);
  assert.equal(shouldReopen('2026-10-12T09:30:01Z', now), true);
  assert.equal(shouldReopen('2026-10-12T09:30:00Z', now), false); // exactly 30 min: new incident
  assert.equal(shouldReopen('2026-10-12T08:00:00Z', now), false);
  assert.equal(shouldReopen('2026-10-12T10:05:00Z', now), false); // closed "in the future": ignore
  assert.equal(shouldReopen(undefined, now), false);
  assert.equal(shouldReopen('not a date', now), false);

  assert.equal(shouldWebhookOnReopen(undefined, undefined, now), true);
  assert.equal(shouldWebhookOnReopen('2026-10-12T09:40:00Z', 'alert', now), false); // repeated alert within 30 min
  assert.equal(shouldWebhookOnReopen('2026-10-12T09:29:00Z', 'alert', now), true);
});

test('alert, recovery, then reopen within 5 minutes still posts the alert', () => {
  const recoveredAt = T('2026-10-12T10:00:00Z');
  const reopenAt = recoveredAt + 5 * 60_000;
  assert.equal(shouldWebhookOnReopen('2026-10-12T10:00:00Z', 'recovery', reopenAt), true);
  // ...but a second alert right after an alert is throttled
  assert.equal(shouldWebhookOnReopen('2026-10-12T10:00:00Z', 'alert', reopenAt), false);
});

test('only incidents the monitor closed itself are reopened', () => {
  assert.equal(isBotClosure({ lastCommentBody: 'Recovered after 5 minutes. Website is now operational', closedByLogin: 'github-actions[bot]' }), true);
  assert.equal(isBotClosure({ lastCommentBody: 'Recovered after 5 minutes.', closedByLogin: undefined }), true);
  assert.equal(isBotClosure({ lastCommentBody: 'Recovered after 5 minutes.', closedByLogin: 'some-human' }), false);
  assert.equal(isBotClosure({ lastCommentBody: 'Closing, known issue', closedByLogin: 'github-actions[bot]' }), false);
  assert.equal(isBotClosure({ lastCommentBody: undefined, closedByLogin: undefined }), false);
});

test('comment backoff: 1h, then every 4h, then daily', () => {
  const opened = T('2026-10-12T00:00:00Z');
  const due = (lastIso, nowIso) => commentDue({ openedAtMs: opened, lastCommentMs: lastIso ? T(lastIso) : 0, nowMs: T(nowIso) });

  assert.equal(due('2026-10-12T00:00:30Z', '2026-10-12T00:59:00Z'), false); // under an hour
  assert.equal(due('2026-10-12T00:00:30Z', '2026-10-12T01:00:00Z'), true); // first comment at 1h
  assert.equal(due(null, '2026-10-12T01:00:00Z'), true);
  assert.equal(due('2026-10-12T01:00:00Z', '2026-10-12T04:59:00Z'), false); // 4h after the 1h comment
  assert.equal(due('2026-10-12T01:00:00Z', '2026-10-12T05:00:00Z'), true);
  assert.equal(due('2026-10-12T17:00:00Z', '2026-10-12T20:59:00Z'), false);
  assert.equal(due('2026-10-12T17:00:00Z', '2026-10-12T21:00:00Z'), true);
  // after 24h of the incident: daily
  assert.equal(due('2026-10-13T01:00:00Z', '2026-10-13T06:00:00Z'), false);
  assert.equal(due('2026-10-13T01:00:00Z', '2026-10-14T00:59:00Z'), false);
  assert.equal(due('2026-10-13T01:00:00Z', '2026-10-14T01:00:00Z'), true);
  // simulate the whole schedule over 3 days with a 5 minute cadence
  let last = 0;
  const comments = [];
  for (let t = opened; t <= opened + 72 * 3600_000; t += 5 * 60_000) {
    if (commentDue({ openedAtMs: opened, lastCommentMs: last, nowMs: t })) { comments.push((t - opened) / 3600_000); last = t; }
  }
  assert.deepEqual(comments, [1, 5, 9, 13, 17, 21, 45, 69]); // the daily cadence starts once the incident is 24h old
});
