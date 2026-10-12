# Vistra status

A small, dependency-free uptime monitor and public status page for [Vistra](https://www.vistra.report/).

- **Monitor:** a Node 24 script (`scripts/check.mjs`, no npm packages) run every 5 minutes by GitHub Actions.
- **Status page:** a single static file (`docs/index.html`) served by GitHub Pages at `https://status.vistra.report`.
- **Alerts:** GitHub issues, opened and closed automatically, with an optional Slack/Discord webhook.
- **Storage:** plain JSON committed to this repo (`data/`). No database, no servers, no secrets.

This repo is public on purpose: Actions minutes are free and unlimited, and it only ever contains public URLs.

## What is monitored

Defined in [`monitors.json`](monitors.json):

| id | Name | URL | Healthy means |
|----|------|-----|---------------|
| `api-ping` | API | `https://api.vistra.report/ping/` | HTTP 200 and body contains `PONG` |
| `api-health` | API health checks | `https://api.vistra.report/health/` | HTTP 200 with JSON `status` of `ok` (up) or `degraded` (degraded) |
| `website` | Website | `https://www.vistra.report/` | HTTP 200 |
| `portal` | Web app | `https://app.vistra.report/` | HTTP 200 |

A monitor is **down** on timeout, network error, wrong HTTP status, missing body text or an unexpected JSON status
(a `503` with `"unhealthy"` from `/health/` is down). Before declaring down, a failing check is retried twice, 10 seconds apart,
and the best of the three attempts wins, so a single dropped request does not flap. TLS certificate expiry is checked for every
HTTPS hostname.

## How alerts work

For each monitor the workflow keeps at most one open issue per kind, labelled `incident`, `monitor:<id>` and `down` or `degraded`:

- Goes down or degraded: an issue is opened ("🔴 Website is down" / "🟠 API health checks is degraded") with the URL, time
  in UTC and Australia/Sydney, HTTP code, error, response time and a link to the workflow run.
- Still down: a comment after the first hour, then every 4 hours, then once a day (measured from when the incident opened).
- Flapping: if a monitor goes down or degraded again within 30 minutes of its incident closing, that issue is **reopened** with a
  comment instead of opening a new one. Only issues the monitor closed itself are reopened (the last comment is its "Recovered after"
  comment and no person closed it); an issue a human closed is left alone and a new one is opened. The webhook always posts the alert
  after a recovery notice, and only throttles a repeated alert within 30 minutes.
- Recovers: a "Recovered after ..." comment and the issue is closed.
- TLS certificate under 14 days: one `tls` issue per host ("🔒 TLS certificate for host expires in N days"), closed once renewed.

GitHub notifies people who are watching the repo about new issues, so to get alerted:

1. **Watch** the repo, choose *Custom* and tick **Issues**.
2. Install the **GitHub mobile app** and enable push notifications for a push on your phone.

Optional chat alerts: add a repository secret `ALERT_WEBHOOK_URL` (Settings, Secrets and variables, Actions) holding a Slack or
Discord webhook URL. On every incident open and recover the script POSTs `{"text": "...", "content": "..."}` (both fields, so
the same payload works for Slack and Discord). Webhook failures never fail the run.

Text that comes from the monitored service (error messages, health-check details) is truncated to 300 characters and shown in
a code block, so it cannot @mention anyone; webhook payloads set `allowed_mentions: {parse: []}` and escape `<`, `>` and `&`.
All GitHub and webhook calls share a 150 second budget so a slow API cannot stall the job.

The script always exits 0, and a push that cannot be completed (a conflict, or a second rejected push) is logged and that
sample is dropped, so the workflow does not go red every 5 minutes. Only genuine infrastructure failures (checkout, setup-node)
can turn it red. Alerting is entirely through issues and the webhook.

## How data is stored (and its granularity)

Every run starts from the last **committed** state, so a sample that is not committed is lost. To avoid 288 commits a day,
a run commits only when:

- any monitor changed state, or an incident issue was opened, commented or closed, or
- it is the hourly checkpoint (UTC minute under 5, or the last commit is more than 57 minutes old), or
- `data/status.json` does not exist yet.

`check.mjs` signals this by writing the git-ignored flag file `data/.commit`; the workflow commits `data/` and
`docs/status.json` as `github-actions[bot]` with the message `status: update` (one `git pull --rebase -X theirs` retry if the push is rejected; on a conflict the sample is dropped).
The commit deliberately has no `[skip ci]`, so the GitHub Pages build still runs for it.
The job checks out `main` explicitly, so a run that was queued for a while still starts from the branch tip.

Consequences, worth knowing:

- History (`data/history/<id>.json`) has **roughly hourly granularity plus every state change**, kept for 90 days.
- Uptime percentages are weighted by the time between samples (a sample's state holds until the next sample; a gap longer
  than 3 hours counts as "no data"). Degraded counts as up.
- A short outage is always captured (the down transition and the recovery are both committed), but the
  "last checked" time on the page can be up to an hour old while everything is stable.
- Daily bars use the Australia/Sydney calendar day: green at 99.5% or above, amber at 95% or above, red below, grey with no data.

`data/status.json` is the state file; `docs/status.json` is an identical copy because GitHub Pages only serves `docs/`.
The page fetches the copy with a cache-busting query string and refreshes every 60 seconds.

## Setup (once)

1. Create the **public** repo `Shining-Technologies/vistra-status` and push this directory to `main`.
2. Settings, Pages: **Deploy from a branch**, branch `main`, folder `/docs`. Set the custom domain to `status.vistra.report`
   (the `docs/CNAME` file already contains it) and tick **Enforce HTTPS** once the certificate is issued.
3. DNS: add a `CNAME` record `status` pointing to `shining-technologies.github.io`.
4. Actions tab: enable workflows. Run **check** once with *Run workflow* to confirm it, then it runs on its own every 5 minutes.
5. Watch the repo (see above) and, optionally, add the `ALERT_WEBHOOK_URL` secret.

Notes:

- GitHub's cron can be delayed by several minutes under load, so "every 5 minutes" is best effort.
- Scheduled workflows in public repos are disabled after 60 days without repo activity. The hourly data commits count as
  activity, so the monitor keeps itself alive.

## Adding a monitor

Append an entry to `monitors.json` and push:

```json
{
  "id": "docs",
  "name": "Help centre",
  "url": "https://help.vistra.report/",
  "expect": { "status": [200], "bodyIncludes": "Vistra" },
  "timeoutMs": 15000
}
```

- `id`: lowercase slug, unique; used for the history file and the `monitor:<id>` label.
- `expect.status`: accepted HTTP codes. `expect.bodyIncludes`: text that must appear. `expect.jsonStatusIn`: accepted values of the JSON `status` field.
- `degradedJsonStatusIn`: which of those JSON statuses mean "degraded" rather than "up".
- `group` (optional): monitors sharing a group are shown in one card on the page.
- `timeoutMs` defaults to 15000.

Only public URLs belong here; this repo is public.

## Running locally

```bash
node scripts/check.mjs              # real run: writes data/ and docs/status.json
node scripts/check.mjs --dry-run    # print the table, write nothing
node --test scripts/check.test.mjs  # unit tests for the pure functions
npx --yes serve docs                # or: python3 -m http.server -d docs  (preview the page)
```

Without `GITHUB_TOKEN` and `GITHUB_REPOSITORY` no issues or webhooks are touched; the script logs what it would have done.
Set `GITHUB_REPOSITORY=owner/repo` to have the page show the "Incident history" link. `RETRY_DELAY_MS` shortens the retry delay for testing.
(Use Node 24. On Node 22 and later `node --test scripts/` is read as a glob rather than a directory, so pass the test file explicitly as above.)

## Layout

```
monitors.json                 what to check
scripts/check.mjs             the monitor (and its exported pure functions)
scripts/check.test.mjs        node:test unit tests
.github/workflows/check.yml   5-minute schedule, commits data
data/status.json              current state (committed)
data/history/<id>.json        90-day sample history (committed)
docs/index.html               the status page
docs/status.json              copy of data/status.json for Pages
docs/CNAME, docs/.nojekyll    custom domain, disable Jekyll
```
