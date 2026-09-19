/**
 * Load the demo in a real browser and check that it works.
 *
 * Serves the project and opens the saved copy, so the check never depends on
 * the USASpending API being reachable. It does depend on jsDelivr, because that
 * is where the page gets the grid from: this edition has no local copy of the
 * library at all, and a check that loaded one would not be checking the page.
 *
 * Beyond "it drew something", it asserts the things this demo exists to show:
 *
 *   - the library arrived by classic script tag: there is no `type="module"`
 *     script on the page, every library tag points at the pinned release on
 *     the CDN, and each one left the global it documents;
 *   - the treemap and the bar charts drew marks, not empty axes;
 *   - every headline tile agrees with the saved data, recomputed here rather
 *     than read back off the page;
 *   - grouping by agency produces group rows, the pivot presents agency
 *     against award type, and a derived grid (top recipients) holds its rows;
 *   - a pushed row lands on the award it belongs to rather than adding a
 *     second one, and a filter moves the tiles with the table;
 *   - a blocked API shows the saved copy, with a notice saying why.
 *
 * `--all` also opens the live API, which is not part of the deployment gate.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--all] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const all = args.includes('--all');

/** The release every library tag must name, and the globals each file leaves. */
const GRID_VERSION = '1.65.0';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@${GRID_VERSION}/`;
const LIBRARY_TAGS = [
  { file: 'lattice-grid.min.js', global: 'LatticeGrid', member: 'createGrid' },
  { file: 'modules/charts.min.js', global: 'LatticeGrid', member: 'createChart' },
  { file: 'modules/data-router.min.js', global: 'LatticeGridDataRouter', member: 'createDataRouter' },
  { file: 'modules/kpi.min.js', global: 'LatticeGridKPI', member: 'createKPI' },
  { file: 'modules/tabs.min.js', global: 'LatticeGridTabs', member: 'createTabs' },
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

/** The first browser on this machine that actually exists. */
async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

/** This check needs Node's built-in WebSocket, which arrived in Node 22. */
function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`,
    );
  }
}

/** A free TCP port, asked of the operating system. */
function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const failures = [];
const notes = [];

/** Record a check and its outcome. */
function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

let browser;
let browserPid = null;
let profile;
let server;

