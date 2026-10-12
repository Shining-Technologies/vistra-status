#!/usr/bin/env node
// Vistra uptime monitor. Zero dependencies (Node >= 24: global fetch, node:tls, node:fs).
//
//   node scripts/check.mjs             run all monitors, write data/ + docs/status.json
//   node scripts/check.mjs --dry-run   run all monitors, print the table, write nothing
//
// Env (all optional, set automatically inside GitHub Actions):
//   GITHUB_TOKEN, GITHUB_REPOSITORY   open/close incident issues (skipped when absent)
//   GITHUB_SERVER_URL, GITHUB_RUN_ID  link to the workflow run in the issue body
//   ALERT_WEBHOOK_URL                 Slack/Discord-compatible webhook, POSTed on open/recover
//   RETRY_DELAY_MS                    delay between anti-flap retries (default 10000)

import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TZ = 'Australia/Sydney';
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
export const HISTORY_DAYS = 90;
// A sample's state is assumed to persist until the next sample, but never longer than this.
// Beyond it the time is "no data" rather than silently counted as up or down.
export const MAX_GAP_MS = 3 * HOUR;
export const TLS_WARN_DAYS = 14;
export const COMMENT_EVERY_MS = HOUR;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_ERROR_CHARS = 300;
export const MAX_BODY_CHARS = 60_000;
export const REOPEN_WINDOW_MS = 30 * MIN;
export const WEBHOOK_MIN_GAP_MS = 30 * MIN;
// Budget for everything that talks to GitHub or the webhook, so the job stays well under its timeout.
export const GITHUB_BUDGET_MS = 150_000;
const RANK = { up: 2, degraded: 1, down: 0 };

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function normalizeMonitor(m) {
  if (!m || typeof m !== 'object') throw new Error('monitor must be an object');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(m.id ?? '')) throw new Error(`invalid monitor id: ${JSON.stringify(m.id)}`);
  if (!/^https?:\/\//.test(m.url ?? '')) throw new Error(`monitor ${m.id}: url must be http(s)`);
  return {
    id: m.id,
    name: m.name || m.id,
    group: m.group || null,
    url: m.url,
    expect: { status: [200], ...(m.expect || {}) },
    degradedJsonStatusIn: m.degradedJsonStatusIn || [],
    timeoutMs: m.timeoutMs || DEFAULT_TIMEOUT_MS,
  };
}

/** Cut remote-supplied text down so a hostile or broken response cannot flood issues or files. */
export function truncate(text, max = MAX_ERROR_CHARS) {
  const t = String(text);
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/** Render any remote value as text (strings keep their value, everything else is JSON). */
export function show(v) {
  return typeof v === 'string' ? v : JSON.stringify(v) ?? 'undefined';
}

function checksDetail(json) {
  const checks = json && typeof json.checks === 'object' && json.checks ? json.checks : {};
  const bad = Object.entries(checks)
    .filter(([, v]) => !['ok', 'skipped'].includes(v && typeof v === 'object' ? v.status : v))
    .map(([k, v]) => `${k}: ${show(v)}`);
  return bad.length ? truncate(bad.join(', ')) : undefined;
}

/** Turn a response ({status, body, error, ms}) into {state, error?}. */
export function classify(monitor, res) {
  const expect = monitor.expect || {};
  const down = (error) => ({ state: 'down', error: truncate(error) });
  if (res.error) return down(res.error);

  const body = res.body ?? '';
  const codes = expect.status || [200];
  if (!codes.includes(res.status)) {
    let extra = '';
    try {
      const j = JSON.parse(body);
      if (j && typeof j.status === 'string') extra = ` (status ${JSON.stringify(truncate(j.status, 40))})`;
    } catch { /* not JSON */ }
    return down(`HTTP ${res.status}, expected ${codes.join('/')}${extra}`);
  }
  if (expect.bodyIncludes && !body.includes(expect.bodyIncludes)) {
    return down(`response body is missing "${expect.bodyIncludes}"`);
  }
  if (expect.jsonStatusIn) {
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      return down('response is not valid JSON');
    }
    const st = json?.status;
    if (!expect.jsonStatusIn.includes(st)) {
      return down(`unexpected JSON status ${truncate(JSON.stringify(st) ?? 'undefined', 60)}`);
    }
    if ((monitor.degradedJsonStatusIn || []).includes(st)) {
      return { state: 'degraded', error: checksDetail(json) || truncate(`reported status ${JSON.stringify(st)}`) };
    }
  }
  return { state: 'up' };
}

