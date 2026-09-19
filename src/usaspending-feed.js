/**
 * The USASpending.gov award feed: reading the spending-by-award search
 * endpoint, paging it across the award-type families, and turning one record
 * into a flat row.
 *
 * Nothing here knows about the grid. It produces plain objects and hands them
 * to whoever asked, so the same code feeds the live page and the saved copy.
 *
 * The search endpoint is a POST: the filter goes in the body as JSON, and the
 * answer carries `results` plus `page_metadata.hasNext`. The service is public
 * and open to CORS, so it needs no key; the only header is `Content-Type`.
 *
 * The dataset is enormous (millions of awards a fiscal year), and the service
 * refuses award-type codes drawn from more than one family in a single
 * request. So the feed is a set of queries — one per award-type family — each
 * paged until it has its share of the row budget. The live page pages a little
 * of each; the snapshot tool pages more until it has the row count it was
 * asked for. Everything is bounded to one fiscal year (FY2024) so the copy is
 * a recent, honest slice rather than an open-ended download.
 *
 * This is a classic script, not a module: there is no `import` or `export`
 * anywhere on this page. What this file offers is put on `Usaspending`, a
 * plain object on the global, and the next script reads it from there. The
 * snapshot tool runs this same file under Node, which is why it looks for
 * `globalThis` rather than `window`.
 */
