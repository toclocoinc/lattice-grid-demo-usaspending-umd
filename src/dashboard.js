/**
 * The dashboard: one stream of federal awards, and every view built on top of
 * it.
 *
 * The data router is the hub. Nothing here fetches anything and nothing here
 * reaches for the grid's globals: every factory is handed in, so this file is
 * the same whether the library arrived by script tag, as it does here, or by
 * import, as it does in the ESM edition of this demo.
 *
 * How the pieces fit together:
 *
 *   the API  ->  the router  ->  the awards grid  ->  the tiles
 *                                      |             the four charts
 *                                      +-> the derived grids
 *
 * The awards grid (every award in the stream) is the primary view: the tiles,
 * the charts and the derived grids all read it. The derived grids — top
 * recipients, top agencies and a Pareto head of spending share — are grids
 * whose rows come from the awards grid rather than from a load.
 *
 * A classic script: it reads the constants from `Usaspending`, put there by
 * `usaspending-feed.js`, and adds `buildDashboard` alongside them.
 */
(function (root) {
  'use strict';

  const { KIND_VARIANTS } = root.Usaspending;

  /** Make an element with a class and optional text, the long way round. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** One number, written the way a reader expects to see it. */
  function commas(value) {
    return Number(value || 0).toLocaleString('en-GB');
  }

  /** A clock time, local to whoever is reading. */
  function clockText(ms) {
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /* ------------------------------------------------------------------ */
  /* Columns                                                             */
  /* ------------------------------------------------------------------ */

  /** The awards grid's columns, grouped under two headings. */
  function awardColumns() {
    return [
      {
        title: 'The award',
        columns: [
          {
            id: 'recipient',
            field: 'recipient',
            title: 'Recipient',
            /* Two lines: the recipient over its sub-agency and agency. */
            cell: {
              render: 'twoline',
              props: {
                secondary: (p) => {
                  const data = p && p.data;
                  if (!data) return '';
                  return data.subAgency ? `${data.subAgency} · ${data.agency}` : data.agency;
                },
              },
            },
            filter: { type: 'text' },
            layout: { width: 300 },
          },
          {
            id: 'kind',
            field: 'kind',
            title: 'Type',
            /* A pill whose colour reads the broad award type. */
            cell: { decoration: 'pill', variant: { map: KIND_VARIANTS, default: 'neutral' } },
            filter: { type: 'set' },
            layout: { width: 130 },
          },
          {
            id: 'awardType',
            field: 'awardType',
            title: 'Award type',
            filter: { type: 'set' },
            layout: { width: 190 },
          },
          {
            id: 'description',
            field: 'description',
            title: 'Description',
            filter: { type: 'text' },
            layout: { width: 320, hidden: true },
          },
        ],
      },
      {
        title: 'The money',
        columns: [
          {
            id: 'amount',
            field: 'amount',
            title: 'Obligated',
            type: 'number',
            format: { style: 'currency', currency: 'USD', decimals: 0 },
            /* An in-cell bar: the amount against the largest in view. */
            cell: { decoration: 'bar' },
            filter: { type: 'number' },
            total: 'sum',
            groupTotal: 'sum',
            layout: { width: 170 },
          },
          {
            id: 'agency',
            field: 'agency',
            title: 'Awarding agency',
            filter: { type: 'set' },
            layout: { width: 210 },
          },
          {
            id: 'subAgency',
            field: 'subAgency',
            title: 'Awarding sub-agency',
            filter: { type: 'set' },
            layout: { width: 210, hidden: true },
          },
          /* Always 1. It is what the charts and a group subtotal count. */
          {
            id: 'count',
            field: 'count',
            title: 'Awards',
            type: 'number',
            total: 'sum',
            groupTotal: 'sum',
            filter: { type: 'none' },
            layout: { width: 80, hidden: true },
          },
        ],
      },
    ];
  }

  /**
   * The amount column's colour bands.
   *
   * These are conditional formatting rules the grid holds as runtime state, so
   * a reader can open the Formatting panel and change them. They colour the
   * text rather than the background, because the background already carries
   * the in-cell data bar.
   */
  function formattingRules() {
    return {
      amount: [
        { id: 'small', label: 'Under $50k', when: { op: 'lt', value: 50000 }, style: { color: '#475467', fontWeight: '500' } },
        { id: 'mid', label: '$50k to $1m', when: { op: 'between', value: 50000, value2: 1000000 }, style: { color: '#1d4ed8', fontWeight: '600' } },
        { id: 'large', label: 'Over $1m', when: { op: 'gte', value: 1000000 }, style: { color: '#b91c1c', fontWeight: '700' } },
      ],
    };
  }

  /** The shared grid settings the awards grid uses. */
  function baseGridConfig(title) {
    return {
      rowKey: 'id',
      columns: awardColumns(),
      formatting: formattingRules(),
      theme: 'light',
      density: 'comfortable',
      stripedRows: true,
      columnMenu: true,
      groupPanel: true,
      statusBar: true,
      find: true,
      grandTotalRow: 'bottom',
      groupDefaultExpanded: 0,
      toolPanel: { side: 'left', panels: ['filters', 'columns', 'formatting'] },
      selection: 'multiple',
      highlightOnChange: { colour: '#ffe8a3', duration: 2500 },
      title,
    };
  }

  /** The compact money format a derived summary column uses. */
  const COMPACT = { style: 'currency', currency: 'USD', notation: 'compact' };

  /** A derived ranking grid's columns: the dimension, the total, the count. */
  function rankingColumns(dimension, title) {
    return [
      { id: dimension, title, layout: { width: 280 } },
      { id: 'total', title: 'Total obligated', type: 'number', format: COMPACT, total: 'sum', layout: { width: 150 } },
      { id: 'awards', title: 'Awards', type: 'number', total: 'sum', layout: { width: 90 } },
    ];
  }

  /* ------------------------------------------------------------------ */
  /* The dashboard                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Build the whole page into `root`.
   *
   * @param {object} options
   * @param {HTMLElement} options.root where the dashboard is drawn
   * @param {Function} options.createGrid the grid factory
   * @param {Function} options.createChart the charts module's factory
   * @param {Function} options.createKPI the KPI module's factory
   * @param {Function} options.createTabs the tabs module's factory
   * @param {Function} options.createStat the core's statistic-tile factory
   * @param {Function} options.createDataRouter the data router module's factory
   * @param {object[]} options.rows the awards to start with
   * @param {object} options.meta where the data came from, and when
   * @returns {object} the pieces that were built, for a caller that wants them
   */
  function buildDashboard({
    root: host,
    createGrid,
    createChart,
    createKPI,
    createTabs,
    createStat,
    createDataRouter,
    rows,
    meta,
  }) {
    host.textContent = '';

    const built = {
      mainGrid: null,
      tabs: null,
      router: null,
      kpi: null,
      stats: [],
      charts: [],
      /* Everything the page currently holds, by id. The router drives the
         views; the store is what a later-built lazy view is filled from. */
      store: new Map(),
      status: { lastPoll: null, lastError: null, polls: 0, revisions: 0, arrivals: 0 },
    };

    /* ---------------- the masthead ---------------- */

    const header = el('header', 'head');
    const heading = el('div', 'head-text');
    heading.append(el('h1', null, 'US federal awards, as they stand'));
    heading.append(
      el(
        'p',
        'lede',
        'Awards from USASpending.gov — contracts, grants, loans, direct payments, IDVs and other assistance — ' +
          'grouped by agency, award type and recipient, with the totals drawn live. The country obligates millions of awards ' +
          'a fiscal year; this page holds a recent slice of the one that ended in September 2024.',
      ),
    );
    if (meta.fellBack) {
      heading.append(
        el(
          'p',
          'notice',
          'USASpending.gov could not be reached, so this is the saved copy. Reloading the page will try again.',
        ),
      );
    }
    header.append(heading);

    const provenance = el('div', 'head-note');
    const modePill = el('span', 'pill', meta.live ? 'Live' : 'Saved copy');
    const liveDot = el('span', 'dot');
    if (meta.live) modePill.prepend(liveDot);
    const freshness = el('span', 'freshness', 'Waiting for the first update...');
    provenance.append(modePill, freshness);
    header.append(provenance);
    host.append(header);

    /* ---------------- the tiles ---------------- */

    const kpiHost = el('section', 'kpi-strip');
    kpiHost.setAttribute('aria-label', 'Headline figures');
    const panelHost = el('div', 'kpi-panel');
    const statTilesHost = el('div', 'stat-tiles');
    const namedTile = el('div', 'kpi-named');
    const namedValue = el('div', 'kpi-named-value', 'No data');
    const namedLabel = el('div', 'kpi-named-label', 'Largest recipient in view');
    namedTile.append(namedValue, namedLabel);
    kpiHost.append(panelHost);
    host.append(kpiHost);

    /* The distribution figures sit on their own strip below the headline KPIs,
       so the top row stays four clean tiles. */
    const secondaryHost = el('section', 'kpi-strip kpi-strip-secondary');
    secondaryHost.setAttribute('aria-label', 'Distribution figures');
    secondaryHost.append(statTilesHost, namedTile);
    host.append(secondaryHost);

    /* ---------------- the charts ---------------- */

    const chartHost = el('section', 'chart-wrap');
    chartHost.setAttribute('aria-label', 'Charts');
    const chartBoxes = [];
    for (let i = 0; i < 4; i += 1) {
      const box = el('div', i === 0 ? 'chart-box chart-box-wide' : 'chart-box');
      chartHost.append(box);
      chartBoxes.push(box);
    }
    host.append(chartHost);

    /* ---------------- the controls ---------------- */

    const actions = el('div', 'actions');
    host.append(actions);

    /* ---------------- the awards grid, beside the analysis tabs ---------------- */

    const split = el('div', 'split');
    host.append(split);

    const mainSection = el('section', 'main-section');
    mainSection.append(el('h2', 'section-title', 'Every award in view'));
    const mainHost = el('div', 'main-grid');
    mainSection.append(mainHost);
    split.append(mainSection);

    const mainGrid = createGrid(mainHost, {
      ...baseGridConfig('Federal awards, one row per award'),
      rows: [],
    });
    built.mainGrid = mainGrid;

    /* ---------------- the analysis tabs ---------------- */

    const tabsSection = el('section', 'main-section');
    tabsSection.append(el('h2', 'section-title', 'Analysis views'));
    const tabsHost = el('section', 'tabs-host');
    tabsSection.append(tabsHost);
    split.append(tabsSection);

    /* ---------------- the router ---------------- */

    /*
     * One stream in, every view out. The derived grids read the awards grid
     * rather than being routed to, so they follow it through its own filters.
     * A re-fetched award upserts by `id` rather than adding a second row.
     */
    const router = createDataRouter({
      rowKey: 'id',
      overlap: true,
    });
    built.router = router;

    router.attach(mainGrid, () => true);

    /* A route that renders nothing: it counts what arrives, for the readout
       under the masthead. */
    router.subscribe(() => true, (change) => {
      built.status.arrivals += (change.add || []).length;
      built.status.revisions += (change.update || []).length;
    });

    /**
     * Put rows into the store and through the router.
     *
     * @param {object[]} incoming the rows to apply
     * @returns {number} how many rows were applied
     */
    const ingest = (incoming) => {
      if (!incoming || !incoming.length) return 0;
      for (const row of incoming) built.store.set(row.id, row);
      router.apply(incoming.map((row) => ({ op: 'upsert', row })));
      return incoming.length;
    };

    /* The first load. A snapshot is a keyed diff, so calling this again later
       updates what changed rather than repainting everything. */
    for (const row of rows) built.store.set(row.id, row);
    router.load([...built.store.values()]);

    /* The derived tabs mount against an awards grid that already holds its
       rows, so their first derivation is not of an empty source. */
    const tabs = createTabs(tabsHost, {
      createGrid,
      ariaLabel: 'Analysis views',
      active: 'recipients',
      tabs: [
        {
          id: 'recipients',
          label: 'Top recipients',
          badge: true,
          config: {
            rowKey: '__key',
            columns: rankingColumns('recipient', 'Recipient'),
            title: 'The twenty recipients with the most obligated',
            theme: 'light',
            density: 'comfortable',
            statusBar: true,
            grandTotalRow: 'bottom',
            source: {
              mode: 'derived',
              from: mainGrid,
              follow: 'filtered',
              groupBy: 'recipient',
              select: { total: { of: 'amount', fn: 'sum' }, awards: { fn: 'count' } },
              sort: [{ col: 'total', dir: 'desc' }],
              limit: 20,
            },
          },
        },
        {
          id: 'agencies',
          label: 'Top agencies',
          badge: true,
          config: {
            rowKey: '__key',
            columns: rankingColumns('agency', 'Awarding agency'),
            title: 'The twenty awarding agencies by amount obligated',
            theme: 'light',
            density: 'comfortable',
            statusBar: true,
            grandTotalRow: 'bottom',
            source: {
              mode: 'derived',
              from: mainGrid,
              follow: 'filtered',
              groupBy: 'agency',
              select: { total: { of: 'amount', fn: 'sum' }, awards: { fn: 'count' } },
              sort: [{ col: 'total', dir: 'desc' }],
              limit: 20,
            },
          },
        },
        {
          id: 'pareto',
          label: 'Spending share',
          badge: true,
          config: {
            rowKey: '__key',
            columns: [
              { id: 'agency', title: 'Awarding agency', layout: { width: 280 } },
              { id: 'total', title: 'Total obligated', type: 'number', format: COMPACT, total: 'sum', layout: { width: 150 } },
              { id: 'share', field: 'total', title: 'Cumulative share', type: 'number', running: 'percent', format: { suffix: '%', decimals: 1 }, layout: { width: 140 } },
              { id: 'awards', title: 'Awards', type: 'number', total: 'sum', layout: { width: 90 } },
            ],
            title: 'The agencies that account for 80% of the spending',
            theme: 'light',
            density: 'comfortable',
            statusBar: true,
            grandTotalRow: 'bottom',
            source: {
              mode: 'derived',
              from: mainGrid,
              follow: 'filtered',
              groupBy: 'agency',
              select: { total: { of: 'amount', fn: 'sum' }, awards: { fn: 'count' } },
              sort: [{ col: 'total', dir: 'desc' }],
              cumulative: { of: 'total', upTo: 0.8 },
            },
          },
        },
      ],
    });
    built.tabs = tabs;

    /* ---------------- the tiles, bound to the awards grid ---------------- */

    const kpi = createKPI(panelHost, {
      grid: mainGrid,
      rowKey: 'id',
      fields: ['amount', 'recipient', 'kind'],
      columns: 4,
      ariaLabel: 'Headline figures',
      tiles: [
        { id: 'spending', label: 'Total obligated', aggregation: 'sum', field: 'amount', format: { type: 'currency', currency: 'USD', decimals: 0 } },
        { id: 'awards', label: 'Awards', aggregation: 'count', format: 'number' },
        { id: 'recipients', label: 'Recipients', aggregation: 'countDistinct', field: 'recipient', format: 'number' },
        { id: 'largest', label: 'Largest single award', aggregation: 'max', field: 'amount', format: { type: 'currency', currency: 'USD', decimals: 0 } },
      ],
    });
    built.kpi = kpi;

    /**
     * Name the largest recipient in view, by amount obligated.
     *
     * A phrase rather than a number, so it is drawn by hand from the bound
     * panel's own rows rather than as a tile.
     */
    const refreshNamedTile = () => {
      const byRecipient = new Map();
      kpi.rows.forEach((row) => {
        const amount = typeof row.amount === 'number' ? row.amount : 0;
        const recipient = row.recipient || '(unlisted)';
        byRecipient.set(recipient, (byRecipient.get(recipient) || 0) + amount);
      });
      let best = null;
      for (const [recipient, total] of byRecipient) if (!best || total > best.total) best = { recipient, total };
      if (!best) {
        namedValue.textContent = 'No data';
        namedLabel.textContent = 'Largest recipient in view';
        return;
      }
      namedValue.textContent = best.recipient;
      namedLabel.textContent = `Largest recipient in view, ${commas(Math.round(best.total))} USD`;
    };
    kpi.on('change', refreshNamedTile);
    refreshNamedTile();

    /* ---------------- the statistic tiles ---------------- */

    const statSpecs = [
      { title: 'Mean award', fn: 'avg' },
      { title: 'Median award', fn: 'median' },
      { title: '95th percentile', fn: 'p95' },
    ];
    statSpecs.forEach((spec) => {
      const box = el('div', 'stat-box');
      statTilesHost.append(box);
      try {
        const tile = createStat({
          grid: mainGrid,
          container: box,
          title: spec.title,
          value: { of: 'amount', fn: spec.fn },
          interval: (value, grid) => grid.statistics.interval('amount'),
        });
        built.stats.push(tile);
      } catch (error) {
        box.append(el('p', 'chart-error', `This tile could not be drawn: ${error.message}`));
        console.error('[usaspending demo] stat', spec.title, error);
      }
    });

    /* ---------------- the charts, bound to the awards grid ---------------- */

    const chartSpecs = [
      {
        type: 'treemap',
        x: 'agency',
        y: 'amount',
        title: 'Total obligated, by agency',
        legend: false,
      },
      {
        type: 'bar',
        x: 'agency',
        y: 'amount',
        title: 'Total obligated by agency',
        axis: { y: 'USD', x: { labels: true, rotate: 'auto' } },
        legend: false,
      },
      {
        type: 'bar',
        x: 'kind',
        y: 'amount',
        title: 'Total obligated by award type',
        axis: { y: 'USD' },
        legend: false,
      },
      {
        type: 'donut',
        x: 'kind',
        y: 'amount',
        title: 'Share of obligated, by award type',
        legend: false,
      },
    ];

    chartSpecs.forEach((spec, index) => {
      try {
        built.charts.push(createChart({ grid: mainGrid, container: chartBoxes[index], ...spec }));
      } catch (error) {
        chartBoxes[index].append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
        console.error('[usaspending demo] chart', spec.type, error);
      }
    });

    /* ---------------- the controls ---------------- */

    const button = (label, onClick, className) => {
      const node = el('button', className || 'action', label);
      node.type = 'button';
      node.addEventListener('click', onClick);
      return node;
    };

    const group = (ids) => () => mainGrid.columns.group(ids);

    actions.append(el('span', 'actions-label', 'Group by'));
    actions.append(button('Agency', group(['agency'])));
    actions.append(button('Award type', group(['kind'])));
    actions.append(button('Recipient', group(['recipient'])));
    actions.append(button('Agency, then type', group(['agency', 'kind'])));
    actions.append(button('No grouping', group([])));

    actions.append(el('span', 'actions-gap'));
    actions.append(el('span', 'actions-label', 'Order by'));
    actions.append(button('Largest first', () => mainGrid.sort.set([{ col: 'amount', dir: 'desc' }])));
    actions.append(button('Recipient A–Z', () => mainGrid.sort.set([{ col: 'recipient', dir: 'asc' }])));
    built.group = group;

    /* ---------------- the live readout ---------------- */

    const setFreshness = () => {
      if (!meta.live) {
        const saved = new Date(meta.fetchedAt).toLocaleString('en-GB');
        freshness.textContent = `A saved copy of the USASpending data, taken on ${saved}.`;
        freshness.className = 'freshness';
        return;
      }
      if (built.status.lastError) {
        freshness.textContent = built.status.lastPoll
          ? `Could not reach USASpending.gov. Still showing what arrived at ${clockText(built.status.lastPoll)}.`
          : 'Could not reach USASpending.gov.';
        freshness.className = 'freshness failed';
        return;
      }
      if (!built.status.lastPoll) {
        freshness.textContent = 'Waiting for the first update...';
        freshness.className = 'freshness';
        return;
      }
      freshness.textContent =
        `Updated ${clockText(built.status.lastPoll)}. ` +
        `${commas(built.status.arrivals)} new, ${commas(built.status.revisions)} revised since the page opened.`;
      freshness.className = 'freshness';
    };
    built.setFreshness = setFreshness;

    /** Take a poll's result: apply it, refresh the figures and say so. */
    built.onPoll = (result) => {
      built.status.lastPoll = result.fetchedAt || Date.now();
      built.status.lastError = null;
      built.status.polls += 1;
      liveDot.classList.add('beat');
      setTimeout(() => liveDot.classList.remove('beat'), 900);
      ingest(result.rows);
      setFreshness();
    };

    /** Take a failed poll: keep the table, say what happened. */
    built.onPollError = (error) => {
      built.status.lastError = String((error && error.message) || error);
      setFreshness();
      console.warn('[usaspending demo] a poll failed:', built.status.lastError);
    };

    /* A hook for the verification script and for anyone poking at the page:
       push rows through exactly the path a poll uses. */
    built.ingest = ingest;

    setFreshness();

    /* ---------------- the footer ---------------- */

    const footer = el('footer', 'foot');
    const line = el('p', null, 'Award data from the ');
    const link = el('a', null, 'USASpending.gov API');
    link.href = 'https://api.usaspending.gov/';
    link.rel = 'noopener';
    line.append(link);
    line.append(
      document.createTextNode(
        ', a public service with no key. The saved copy holds a slice of fiscal year 2024: a few pages of each ' +
          'award-type family, so every kind is represented. An amount is the obligation reported on the award; a loan is ' +
          'its subsidy cost, and an IDV is its parent vehicle and carries no obligation of its own.',
      ),
    );
    footer.append(line);
    host.append(footer);

    built.destroy = () => {
      for (const chart of built.charts) chart.destroy();
      for (const stat of built.stats) stat.destroy();
      kpi.destroy();
      router.destroy();
      tabs.destroy();
    };

    return built;
  }

  root.Usaspending.buildDashboard = buildDashboard;
})(typeof globalThis !== 'undefined' ? globalThis : window);