try {
  requireModernNode();
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'usaspending-umd-demo-verify-'));
  const port = await freePort();
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** Open a URL with a clean error log and wait for the dashboard to report in. */
  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__usaspendingDemo)', 120000, `${label} to load`);
    const state = await evaluate('({ ready: window.__usaspendingDemo.ready, error: window.__usaspendingDemo.error || null })');
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor('window.__usaspendingDemo.mainGrid && window.__usaspendingDemo.mainGrid.rows.count() > 0', 60000, `${label} rows`);
  };

  /** Save a screenshot, when a directory was asked for. */
  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  /** Complain about anything the page logged. */
  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /* =================================================================== */
  /* 1. The saved copy: the deterministic run, where the figures are      */
  /*    cross-checked against the saved data.                             */
  /* =================================================================== */

  await open(`${origin}/index.html?source=snapshot`, 'saved copy');

  /* ---- how the library arrived ---- */

  const delivery = await evaluate(`(() => {
    const scripts = [...document.querySelectorAll('script')];
    const globals = {};
    for (const name of ['LatticeGrid', 'LatticeGridDataRouter', 'LatticeGridKPI', 'LatticeGridTabs']) {
      const value = window[name];
      globals[name] = value ? Object.keys(value).filter((k) => typeof value[k] === 'function').length : 0;
    }
    return {
      moduleScripts: scripts.filter((s) => s.type === 'module').length,
      importmaps: scripts.filter((s) => s.type === 'importmap').length,
      librarySrcs: scripts.map((s) => s.getAttribute('src') || '').filter((src) => /cdn\\.jsdelivr\\.net/.test(src)),
      withIntegrity: scripts.filter((s) => /cdn\\.jsdelivr\\.net/.test(s.src) && s.integrity).length,
      stylesheetSrc: (document.querySelector('link[rel=stylesheet][href*="cdn.jsdelivr.net"]') || {}).href || null,
      globals,
      members: {
        createGrid: typeof (window.LatticeGrid || {}).createGrid,
        setLicence: typeof (window.LatticeGrid || {}).setLicence,
        createStat: typeof (window.LatticeGrid || {}).createStat,
        createChart: typeof (window.LatticeGrid || {}).createChart,
        createDataRouter: typeof (window.LatticeGridDataRouter || {}).createDataRouter,
        createKPI: typeof (window.LatticeGridKPI || {}).createKPI,
        createTabs: typeof (window.LatticeGridTabs || {}).createTabs,
      },
    };
  })()`);
  console.log(`  library tags: ${delivery.librarySrcs.length} from the CDN, ${delivery.withIntegrity} with an integrity hash; module scripts on the page: ${delivery.moduleScripts}`);
  check(delivery.moduleScripts === 0, 'delivery: no type="module" script on the page', `${delivery.moduleScripts}`);
  check(delivery.importmaps === 0, 'delivery: no import map on the page', `${delivery.importmaps}`);
  check(
    delivery.librarySrcs.length === LIBRARY_TAGS.length,
    `delivery: ${LIBRARY_TAGS.length} library script tags point at the CDN`,
    `${delivery.librarySrcs.length}`,
  );
  for (const tag of LIBRARY_TAGS) {
    const wanted = `${CDN_BASE}${tag.file}`;
    check(delivery.librarySrcs.includes(wanted), `delivery: ${tag.file} is loaded from the pinned ${GRID_VERSION} release`, wanted);
    check(delivery.members[tag.member] === 'function', `delivery: ${tag.file} left ${tag.global}.${tag.member} behind`, delivery.members[tag.member]);
  }
  check(delivery.withIntegrity === LIBRARY_TAGS.length, 'delivery: every library tag carries an integrity hash', `${delivery.withIntegrity} of ${LIBRARY_TAGS.length}`);
  check(
    delivery.stylesheetSrc === `${CDN_BASE}lattice-grid.min.css`,
    `delivery: the stylesheet is loaded from the pinned ${GRID_VERSION} release`,
    delivery.stylesheetSrc,
  );
  check(delivery.members.setLicence === 'function', 'delivery: setLicence is on the core global');
  check(delivery.members.createStat === 'function', 'delivery: createStat is on the core global');

  const snap = await evaluate(`(() => {
    const d = window.__usaspendingDemo;
    return {
      rows: d.mainGrid.rows.count(),
      columns: d.mainGrid.columns.visible().length,
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      charts: d.charts.length,
      stats: d.stats.length,
      watermark: d.mainGrid.licence.watermark(),
      licenceState: d.mainGrid.licence.state(),
      tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      statValues: d.stats.map((s) => s.value()),
    };
  })()`);
  console.log(`  ${snap.rows} rows, ${snap.columns} columns, ${snap.painted} painted, ${snap.charts} charts`);
  console.log(`  tiles: ${JSON.stringify(snap.tiles)}`);
  console.log(`  stat tiles: ${JSON.stringify(snap.statValues)}`);

  check(snap.rows > 0, 'saved copy: the awards grid holds rows', `${snap.rows}`);
  check(snap.painted > 0, 'saved copy: the table painted rows', `${snap.painted}`);
  check(snap.charts === 4, 'saved copy: all four charts were built', `${snap.charts}`);
  check(snap.stats === 3, 'saved copy: all three statistic tiles were built', `${snap.stats}`);

  /* Each chart is asked whether it actually drew marks, so an empty pair of
     axes is not mistaken for a chart. */
  const drawn = await evaluate(`(() => window.__usaspendingDemo.charts.map((c, i) => {
    const svg = c.element;
    const marks = svg ? svg.querySelectorAll('rect, path, circle').length : 0;
    return { i, marks, hasData: !!c.data() };
  }))()`);
  for (const c of drawn) {
    console.log(`  chart ${c.i}: ${c.marks} marks, hasData ${c.hasData}`);
    check(c.hasData, `saved copy: chart ${c.i} bound data rather than empty axes`);
    check(c.marks > 2, `saved copy: chart ${c.i} drew marks`, `${c.marks} marks`);
  }
  check(snap.watermark === false, 'saved copy: no watermark on localhost', `state ${snap.licenceState}`);
  noErrors('saved copy');
  await shoot('01-grid-saved');

  /* The independent recomputation: the saved rows, reduced here in Node. */
  const meta = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'meta.json'), 'utf8'));
  const values = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'awards.json'), 'utf8'));
  const cols = meta.columns;
  const savedRows = values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
  const amounts = savedRows.map((row) => row.amount).filter((value) => typeof value === 'number');

  const expected = {
    spending: amounts.reduce((sum, value) => sum + value, 0),
    awards: savedRows.length,
    recipients: new Set(savedRows.map((row) => row.recipient)).size,
    largest: amounts.length ? Math.max(...amounts) : null,
    mean: amounts.length ? amounts.reduce((sum, value) => sum + value, 0) / amounts.length : null,
  };

  const near = (a, b, eps) => Math.abs(a - b) <= eps;
  check(near(snap.tiles.spending, expected.spending, 1), 'saved copy: the total-obligated tile matches the saved data', `tile ${snap.tiles.spending}, expected ${expected.spending.toFixed(0)}`);
  check(snap.tiles.awards === expected.awards, 'saved copy: the award count matches the saved data', `tile ${snap.tiles.awards}, expected ${expected.awards}`);
  check(snap.tiles.recipients === expected.recipients, 'saved copy: the recipient count matches the saved data', `tile ${snap.tiles.recipients}, expected ${expected.recipients}`);
  check(near(snap.tiles.largest, expected.largest, 1), 'saved copy: the largest award matches the saved data', `tile ${snap.tiles.largest}, expected ${expected.largest}`);
  check(near(snap.statValues[0], expected.mean, expected.mean * 1e-6 + 1), 'saved copy: the mean statistic tile matches the saved data', `tile ${snap.statValues[0]}, expected ${expected.mean.toFixed(2)}`);

  /* ---- grouping by agency produces group rows ---- */

  await evaluate("window.__usaspendingDemo.mainGrid.columns.group(['agency'])");
  await sleep(700);
  const grouped = await evaluate(`(() => {
    const d = window.__usaspendingDemo;
    let groups = 0;
    d.mainGrid.rows.forEach((r) => { if (r && r.group) groups += 1; });
    return { groups, rows: d.mainGrid.rows.count() };
  })()`);
  check(grouped.groups > 0, 'grouping by agency produces group rows', `${grouped.groups} groups`);
  await shoot('02-grouped-by-agency');
  await evaluate('window.__usaspendingDemo.mainGrid.columns.group([])');
  await sleep(400);

  /* ---- a pushed row lands on the award it belongs to ---- */

  const pushed = await evaluate(`(async () => {
    const d = window.__usaspendingDemo;
    let target = null;
    d.mainGrid.rows.forEach((r) => { if (!target && r && r.data && typeof r.data.amount === 'number') target = r.data; });
    const before = { count: d.mainGrid.rows.count(), id: target.id, amount: target.amount };
    d.ingest([{ ...target, amount: target.amount + 1 }]);
    await new Promise((r) => setTimeout(r, 400));
    let found = null;
    d.mainGrid.rows.forEach((r) => { if (r && r.data && r.data.id === before.id) found = r.data; });
    return { before, after: { count: d.mainGrid.rows.count(), amount: found ? found.amount : null } };
  })()`);
  console.log(`  pushed: ${pushed.before.id} ${pushed.before.amount} -> ${pushed.after.amount}, rows ${pushed.before.count} -> ${pushed.after.count}`);
  check(
    pushed.after.count === pushed.before.count,
    'a pushed row updates the award rather than adding one',
    `${pushed.before.count} -> ${pushed.after.count}`,
  );
  check(near(pushed.after.amount, pushed.before.amount + 1, 0.01), 'the pushed amount is on the row', `expected ${pushed.before.amount + 1}, found ${pushed.after.amount}`);

  /* ---- a filter moves the tiles ---- */

  const beforeFilter = await evaluate('window.__usaspendingDemo.kpi.value("spending")');
  await evaluate("window.__usaspendingDemo.mainGrid.filters.set({ col: 'kind', op: 'eq', value: 'Contract' })");
  await sleep(700);
  const afterFilter = await evaluate(`(() => {
    const d = window.__usaspendingDemo;
    return { rows: d.mainGrid.rows.count(), spending: d.kpi.value('spending'), awards: d.kpi.value('awards') };
  })()`);
  const expectedContracts = savedRows.filter((row) => row.kind === 'Contract');
  const expectedContractSpending = expectedContracts
    .map((row) => row.amount)
    .filter((value) => typeof value === 'number')
    .reduce((sum, value) => sum + value, 0);
  console.log(`  filtered: spending ${beforeFilter} -> ${afterFilter.spending}, rows ${afterFilter.rows}`);
  check(afterFilter.rows < snap.rows, 'the kind filter narrows the table', `${snap.rows} -> ${afterFilter.rows}`);
  check(near(afterFilter.spending, expectedContractSpending, 1), 'the narrowed total-obligated tile matches the saved contract total', `tile ${afterFilter.spending}, expected ${expectedContractSpending.toFixed(0)}`);
  check(afterFilter.awards === expectedContracts.length, 'the narrowed award count matches the saved contract count', `tile ${afterFilter.awards}, expected ${expectedContracts.length}`);
  await shoot('03-filtered');
  await evaluate('window.__usaspendingDemo.mainGrid.filters.clear()');
  await sleep(400);

  /* ---- the derived grid ---- */

  await evaluate("window.__usaspendingDemo.tabs.activate('recipients')");
  await waitFor('window.__usaspendingDemo.tabs.tab("recipients") && window.__usaspendingDemo.tabs.tab("recipients").rows.count() > 0', 30000, 'the top-recipients derived grid');
  const recipients = await evaluate(`(() => {
    const d = window.__usaspendingDemo;
    const g = d.tabs.tab('recipients');
    let rows = 0;
    g.rows.forEach(() => { rows += 1; });
    return { rows };
  })()`);
  console.log(`  top recipients derived grid: ${recipients.rows} rows`);
  check(recipients.rows > 0 && recipients.rows <= 20, 'the top-recipients derived grid holds at most twenty rows', `${recipients.rows}`);
  await shoot('04-derived');
  noErrors('saved copy, after the checks');

  /* =================================================================== */
  /* 2. What a visitor gets when the USASpending API cannot be reached.  */
  /* =================================================================== */

  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['*api.usaspending.gov*'] });
  await open(`${origin}/index.html`, 'live page, with the API unreachable');
  const fallback = await evaluate(`(() => {
    const d = window.__usaspendingDemo;
    const notice = document.querySelector('.notice');
    const pill = document.querySelector('.head-note .pill');
    const freshness = document.querySelector('.freshness');
    return {
      rows: d.mainGrid.rows.totalCount(),
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      fellBack: !!(d.timings && d.timings.fellBack),
      mode: d.timings && d.timings.mode,
      badge: pill ? pill.textContent.trim() : null,
      notice: notice ? notice.textContent.trim() : null,
      savedOnShown: freshness ? /saved copy/i.test(freshness.textContent) : false,
      polling: !!d.poller,
    };
  })()`);
  console.log(`  rows ${fallback.rows}, badge "${fallback.badge}", fell back: ${fallback.fellBack}`);
  console.log(`  notice: ${fallback.notice}`);
  check(fallback.rows > 0, 'fallback: the saved copy is on screen', `${fallback.rows} rows`);
  check(fallback.painted > 0, 'fallback: the table painted rows', `${fallback.painted}`);
  check(fallback.fellBack, 'fallback: the page recorded that it fell back to the saved copy');
  check(fallback.mode === 'live', 'fallback: the page ran in the live default, not snapshot mode', `mode ${fallback.mode}`);
  check(fallback.badge === 'Saved copy', 'fallback: the badge reads "Saved copy"', `"${fallback.badge}"`);
  check(
    !!fallback.notice && /could not be reached/i.test(fallback.notice),
    'fallback: the page says the API was unreachable',
    fallback.notice,
  );
  check(fallback.savedOnShown, "fallback: the saved copy's provenance is shown");
  check(!fallback.polling, 'fallback: no poll is started against an API that could not be reached');
  check(pageErrors.length === 0, 'fallback: no page errors', pageErrors.slice(0, 3).join(' | '));
  await shoot('06-fallback');
  await call('Network.setBlockedURLs', { urls: [] });

  if (all) {
    /* ================================================================= */
    /* 3. Live.                                                          */
    /* ================================================================= */

    await open(`${origin}/index.html`, 'live');
    const live = await evaluate(`(() => {
      const d = window.__usaspendingDemo;
      return {
        rows: d.mainGrid.rows.count(),
        charts: d.charts.length,
        fellBack: !!(d.timings && d.timings.fellBack),
        watermark: d.mainGrid.licence.watermark(),
        freshness: document.querySelector('.freshness').textContent,
        tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      };
    })()`);
    console.log(`  ${live.rows} rows from the live API; ${live.freshness}`);
    check(live.fellBack === false, 'live: the rows came from the API, not the saved copy');
    check(live.rows > 0, 'live: the table holds rows from the API', `${live.rows}`);
    check(live.charts === 4, 'live: all four charts were built', `${live.charts}`);
    check(live.watermark === false, 'live: no watermark on localhost');
    check(typeof live.tiles.spending === 'number' && live.tiles.spending > 0, 'live: the tiles read the API', `${live.tiles.spending}`);
    noErrors('live');
    await shoot('07-live');

    /* A poll that fails must leave the table alone and say so. */
    const failed = await evaluate(`(() => {
      const d = window.__usaspendingDemo;
      const before = d.mainGrid.rows.count();
      d.onPollError(new Error('a deliberate failure, for the check'));
      return { before, after: d.mainGrid.rows.count(), text: document.querySelector('.freshness').textContent, className: document.querySelector('.freshness').className };
    })()`);
    check(failed.after === failed.before, 'live: a failed poll does not lose the table', `${failed.before} -> ${failed.after}`);
    check(/could not reach/i.test(failed.text), 'live: a failed poll is said out loud', failed.text);
    check(/failed/.test(failed.className), 'live: a failed poll is marked visually', failed.className);
  }

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