export function formatDuration(ms) {
  const m = Math.floor(ms / MIN);
  if (m < 1) return 'less than a minute';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  const parts = [];
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (d) parts.push(plural(d, 'day'));
  if (h) parts.push(plural(h, 'hour'));
  if (mm && !d) parts.push(plural(mm, 'minute'));
  return parts.join(' ');
}

const dateKeyFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** YYYY-MM-DD of an instant, on the Australia/Sydney calendar. */
export function sydneyDateKey(ms) {
  const p = {};
  for (const { type, value } of dateKeyFmt.formatToParts(new Date(ms))) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** First instant (ms) of the Sydney calendar day containing `ms`. */
export function startOfSydneyDay(ms) {
  const key = sydneyDateKey(ms);
  let hi = Math.floor(ms / MIN); // key(hi) === key
  let lo = hi - 26 * 60; // days are at most 25h, so this is the previous day
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (sydneyDateKey(mid * MIN) === key) hi = mid;
    else lo = mid;
  }
  return hi * MIN;
}

/** The last `days` Sydney calendar days ending today, oldest first: [{date, start, end}]. */
export function dayWindows(nowMs, days = HISTORY_DAYS) {
  const out = [];
  let start = startOfSydneyDay(nowMs);
  let end = startOfSydneyDay(start + 25 * HOUR);
  for (let i = 0; i < days; i++) {
    out.unshift({ date: sydneyDateKey(start), start, end });
    end = start;
    start = startOfSydneyDay(start - MIN);
  }
  return out;
}

/** Time-weighted {up, total} ms inside [fromMs, toMs]; 'u' and 'g' count as up. */
export function weightedTime(samples, fromMs, toMs, nowMs = toMs, maxGapMs = MAX_GAP_MS) {
  let up = 0;
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = Date.parse(samples[i].t);
    const next = i + 1 < samples.length ? Date.parse(samples[i + 1].t) : nowMs;
    const end = Math.min(next, t + maxGapMs);
    const a = Math.max(t, fromMs);
    const b = Math.min(end, toMs);
    if (b <= a) continue;
    total += b - a;
    if (samples[i].s !== 'd') up += b - a;
  }
  return { up, total };
}

/** Uptime percent (0-100, 3 decimals) over the window, or null when there is no data. */
export function uptimePct(samples, fromMs, toMs, nowMs = toMs, maxGapMs = MAX_GAP_MS) {
  const { up, total } = weightedTime(samples, fromMs, toMs, nowMs, maxGapMs);
  if (total <= 0) return null;
  return Math.round((up / total) * 100_000) / 1000;
}

/** Per-day uptime for the last `days` Sydney days: [{date, up}] (up is null with no data). */
export function dailyBuckets(samples, nowMs, days = HISTORY_DAYS, maxGapMs = MAX_GAP_MS) {
  return dayWindows(nowMs, days).map(({ date, start, end }) => ({
    date,
    up: uptimePct(samples, start, Math.min(end, nowMs), nowMs, maxGapMs),
  }));
}

export function pruneHistory(history, nowMs, days = HISTORY_DAYS) {
  const cutoff = nowMs - days * DAY;
  return history.filter((s) => Date.parse(s.t) >= cutoff);
}

/** Append a sample; a sample closer than `minGapMs` to the last one replaces it. */
export function appendSample(history, sample, minGapMs = 2 * MIN) {
  const out = history.slice();
  const last = out[out.length - 1];
  if (last && Date.parse(sample.t) - Date.parse(last.t) < minGapMs) out[out.length - 1] = sample;
  else out.push(sample);
  return out;
}

export function stateToCode(state) {
  return state === 'up' ? 'u' : state === 'degraded' ? 'g' : 'd';
}

/**
 * Whether this run's files should be committed. Stable runs are committed about hourly;
 * state changes, incident activity and the very first run are always committed.
 */
