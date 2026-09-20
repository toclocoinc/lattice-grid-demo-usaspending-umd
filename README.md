# US federal awards, as they stand

A dashboard of federal awards from USASpending.gov — contracts, grants, loans,
direct payments, IDVs and other assistance — grouped by agency, award type and
recipient, built on Lattice Grid loaded by `<script>` tag: no npm install, no
bundler, no build step, no `type="module"`.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-usaspending-umd/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| Grid repository | [toclocoinc/latticegrid](https://github.com/toclocoinc/latticegrid) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |
| The same demo as an ESM package | [lattice-grid-demo-usaspending](https://github.com/toclocoinc/lattice-grid-demo-usaspending) |

It is one stream of awards with several views on it: a table of every award in
view, a strip of headline figures and three statistic tiles, a treemap of the
money by agency, three more charts, and a set of derived grids — the top
recipients, the top agencies and a Pareto head of spending share. They all read
the same stream, so narrowing the table moves everything else with it.

The point of the demo is the money. The country obligates millions of awards a
fiscal year; this page holds a bounded slice of the one that ended in September
2024, and every view reduces the amount column a different way — by agency, by
award type, by recipient, and against the statistics that describe the whole
spread.

## How the grid gets onto the page

Six tags in `index.html`, and that is the whole of the library setup:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/lattice-grid.min.css">

<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/lattice-grid.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/modules/charts.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/modules/data-router.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/modules/kpi.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/modules/tabs.min.js"></script>
```

Each file is the package's UMD build (`*.min.js`, beside the `*.esm.min.js`
the ESM edition imports) and leaves a global behind:

| File | Global | Used here for |
| --- | --- | --- |
| `lattice-grid.min.js` | `LatticeGrid` | `createGrid`, `createStat`, `setLicence` |
| `modules/charts.min.js` | extends `LatticeGrid` | `LatticeGrid.createChart` |
| `modules/data-router.min.js` | `LatticeGridDataRouter` | `createDataRouter` |
| `modules/kpi.min.js` | `LatticeGridKPI` | `createKPI` |
| `modules/tabs.min.js` | `LatticeGridTabs` | `createTabs` |

The charts module folds its exports into the core global rather than defining
one of its own, so its tag must come after the core's. The other three are
self-contained and can go in any order. `main.js` checks that every factory it
needs is actually there before it draws anything, so a tag that did not load
is reported as a sentence rather than as an error from inside the grid.

Every address names the exact release, `1.66.0`, and every tag carries the
`integrity` hash of the file it expects. The page cannot quietly pick up a
different build than the one it was checked against, and the browser refuses
a file that does not match. The hashes are the SHA-384 of the published files.

The demo's own code is four classic scripts, loaded in order after the
library: `src/licence.js`, `src/usaspending-feed.js`, `src/dashboard.js`,
`main.js`. Each file wraps itself in a function and puts what it offers on one
plain object, `Usaspending`, for the next file to read. `src/dashboard.js` is
handed the grid's factories as arguments and never touches a global itself.

## Running it

You need nothing but a browser and a way to serve the folder, because the
page fetches its data with `fetch()` and browsers will not do that from
`file://`. Any static server will do; one is included:

```
node tools/serve.mjs
```

That prints an address. Open it.

| Address | What you get |
| --- | --- |
| `/` | live, reading the USASpending API and polling for changes |
| `/?source=snapshot` | the saved copy in `data/snapshot`, no API needed |

Running a copy on your own machine needs no licence key. Publishing it on a
web address does.

## What it shows

**The money, several ways at once.** The amount column is the obligation
reported on the award. The treemap draws it by awarding agency; the bars draw
it by agency and by award type; the donut shows the type shares. Each is a
different reduction of the same column, and each follows the table's filters.

**A real, bounded slice.** The dataset is millions of awards a year, so the
page does not try to hold it all. It reads a bounded number of pages of each
award-type family for fiscal year 2024, so every kind is represented rather
than one kind crowding the rest out. The saved copy is a compact array of
arrays, so eleven thousand awards stay a manageable download.

**Derived grids.** Top recipients, top agencies, and a Pareto head — the
agencies that account for 80% of the spending, with a running cumulative-share
column — are grids whose rows come from the awards grid rather than from a
load. Filter the table and the rankings re-derive over exactly the rows you
are looking at.

**Pills, bars and two-line cells.** The award type is a pill whose colour
reads the broad kind; the amount is an in-cell bar against the largest in
view; the recipient is two lines, the name over its sub-agency and agency. The
amount column also carries colour bands the grid holds as runtime state, so a
reader can open the Formatting panel and change them.

**Statistics, as tiles.** Three `createStat` tiles read the
mean, median and 95th percentile of the amount column straight from the grid,
each with its confidence interval. The headline figures above them are a KPI
panel bound to the table, so they read whatever the table currently matches.

**A feed that can fail.** If a poll cannot reach USASpending the page says so
and keeps showing what it already had. If the API cannot be reached when the
page first opens, it shows the saved copy instead and says so under the title.

## The data

Everything comes from the USASpending.gov API:

- <https://api.usaspending.gov/>

The page reads the `search/spending_by_award` endpoint, which is a POST — the
filter goes in the body as JSON, and the answer carries `results` plus
`page_metadata.hasNext`. It is public and open to CORS, so it needs no key:

- `https://api.usaspending.gov/api/v2/search/spending_by_award/`

The data are United States government work and are in the public domain.

A few things worth knowing about the data:

- The service refuses award-type codes drawn from more than one family in a
  single request, so the feed runs one query per family: contracts, grants,
  loans, direct payments, other financial assistance, and IDVs.
- An amount is the obligation reported on the award. A loan reports no
  obligation amount — its figure is the subsidy cost, which is what the page
  reads in its place. An IDV is a parent vehicle: its amount is genuinely
  zero, because the money is obligated on the orders beneath it.
- The feed is bounded to fiscal year 2024 (1 October 2023 to 30 September
  2024). An award appears because at least one of its transactions fell in
  that year; the amount is the award's total reported obligation, which may
  have accumulated over earlier years.
- Award type codes differ from the spec on first glance. Contracts are `A` to
  `D`; grants `02` to `05`; loans `07` and `08`; direct payments `06` and
  `10`; other assistance `09` and `11`; and IDVs are `IDV_A` to `IDV_E`.
- The finer "award type" label is read from two fields depending on the
  family — "Contract Award Type" for contracts and IDVs, "Award Type" for
  everything else — because neither is filled for both.

## Files

```
index.html                page shell, and the six library tags
main.js                   works out where the data comes from, then starts
src/licence.js            the key for this demo's own published address
src/usaspending-feed.js   the API: families, paging, parsing, polling
src/dashboard.js          the views: router, grids, tiles, charts, tabs
styles.css                the page around the grid
tools/serve.mjs           a small static file server
tools/build-snapshot.mjs  save a real run into data/snapshot
tools/verify.mjs          open it in a real browser and check it
data/snapshot/            a saved run, so the demo works without the API
```

There is no `package.json` and no `node_modules`. The tools need Node 22 or
newer and nothing else.

The saved copy is a compact array of arrays — one value per column, in the
order `meta.json` documents — so eleven thousand awards stay a manageable
download. The browser unpacks it with the same code that parses the live API,
so the two paths produce identical rows.

## Building the saved copy

```
node tools/build-snapshot.mjs
```

It pages each award-type family a bounded number of pages for fiscal year 2024
and writes the compact form to `data/snapshot/`. Re-run it to refresh the copy.

## Checking it

```
node tools/verify.mjs   # open the page in a real browser and assert
node tools/verify.mjs --all   # also open the live API
```

`tools/verify.mjs` is not a smoke test. It first insists on how the library
arrived: no `type="module"` script anywhere on the page, five script tags
pointing at the pinned release on the CDN, each with an integrity hash, and
each leaving the global it documents. It then checks the treemap and the bars
drew marks rather than empty axes, recomputes the headline figures from the
saved data and compares them with what the page is showing, groups by agency,
pushes a row through and insists the count did not change, narrows the table
and insists the tiles moved with it, opens the derived top-recipients grid, and
finally blocks the USASpending API in the browser and insists the saved copy
appears with a notice saying why. The GitHub Pages workflow runs it before
every publish.

## Licence

The demo code is MIT. See `LICENSE`.

The award data is from USASpending.gov, United States government work, in the
public domain.

Lattice Grid itself is a separate commercial product with its own terms. It is
free to use on localhost, with no key and no watermark, so a copy of this
repository runs unrestricted on your own machine. This demo carries a key for
its own published address only, which is why you will find one in the source.
Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).

---
Built with [Lattice Grid](https://www.latticegrid.dev), a JavaScript data grid with a Data Router: one live feed keeps grids, charts, boards, Gantt and KPI tiles in step. [Documentation](https://www.latticegrid.dev/docs/) · [Demos](https://www.latticegrid.dev/demos/) · [Licence](https://www.latticegrid.dev/licence/)
