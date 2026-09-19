/**
 * Save a real run of the USASpending.gov API to `data/snapshot/`, so the
 * dashboard can also be opened with no network at all.
 *
 * Run it with `node tools/build-snapshot.mjs`. It is a development tool:
 * nothing the page loads imports it.
 *
 * The feed code the page uses is a classic script, not a module, so it cannot
 * be imported. It is run here instead, in this process, exactly as the browser
 * runs it: the file leaves its functions on `globalThis.Usaspending` and they
 * are read from there. One copy of the feed code, used by both.
 *
 * It pages each award-type family a bounded number of pages, so the copy holds
 * a real, balanced slice of one fiscal year rather than a flat sample. The
 * rows are then sorted by id so the file is stable and diffable between runs.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'snapshot');

const feedFile = join(here, '..', 'src', 'usaspending-feed.js');
runInThisContext(await readFile(feedFile, 'utf8'), { filename: feedFile });
const { fetchSnapshotRows, encodeRow, SNAPSHOT_COLUMNS, TARGET_ROWS, AWARD_GROUPS, FISCAL_YEAR } = globalThis.Usaspending;

const started = Date.now();
console.log(`Reading ${AWARD_GROUPS.length} award-type families for FY${FISCAL_YEAR}, aiming for about ${TARGET_ROWS.toLocaleString()} rows...`);

const rows = await fetchSnapshotRows({
  onProgress: (done, total, received) => {
    process.stdout.write(`\r  ${done}/${total} families, ${received.toLocaleString()} rows received`);
  },
});
process.stdout.write('\n');

/* Sorted by id so the file is stable and diffable between runs. */
const values = rows.map(encodeRow);
values.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

const seconds = Number(((Date.now() - started) / 1000).toFixed(1));

const byKind = new Map();
for (const row of rows) byKind.set(row.kind, (byKind.get(row.kind) || 0) + 1);

const meta = {
  fetchedAt: new Date().toISOString(),
  fetchedAtMs: Date.now(),
  seconds,
  rows: values.length,
  fiscalYear: FISCAL_YEAR,
  source: 'USASpending.gov federal awards (spending_by_award)',
  sourceUrl: 'https://www.usaspending.gov/',
  apiUrl: 'https://api.usaspending.gov/api/v2/search/spending_by_award/',
  licence: 'United States government work (public domain)',
  columns: SNAPSHOT_COLUMNS,
  groups: AWARD_GROUPS.map((group) => ({ kind: group.kind, codes: group.codes })),
  rowsByKind: Object.fromEntries(byKind),
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'awards.json'), JSON.stringify(values));
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

const bytes = (await stat(join(outDir, 'awards.json'))).size;
console.log(`\nSaved ${values.length.toLocaleString()} awards in ${seconds}s.`);
console.log(`awards.json is ${(bytes / 1024 / 1024).toFixed(1)} MB.`);
console.log(`Rows by kind: ${JSON.stringify(meta.rowsByKind)}`);