(function (root) {
  'use strict';

  const BASE = 'https://api.usaspending.gov';
  const ENDPOINT = '/api/v2/search/spending_by_award/';

  /** The fields read out of each award. The API returns exactly these plus a
      couple of internal keys. `Subsidy Cost` is only filled for loans, whose
      "Award Amount" is null. */
  const FIELDS = [
    'Award ID',
    'Award Amount',
    'Subsidy Cost',
    'Recipient Name',
    'Awarding Agency',
    'Awarding Sub Agency',
    'generated_internal_id',
    'Description',
    'Contract Award Type',
    'Award Type',
  ];

  /** How many pages the live page reads per family. Four pages of a hundred is
      a quick load and enough to show every view. */
  const LIVE_PAGES_PER_QUERY = 4;

  /** How many rows the snapshot tool aims to save, reached by paging each
      family a little further. */
  const TARGET_ROWS = 12000;

  /** How often the live page asks the API for changes. New awards are recorded
      continuously, but nothing here changes by the minute, so this is slow. */
  const POLL_MS = 10 * 60 * 1000;

  /** The federal fiscal year the feed reads: 1 October to 30 September, named
      for the year it ends in. */
  const FISCAL_YEAR = 2024;
  const TIME_PERIOD = { start_date: '2023-10-01', end_date: '2024-09-30', date_type: 'action_date' };

  /**
   * The award-type families, and the broad kind each maps to. The service only
   * accepts codes from one family per request, so each family is one query.
   *
   * `weight` scales a family's share of the page budget. An IDV is a parent
   * vehicle whose obligation sits on the orders beneath it, so it reports an
   * amount of zero and is read lightly rather than flooding the amount
   * figures with zero rows.
   */
  const AWARD_GROUPS = [
    { id: 'contracts', kind: 'Contract', codes: ['A', 'B', 'C', 'D'] },
    { id: 'grants', kind: 'Grant', codes: ['02', '03', '04', '05'] },
    { id: 'loans', kind: 'Loan', codes: ['07', '08'] },
    { id: 'direct-payments', kind: 'Direct payment', codes: ['06', '10'] },
    { id: 'other', kind: 'Other', codes: ['09', '11'] },
    { id: 'idvs', kind: 'IDV', codes: ['IDV_A', 'IDV_B', 'IDV_B_A', 'IDV_B_B', 'IDV_B_C', 'IDV_C', 'IDV_D', 'IDV_E'], weight: 0.1 },
  ];

  /** The six kinds a pill and a variant can carry. */
  const KINDS = AWARD_GROUPS.map((group) => group.kind);

  /** Semantic colours for each kind, for the pills and the legend. */
  const KIND_VARIANTS = {
    Contract: 'info',
    Grant: 'success',
    Loan: 'warning',
    'Direct payment': 'accent',
    Other: 'danger',
    IDV: 'neutral',
  };

  /** The order the snapshot stores its fields in, so a compact array can be
      decoded back into a row. Shared by the browser and the snapshot tool. */
  const SNAPSHOT_COLUMNS = ['id', 'amount', 'recipient', 'agency', 'subAgency', 'kind', 'awardType', 'description'];

  /** A raw type string, title-cased and with the trailing assistance-listing
      letter dropped: "GUARANTEED/INSURED LOAN (F)" reads "Guaranteed/Insured Loan". */
  function titleCaseAwardType(raw) {
    const text = String(raw || '')
      .trim()
      .replace(/\s+\([A-Za-z]\)$/, '')
      .toLowerCase()
      .replace(/(^|[\s/-])([a-z])/g, (match, sep, letter) => sep + letter.toUpperCase());
    return text;
  }

  /**
   * POST one page of the search endpoint and parse it.
   *
   * @param {object} opts
   * @param {string[]} opts.codes the award-type codes (one family)
   * @param {number} opts.page 1-based
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<object>} the parsed body
   */
  async function postPage(opts) {
    const payload = {
      filters: {
        award_type_codes: opts.codes,
        time_period: [{ start_date: TIME_PERIOD.start_date, end_date: TIME_PERIOD.end_date, date_type: TIME_PERIOD.date_type }],
      },
      fields: FIELDS,
      limit: 100,
      page: opts.page,
    };
    const maxAttempts = 4;
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(`${BASE}${ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
        signal: opts.signal,
      });
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`USASpending answered ${response.status}.`);
    }
  }

  /**
   * Turn one award result into a flat row.
   *
   * The API returns far more than the demo needs, so only the fields the grid
   * shows are read out, defensively, because an award may leave any of them
   * blank. The broad `kind` comes from the query rather than the record, which
   * is always known; the finer `awardType` comes from whichever of the two
   * type fields the record actually filled in ("Contract Award Type" for
   * contracts and IDVs, "Award Type" for everything else).
   *
   * A loan reports no "Award Amount" — its obligation is carried as a subsidy
   * cost, which is what this reads in its place. An IDV's amount is genuinely
   * zero: the money is obligated on the orders beneath the vehicle.
   *
   * @param {object} result one member of a `results` array
   * @param {string} kind the family's broad kind
   * @returns {object|null} the row, or null when it has no identity
   */
  function toRow(result, kind) {
    if (!result || result.generated_internal_id == null) return null;
    const rawType = result['Contract Award Type'] || result['Award Type'];
    let amount = result['Award Amount'];
    if (amount == null) amount = result['Subsidy Cost'];
    const value = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
    return {
      id: String(result.generated_internal_id),
      amount: value,
      recipient: (result['Recipient Name'] || '').trim() || '(unlisted)',
      agency: (result['Awarding Agency'] || '').trim() || '(unlisted)',
      subAgency: (result['Awarding Sub Agency'] || '').trim() || '',
      kind,
      awardType: titleCaseAwardType(rawType) || kind,
      description: (result['Description'] || '').trim().slice(0, 160),
      /* Always 1. It is what the charts and a group subtotal count. */
      count: 1,
    };
  }

  /**
   * Page one family until it is exhausted or its page budget is spent,
   * returning the rows.
   *
   * @param {object} group a member of {@link AWARD_GROUPS}
   * @param {number} pageCap the most pages to read
   * @param {AbortSignal} [signal]
   * @returns {Promise<object[]>} the rows
   */
  async function fetchKindRows(group, pageCap, signal) {
    const rows = [];
    let page = 1;
    while (page <= pageCap) {
      const body = await postPage({ codes: group.codes, page, signal });
      for (const result of body.results || []) {
        const row = toRow(result, group.kind);
        if (row) rows.push(row);
      }
      if (!body.page_metadata || !body.page_metadata.hasNext) break;
      page += 1;
    }
    return rows;
  }

  /**
   * Page several families with a bounded number in flight at once, reporting
   * progress. Each family keeps its own page budget, so no single family
   * crowds the rest out.
   *
   * @param {object} opts
   * @param {object[]} opts.groups the families to read
   * @param {number} opts.pageCap the default pages to read per family
   * @param {number} [opts.concurrency]
   * @param {(done: number, total: number, rows: number) => void} [opts.onProgress]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<object[]>} all rows, in arrival order
   */
  async function fetchGroups({ groups, pageCap, concurrency = 3, onProgress, signal }) {
    const report = onProgress || (() => {});
    const rows = [];
    let done = 0;
    let next = 0;

    const workers = Array.from({ length: Math.min(concurrency, groups.length) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= groups.length) return;
        const group = groups[index];
        const budget = Math.max(1, Math.round(pageCap * (group.weight == null ? 1 : group.weight)));
        const groupRows = await fetchKindRows(group, budget, signal);
        rows.push(...groupRows);
        done += 1;
        report(done, groups.length, rows.length);
      }
    });

    await Promise.all(workers);
    return rows;
  }

  /**
   * Read the live page's starting data: every family, paged a little.
   *
   * @param {{signal?: AbortSignal, onProgress?: Function}} [opts]
   * @returns {Promise<{rows: object[]}>}
   */
  async function fetchInitial(opts = {}) {
    const report = opts.onProgress || (() => {});
    report('Reading USASpending.gov...', 0.05);
    const rows = await fetchGroups({
      groups: AWARD_GROUPS,
      pageCap: LIVE_PAGES_PER_QUERY,
      concurrency: 3,
      signal: opts.signal,
      onProgress: (done, total, received) => {
        report(`Reading USASpending.gov (${done} of ${total} award families, ${received} awards)...`, 0.05 + 0.9 * (done / total));
      },
    });
    report('Building the dashboard...', 1);
    return { rows };
  }

  /**
   * Read enough of the API for a saved copy: page every family until its
   * snapshot budget is spent.
   *
   * @param {{onProgress?: Function, signal?: AbortSignal}} [opts]
   * @returns {Promise<object[]>} the rows
   */
  async function fetchSnapshotRows(opts = {}) {
    const report = opts.onProgress || (() => {});
    return fetchGroups({
      groups: AWARD_GROUPS,
      pageCap: 20,
      concurrency: 2,
      signal: opts.signal,
      onProgress: (done, total, received) => report(done, total, received),
    });
  }

  /**
   * Poll the same families for changes and report each result.
   *
   * Awards are added and amended continuously; a poll upserts by the award's
   * internal id, so a changed amount lands on the row it belongs to rather than
   * adding a second one. The router keyed on `id` handles that.
   *
   * @param {object} opts
   * @param {(result: object) => void} opts.onPoll called with each successful poll
   * @param {(error: Error) => void} [opts.onError] called when a poll fails
   * @param {number} [opts.intervalMs]
   * @returns {{stop: Function, pollNow: Function}}
   */
  function startPolling({ onPoll, onError, intervalMs = POLL_MS }) {
    let stopped = false;
    let timer = null;
    let polls = 0;
    const controller = new AbortController();

    const runOnce = async () => {
      if (stopped) return;
      polls += 1;
      try {
        const rows = await fetchGroups({
          groups: AWARD_GROUPS,
          pageCap: LIVE_PAGES_PER_QUERY,
          concurrency: 3,
          signal: controller.signal,
        });
        if (!stopped) onPoll({ rows, fetchedAt: Date.now(), poll: polls });
      } catch (error) {
        if (!stopped && onError) onError(error);
      }
    };

    timer = setInterval(runOnce, intervalMs);

    return {
      stop() {
        stopped = true;
        clearInterval(timer);
        controller.abort();
      },
      pollNow: runOnce,
    };
  }

  /** Pack a row into the compact array form the snapshot stores. */
  function encodeRow(row) {
    return SNAPSHOT_COLUMNS.map((col) => row[col]);
  }

  /** Unpack a compact snapshot array back into a row, deriving `count`. */
  function decodeRow(values) {
    const row = {};
    SNAPSHOT_COLUMNS.forEach((col, index) => {
      row[col] = values[index];
    });
    row.count = 1;
    return row;
  }

  /** Read the saved copy that ships with the demo. */
  async function readSnapshot() {
    const [values, meta] = await Promise.all(
      ['awards', 'meta'].map(async (name) => {
        const response = await fetch(`./data/snapshot/${name}.json`);
        if (!response.ok) throw new Error(`The saved copy is missing ${name}.json.`);
        return response.json();
      }),
    );
    return { rows: values.map(decodeRow), meta: { ...meta, live: false } };
  }

  root.Usaspending = Object.assign(root.Usaspending || {}, {
    BASE,
    ENDPOINT,
    FIELDS,
    LIVE_PAGES_PER_QUERY,
    TARGET_ROWS,
    POLL_MS,
    FISCAL_YEAR,
    TIME_PERIOD,
    AWARD_GROUPS,
    KINDS,
    KIND_VARIANTS,
    SNAPSHOT_COLUMNS,
    titleCaseAwardType,
    postPage,
    toRow,
    encodeRow,
    decodeRow,
    fetchKindRows,
    fetchGroups,
    fetchInitial,
    fetchSnapshotRows,
    startPolling,
    readSnapshot,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