export function shouldCommit({ prevGeneratedAt, stateChanged, issueActivity, nowMs }) {
  if (!prevGeneratedAt) return { commit: true, reason: 'no previous status.json' };
  if (stateChanged) return { commit: true, reason: 'state changed' };
  if (issueActivity) return { commit: true, reason: 'incident activity' };
  const age = nowMs - Date.parse(prevGeneratedAt);
  if (Number.isNaN(age)) return { commit: true, reason: 'unreadable previous timestamp' };
  if (new Date(nowMs).getUTCMinutes() < 5 && age >= 30 * MIN) return { commit: true, reason: 'hourly' };
  if (age >= 57 * MIN) return { commit: true, reason: 'hourly (overdue)' };
  return { commit: false, reason: 'no change' };
}

function fmtZone(ms, tz) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-AU', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(new Date(ms))) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/** "2026-10-12 03:04 UTC / 2026-10-12 14:04 AEDT (Sydney)" */
export function formatBothZones(ms) {
  return `${fmtZone(ms, 'UTC')} / ${fmtZone(ms, TZ)} (Sydney)`;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

function describeError(e) {
  const code = e?.cause?.code || e?.code;
  const msg = e?.cause?.message || e?.message || String(e);
  return code && !msg.includes(code) ? `${code}: ${msg}` : msg;
}

export async function probe(monitor, fetchImpl = fetch) {
  const ctl = new AbortController();
  const timeoutMs = monitor.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetchImpl(monitor.url, {
      method: 'GET',
      headers: { 'User-Agent': 'vistra-status-monitor' },
      cache: 'no-store',
      redirect: 'follow',
      signal: ctl.signal,
    });
    const body = await res.text();
    return { status: res.status, body, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    if (ctl.signal.aborted) return { error: `timeout after ${timeoutMs} ms`, ms };
    return { error: describeError(e), ms };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Probe with anti-flap retries: only a failing check is retried; the best attempt wins. */
export async function checkMonitor(monitor, { retries = 2, delayMs = 10_000, probeFn = probe, sleepFn = sleep } = {}) {
  let best = null;
  let made = 0;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const res = await probeFn(monitor);
    made = attempt;
    const verdict = classify(monitor, res);
    const r = { ...verdict, httpStatus: res.status ?? null, ms: res.ms ?? null };
    if (!best || RANK[r.state] > RANK[best.state]) best = r;
    if (r.state !== 'down') break;
    if (attempt <= retries) await sleepFn(delayMs);
  }
  return { ...best, attempts: made };
}

export function tlsDaysLeft(host, { port = 443, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let sock;
    let deadline;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      try { sock?.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    // Hard deadline: covers a stalled handshake that never fires 'error' or 'timeout'.
    deadline = setTimeout(() => finish(null), timeoutMs);
    try {
      sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
        const cert = sock.getPeerCertificate();
        const to = cert && cert.valid_to ? Date.parse(cert.valid_to) : NaN;
        finish(Number.isNaN(to) ? null : Math.floor((to - Date.now()) / DAY));
      });
      sock.on('error', () => finish(null));
      sock.on('timeout', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

// ---------------------------------------------------------------------------
// Pure incident-policy helpers (exported for tests)
// ---------------------------------------------------------------------------

/** A closed incident that closed less than REOPEN_WINDOW_MS ago is reopened instead of duplicated. */
export function shouldReopen(closedAtIso, nowMs) {
  const closed = Date.parse(closedAtIso);
  if (Number.isNaN(closed)) return false;
  const age = nowMs - closed;
  return age >= 0 && age < REOPEN_WINDOW_MS;
}

/**
 * On a reopen, always post the alert when the last webhook was a recovery (people were told it was fixed).
 * Only a repeated alert within 30 minutes is throttled.
 */
export function shouldWebhookOnReopen(lastWebhookAtIso, lastWebhookKind, nowMs) {
  if (lastWebhookKind === 'recovery') return true;
  const last = Date.parse(lastWebhookAtIso ?? '');
  return Number.isNaN(last) || nowMs - last > WEBHOOK_MIN_GAP_MS;
}

/** Only reopen what the monitor itself closed: its last comment is the "Recovered after" one and no human closed it. */
export function isBotClosure({ lastCommentBody, closedByLogin }) {
  if (closedByLogin && closedByLogin !== 'github-actions[bot]') return false;
  return typeof lastCommentBody === 'string' && lastCommentBody.startsWith('Recovered after');
}

/**
 * Comment backoff while an incident is ongoing, by time since it opened:
 * first comment after 1 hour, then every 4 hours, then once a day after the first 24 hours.
 * `lastCommentMs` is the latest known activity on the issue (0 or the open time when there is none).
 */
export function commentDue({ openedAtMs, lastCommentMs = 0, nowMs }) {
  const age = nowMs - openedAtMs;
  if (age < HOUR) return false;
  const last = Math.max(lastCommentMs, openedAtMs);
  if (last - openedAtMs < 2 * MIN) return true; // nothing since opening: this is the 1 hour comment
  const interval = age >= 24 * HOUR ? 24 * HOUR : 4 * HOUR;
  return nowMs - last >= interval;
}

/** Remote text goes in a fenced block so it cannot @mention anyone or inject markdown. */
export function fence(text) {
  return '```text\n' + String(text).replace(/`/g, "'") + '\n```';
}

/** Slack/Discord-safe: no HTML-ish control sequences such as <!channel> or <@id>. */
export function escapeWebhookText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function capBody(body, max = MAX_BODY_CHARS) {
  return body.length > max ? `${body.slice(0, max - 20)}\n...(truncated)` : body;
}

// ---------------------------------------------------------------------------
// GitHub issues + webhook
// ---------------------------------------------------------------------------

class GitHub {
  constructor({ token, repo, apiUrl, log, deadlineAt }) {
    this.token = token;
    this.repo = repo;
    this.base = apiUrl || 'https://api.github.com';
    this.log = log;
    this.deadlineAt = deadlineAt;
    this.labels = new Set();
  }

  async api(method, p, body) {
    const left = this.deadlineAt - Date.now();
    if (left <= 0) throw new Error('GitHub time budget exhausted');
    const res = await fetch(`${this.base}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'vistra-status-monitor',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(Math.min(20_000, left)),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    return { status: res.status, ok: res.ok, data };
  }

  // Only called when an issue is about to be created, and cached for the run. Best effort: it
  // just gives the labels a colour; GitHub would create missing labels on its own anyway.
  async ensureLabel(name, color, description) {
    if (this.labels.has(name)) return;
    const found = await this.api('GET', `/repos/${this.repo}/labels/${encodeURIComponent(name)}`);
    if (found.status === 404) {
      const made = await this.api('POST', `/repos/${this.repo}/labels`, { name, color, description });
      if (!made.ok && made.status !== 422) throw new Error(`create label ${name}: HTTP ${made.status}`);
    } else if (!found.ok) {
      throw new Error(`get label ${name}: HTTP ${found.status}`);
    }
    this.labels.add(name);
  }

  async findOpen(labels) {
    const q = encodeURIComponent(labels.join(','));
    const r = await this.api('GET', `/repos/${this.repo}/issues?state=open&labels=${q}&per_page=10`);
    if (!r.ok) throw new Error(`list issues: HTTP ${r.status}`);
    return (r.data || []).filter((i) => !i.pull_request)[0] || null;
  }

  /** Most recently closed issue with these labels, if it closed inside the reopen window. */
  async findRecentlyClosed(labels, nowMs) {
    const q = encodeURIComponent(labels.join(','));
    const r = await this.api('GET', `/repos/${this.repo}/issues?state=closed&labels=${q}&sort=updated&direction=desc&per_page=5`);
    if (!r.ok) throw new Error(`list closed issues: HTTP ${r.status}`);
    const candidates = (r.data || []).filter((i) => !i.pull_request && i.closed_at && shouldReopen(i.closed_at, nowMs));
    for (const issue of candidates) {
      const [single, comments] = await Promise.all([
        this.api('GET', `/repos/${this.repo}/issues/${issue.number}`),
        this.api('GET', `/repos/${this.repo}/issues/${issue.number}/comments?per_page=100`),
      ]);
      if (!single.ok || !comments.ok) continue;
      const last = (comments.data || []).at(-1);
      if (isBotClosure({ lastCommentBody: last?.body, closedByLogin: single.data?.closed_by?.login })) return issue;
    }
    return null;
  }

  async create(title, body, labels) {
    const r = await this.api('POST', `/repos/${this.repo}/issues`, { title, body: capBody(body), labels });
    if (!r.ok) throw new Error(`create issue: HTTP ${r.status}`);
    return r.data;
  }

  async comment(number, body) {
    const r = await this.api('POST', `/repos/${this.repo}/issues/${number}/comments`, { body: capBody(body) });
    if (!r.ok) throw new Error(`comment #${number}: HTTP ${r.status}`);
  }

  async reopen(number) {
    const r = await this.api('PATCH', `/repos/${this.repo}/issues/${number}`, { state: 'open', state_reason: 'reopened' });
    if (!r.ok) throw new Error(`reopen #${number}: HTTP ${r.status}`);
  }

  async close(number) {
    const r = await this.api('PATCH', `/repos/${this.repo}/issues/${number}`, { state: 'closed', state_reason: 'completed' });
    if (!r.ok) throw new Error(`close #${number}: HTTP ${r.status}`);
  }
}

const LABEL_META = {
  incident: ['B60205', 'Automated incident from the status monitor'],
  down: ['D93636', 'Service is down'],
  degraded: ['B5811C', 'Service is degraded'],
  tls: ['4B43C4', 'TLS certificate nearing expiry'],
};

async function ensureLabels(gh, names, log) {
  for (const name of names) {
    const [color, description] = LABEL_META[name] || ['6A7180', 'Monitored service'];
    try {
      await gh.ensureLabel(name, color, description);
    } catch (e) {
      log(`label ${name}: ${describeError(e)} (continuing)`);
    }
  }
}

async function postWebhook(url, text, log, deadlineAt) {
  if (!url) return;
  const left = deadlineAt - Date.now();
  if (left <= 0) { log('webhook skipped: time budget exhausted'); return; }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'vistra-status-monitor' },
      // Slack renders `text` with its own markup, so escape it; Discord shows `content` literally and
      // `allowed_mentions` already stops it pinging anyone, so that field stays raw.
      body: JSON.stringify({ text: escapeWebhookText(text), content: text, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(Math.min(10_000, left)),
    });
    if (!res.ok) log(`webhook returned HTTP ${res.status}`);
  } catch (e) {
    log(`webhook failed: ${describeError(e)}`);
  }
}

function hostLabel(host) {
  return `host:${host}`.slice(0, 50);
}

function incidentBody(entry, runAt, runUrl, attempts, heading) {
  const lines = [
    ...(heading ? [heading, ''] : []),
    `**Monitor:** ${entry.name} (\`${entry.id}\`)`,
    `**URL:** ${entry.url}`,
    `**Detected:** ${formatBothZones(runAt)}`,
    `**HTTP status:** ${entry.lastHttp ?? 'no response'}`,
    `**Response time:** ${entry.lastMs ?? 'n/a'} ms`,
    `**Attempts:** ${attempts}`,
    '**Error:**',
    fence(entry.lastError || 'n/a'),
  ];
  if (runUrl) lines.push(`**Workflow run:** ${runUrl}`);
  lines.push('', 'This issue is opened and closed automatically by the status monitor.');
  return lines.join('\n');
}

/**
 * Open/reopen/comment/close incident issues. Never throws; returns {activity}.
 * Mutates entry.lastCommentAt and entry.lastWebhookAt.
 */
async function processIncidents({ gh, results, entries, prevMap, tlsByHost, runAt, runUrl, webhookUrl, log }) {
  let activity = false;
  const nowIso = new Date(runAt).toISOString();
  let budgetLogged = false;
  const fail = (what, e) => {
    const msg = describeError(e);
    if (msg.includes('time budget exhausted')) {
      if (budgetLogged) return;
      budgetLogged = true;
    }
    log(`${what} failed: ${msg}`);
  };
  const notify = async (text, entry, kind) => {
    await postWebhook(webhookUrl, text, log, gh.deadlineAt);
    if (entry && webhookUrl) {
      entry.lastWebhookAt = nowIso;
      entry.lastWebhookKind = kind;
    }
  };

  for (const entry of entries) {
    const attempts = results.get(entry.id).attempts;
    const prev = prevMap.get(entry.id);
    for (const kind of ['down', 'degraded']) {
      try {
        const labels = ['incident', `monitor:${entry.id}`, kind];
        const open = await gh.findOpen(labels);
        if (entry.state === kind) {
          const emoji = kind === 'down' ? '🔴' : '🟠';
          const verb = kind === 'down' ? 'is down' : 'is degraded';
          const alert = `${emoji} ${entry.name} ${verb}: ${entry.url} (${entry.lastError || 'no detail'})`;
          if (!open) {
            const recent = await gh.findRecentlyClosed(labels, runAt);
            if (recent) {
              // Flapping: reopen the incident that just closed instead of starting a new one.
              await gh.reopen(recent.number);
              await gh.comment(recent.number, incidentBody(
                entry, runAt, runUrl, attempts,
                `${emoji} ${entry.name} ${verb} again, ${formatDuration(runAt - Date.parse(recent.closed_at))} after it recovered.`,
              ));
              entry.lastCommentAt = nowIso;
              activity = true;
              log(`reopened issue #${recent.number} for ${entry.id} (${kind})`);
              if (shouldWebhookOnReopen(entry.lastWebhookAt, entry.lastWebhookKind, runAt)) await notify(alert, entry, 'alert');
            } else {
              await ensureLabels(gh, labels, log);
              const issue = await gh.create(`${emoji} ${entry.name} ${verb}`, incidentBody(entry, runAt, runUrl, attempts), labels);
              entry.lastCommentAt = nowIso;
              activity = true;
              log(`opened issue #${issue.number} for ${entry.id} (${kind})`);
              await notify(alert, entry, 'alert');
            }
          } else {
            const openedAt = Math.max(Date.parse(open.created_at) || 0, Date.parse(entry.since) || 0);
            const lastMs = Math.max(Date.parse(entry.lastCommentAt) || 0, Date.parse(open.updated_at) || 0);
            if (commentDue({ openedAtMs: openedAt, lastCommentMs: lastMs, nowMs: runAt })) {
              await gh.comment(open.number, [
                `Still ${kind} as of ${formatBothZones(runAt)} (for ${formatDuration(runAt - openedAt)}).`,
                '',
                `HTTP status: ${entry.lastHttp ?? 'no response'}, response time: ${entry.lastMs ?? 'n/a'} ms`,
                'Error:',
                fence(entry.lastError || 'n/a'),
                runUrl ? `Workflow run: ${runUrl}` : '',
              ].filter((l) => l !== '').join('\n'));
              entry.lastCommentAt = nowIso;
              activity = true;
              log(`commented on #${open.number} for ${entry.id}`);
            } else if (!entry.lastCommentAt && lastMs) {
              entry.lastCommentAt = new Date(lastMs).toISOString();
            }
          }
        } else if (open) {
          const prevSince = prev && prev.state === kind ? Date.parse(prev.since) || 0 : 0;
          const dur = formatDuration(runAt - Math.max(Date.parse(open.created_at) || 0, prevSince));
          const now = entry.state === 'up' ? 'operational' : entry.state;
          await gh.comment(open.number, `Recovered after ${dur}. ${entry.name} is now ${now} (${formatBothZones(runAt)}).`);
          await gh.close(open.number);
          activity = true;
          log(`closed issue #${open.number} for ${entry.id} (${kind} -> ${entry.state})`);
          await notify(`✅ ${entry.name} recovered after ${dur} (now ${now}): ${entry.url}`, entry, 'recovery');
        }
      } catch (e) {
        fail(`incident handling for ${entry.id}/${kind}`, e);
      }
    }
  }

  for (const [host, days] of Object.entries(tlsByHost)) {
    if (days == null) continue;
    try {
      const labels = ['incident', 'tls', hostLabel(host)];
      const open = await gh.findOpen(labels);
      if (days < TLS_WARN_DAYS && !open) {
        await ensureLabels(gh, labels, log);
        const title = days > 0
          ? `🔒 TLS certificate for ${host} expires in ${days} day${days === 1 ? '' : 's'}`
          : `🔒 TLS certificate for ${host} has expired`;
        const issue = await gh.create(title, [
          `**Host:** ${host}`,
          `**Days left:** ${days}`,
          `**Detected:** ${formatBothZones(runAt)}`,
          ...(runUrl ? [`**Workflow run:** ${runUrl}`] : []),
          '',
          'Certificates normally renew automatically. If this one has not, check the host\'s TLS/proxy configuration.',
          'This issue closes automatically once the certificate is renewed.',
        ].join('\n'), labels);
        activity = true;
        log(`opened issue #${issue.number} for TLS ${host}`);
        await notify(title);
      } else if (days > TLS_WARN_DAYS && open) {
        await gh.comment(open.number, `Certificate renewed: ${days} days left (${formatBothZones(runAt)}).`);
        await gh.close(open.number);
        activity = true;
        log(`closed TLS issue #${open.number} for ${host}`);
        await notify(`✅ TLS certificate for ${host} renewed (${days} days left)`);
      }
    } catch (e) {
      fail(`TLS incident handling for ${host}`, e);
    }
  }
  return { activity };
}

/** Local run (no token): describe what would have happened, from state transitions only. */
function logWouldDo({ entries, prevMap, tlsByHost, log }) {
  for (const e of entries) {
    const prev = prevMap.get(e.id)?.state;
    if (prev === e.state) continue;
    if (e.state === 'down' || e.state === 'degraded') {
      log(`[would] open ${e.state} issue for ${e.id}: "${e.state === 'down' ? '🔴' : '🟠'} ${e.name} ${e.state === 'down' ? 'is down' : 'is degraded'}" + webhook`);
    }
    if (prev === 'down' || prev === 'degraded') {
      log(`[would] close ${prev} issue for ${e.id} (now ${e.state}) + webhook`);
    }
  }
  for (const [host, days] of Object.entries(tlsByHost)) {
    if (days != null && days < TLS_WARN_DAYS) log(`[would] open tls issue for ${host} (${days} days left)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Keep each daily bucket on one line so status.json stays small and diffs stay readable.
  const text = JSON.stringify(data, null, 2).replace(
    /\{\s*"date": ("[\d-]+"),\s*"up": ([\d.]+|null)\s*\}/g,
    '{ "date": $1, "up": $2 }',
  );
  fs.writeFileSync(file, text + '\n');
}

// One sample per line keeps the git diff of an append tiny.
function writeHistory(file, samples) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = samples.length ? `[\n${samples.map((s) => JSON.stringify(s)).join(',\n')}\n]\n` : '[]\n';
  fs.writeFileSync(file, body);
}

function pad(v, n) {
  return String(v).padEnd(n);
}

function printTable(entries) {
  const pct = (v) => (v == null ? '-' : `${v.toFixed(2)}%`);
  const rows = entries.map((e) => [
    e.id, e.state.toUpperCase(), e.lastHttp ?? '-', `${e.lastMs ?? '-'} ms`,
    e.tlsDaysLeft == null ? '-' : `${e.tlsDaysLeft}d`, pct(e.uptime24h), pct(e.uptime7d), pct(e.uptime90d), e.lastError || '',
  ]);
  const head = ['MONITOR', 'STATE', 'HTTP', 'TIME', 'TLS', '24H', '7D', '90D', 'ERROR'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => pad(c, widths[i])).join('  ').trimEnd();
  console.log(line(head));
  for (const r of rows) console.log(line(r));
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const dry = argv.includes('--dry-run');
  const log = (m) => console.log(`[status] ${m}`);
  const dataDir = path.join(ROOT, 'data');
  const statusFile = path.join(dataDir, 'status.json');
  const publicFile = path.join(ROOT, 'docs', 'status.json');
  const commitFlag = path.join(dataDir, '.commit');

  const monitors = readJson(path.join(ROOT, 'monitors.json'), null);
  if (!Array.isArray(monitors)) throw new Error('monitors.json must be a JSON array');
  const defs = monitors.map(normalizeMonitor);
  if (new Set(defs.map((m) => m.id)).size !== defs.length) throw new Error('duplicate monitor id in monitors.json');

  const prev = readJson(statusFile, null);
  const prevMap = new Map((prev?.monitors || []).map((m) => [m.id, m]));
  const runAt = Date.now();
  const runIso = new Date(runAt).toISOString();
  const retryDelay = Number(env.RETRY_DELAY_MS ?? 10_000);
  // The sample taken now represents (at least) the next run interval, so a brand-new
  // history already yields a percentage instead of 0 ms of data.
  const evalAt = runAt + 5 * MIN;

  // Probe all monitors and all TLS hosts concurrently.
  const hosts = [...new Set(defs.filter((m) => m.url.startsWith('https:')).map((m) => new URL(m.url).hostname))];
  const [verdicts, tlsList] = await Promise.all([
    Promise.all(defs.map((m) => checkMonitor(m, { delayMs: retryDelay }))),
    Promise.all(hosts.map((h) => tlsDaysLeft(h))),
  ]);
  const tlsByHost = Object.fromEntries(hosts.map((h, i) => [h, tlsList[i]]));
  const results = new Map(defs.map((m, i) => [m.id, verdicts[i]]));

  let stateChanged = prevMap.size !== defs.length;
  const entries = defs.map((m) => {
    const v = results.get(m.id);
    const p = prevMap.get(m.id);
    const changed = !p || p.state !== v.state;
    if (changed) stateChanged = true;

    const histFile = path.join(dataDir, 'history', `${m.id}.json`);
    let hist = readJson(histFile, []);
    if (!Array.isArray(hist)) hist = [];
    hist = pruneHistory(appendSample(hist, { t: runIso, s: stateToCode(v.state), ms: v.ms ?? 0 }), runAt);
    if (!dry) writeHistory(histFile, hist);

    const host = m.url.startsWith('https:') ? new URL(m.url).hostname : null;
    const entry = {
      id: m.id,
      name: m.name,
      ...(m.group ? { group: m.group } : {}),
      url: m.url,
      state: v.state,
      since: changed ? runIso : p.since,
      lastCheck: runIso,
      lastMs: v.ms,
      lastHttp: v.httpStatus,
      ...(v.error ? { lastError: v.error } : {}),
      tlsDaysLeft: host ? tlsByHost[host] : null,
      uptime24h: uptimePct(hist, evalAt - DAY, evalAt),
      uptime7d: uptimePct(hist, evalAt - 7 * DAY, evalAt),
      uptime90d: uptimePct(hist, evalAt - HISTORY_DAYS * DAY, evalAt),
      daily: dailyBuckets(hist, evalAt),
    };
    if (!changed && p.lastCommentAt && v.state !== 'up') entry.lastCommentAt = p.lastCommentAt;
    if (p?.lastWebhookAt) entry.lastWebhookAt = p.lastWebhookAt;
    if (p?.lastWebhookKind) entry.lastWebhookKind = p.lastWebhookKind;
    return entry;
  });

  // Incidents + alerts
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  let issueActivity = false;
  if (token && repo && !dry) {
    const runUrl = env.GITHUB_RUN_ID && env.GITHUB_SERVER_URL
      ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : '';
    const gh = new GitHub({ token, repo, apiUrl: env.GITHUB_API_URL, log, deadlineAt: Date.now() + GITHUB_BUDGET_MS });
    ({ activity: issueActivity } = await processIncidents({
      gh, results, entries, prevMap, tlsByHost, runAt, runUrl, webhookUrl: env.ALERT_WEBHOOK_URL, log,
    }));
  } else {
    log('no GITHUB_TOKEN/GITHUB_REPOSITORY, or dry run: skipping issues and webhook');
    logWouldDo({ entries, prevMap, tlsByHost, log });
  }

  const status = {
    generatedAt: new Date().toISOString(),
    repo: repo || prev?.repo || null,
    monitors: entries,
  };

  const decision = shouldCommit({ prevGeneratedAt: prev?.generatedAt, stateChanged, issueActivity, nowMs: runAt });

  printTable(entries);
  log(`commit: ${decision.commit ? 'yes' : 'no'} (${decision.reason})`);

  if (dry) {
    log('dry run: no files written');
  } else {
    writeJson(statusFile, status);
    writeJson(publicFile, status);
    if (decision.commit) fs.writeFileSync(commitFlag, `${decision.reason}\n`);
    else fs.rmSync(commitFlag, { force: true });
  }
  return { status, decision };
}

// Skip when imported (tests) or when node --test happens to execute this file directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && !process.env.NODE_TEST_CONTEXT) {
  main().catch((e) => {
    // Alerting is via issues, so a crash must not turn the workflow red every 5 minutes.
    console.error(`::error::status check crashed: ${e?.stack || e}`);
  }).finally(() => {
    process.exitCode = 0;
  });
}
