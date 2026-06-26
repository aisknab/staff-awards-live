import { ApiClient, ApiError } from './common/api.js';
import { clear, formatPercent, h } from './common/dom.js';

const root = document.querySelector('#app');
const api = new ApiClient();
let state = null;
let accessToken = '';
let message = '';
let passwordRequired = false;
let passwordDraft = '';
let busy = false;

void initialise();

async function initialise() {
  accessToken = readFragment('dashboard');
  if (!accessToken) {
    message = 'Dashboard link unavailable.';
    render();
    return;
  }
  await loadDashboard();
}

async function loadDashboard(password = '') {
  busy = true;
  message = '';
  render();
  try {
    const payload = await api.request('/api/dashboard/state', { method: 'POST', body: { token: accessToken, password }, csrf: false });
    if (payload?.passwordRequired) {
      state = null;
      passwordRequired = true;
      return;
    }
    state = payload;
    passwordRequired = false;
    passwordDraft = '';
  } catch (error) {
    state = null;
    passwordRequired = error instanceof ApiError && error.status === 403 ? passwordRequired : false;
    message = friendlyError(error);
  } finally {
    busy = false;
    render();
  }
}

function readFragment(kind) {
  const prefix = `#${kind}/`;
  return location.hash.startsWith(prefix) ? location.hash.slice(prefix.length) : null;
}

function render() {
  if (busy && !state && !passwordRequired) {
    clear(root, h('main', { class: 'dashboard-shell' }, dashboardHeader(null), h('section', { class: 'dashboard-empty' },
      h('h1', { text: 'Loading results' }),
      h('p', { text: 'Preparing the public dashboard.' }),
    )));
    return;
  }

  if (passwordRequired && !state) {
    clear(root, passwordScreen());
    return;
  }

  if (message || !state) {
    clear(root, h('main', { class: 'dashboard-shell' }, dashboardHeader(null), h('section', { class: 'dashboard-empty' },
      h('h1', { text: 'Results unavailable' }),
      h('p', { text: message || 'The public dashboard could not be loaded.' }),
    )));
    return;
  }

  const dashboard = state.dashboard ?? {};
  const awards = (dashboard.awards ?? []).filter((award) => award.status === 'complete');
  clear(root, h('main', { class: 'dashboard-shell' },
    dashboardHeader(state.event),
    heroPanel(state.event, dashboard),
    spotlightPanel(dashboard.nomineeLeaderboard ?? []),
    h('section', { class: 'public-awards' }, awards.map(awardCard)),
    quickestJudgePanel(dashboard.quickestJudgeAward),
  ));
}

function passwordScreen() {
  let unlockButton = null;
  const passwordInput = h('input', {
    class: 'input',
    type: 'password',
    value: passwordDraft,
    autocomplete: 'current-password',
    autofocus: true,
    placeholder: 'Password',
    onInput: (event) => {
      passwordDraft = event.target.value;
      if (unlockButton) unlockButton.disabled = busy || !passwordDraft;
    },
  });
  unlockButton = h('button', { class: 'button', type: 'submit', disabled: busy || !passwordDraft, text: busy ? 'Checking...' : 'Unlock' });
  return h('main', { class: 'dashboard-shell' }, dashboardHeader(null), h('section', { class: 'dashboard-password-panel' },
    h('div', {},
      h('p', { class: 'eyebrow', text: 'Protected dashboard' }),
      h('h1', { text: 'Enter password' }),
      h('p', { text: message || 'This results dashboard is password protected.' }),
    ),
    h('form', { class: 'dashboard-password-form', onSubmit: submitPassword },
      passwordInput,
      unlockButton,
    ),
  ));
}

function submitPassword(event) {
  event.preventDefault();
  if (busy || !passwordDraft) return;
  void loadDashboard(passwordDraft);
}

function dashboardHeader(event) {
  return h('header', { class: 'public-header' },
    h('img', { class: 'public-logo', src: '/brand/logos/criteo-logo-sunrise.svg', alt: 'Criteo' }),
    event?.finishedAt ? h('span', { class: 'public-date', text: finishedDate(event.finishedAt) }) : null,
  );
}

function heroPanel(event, dashboard) {
  const summary = dashboard.summary ?? {};
  return h('section', { class: 'public-hero' },
    h('div', { class: 'public-title' },
      h('p', { class: 'eyebrow', text: 'Final results' }),
      h('h1', { text: event.title }),
      event.subtitle ? h('p', { text: event.subtitle }) : null,
    ),
    h('div', { class: 'public-metrics' },
      metric(`${summary.completedAwards ?? 0}/${summary.awardCount ?? 0}`, 'Awards'),
      metric(formatInteger(summary.totalVotesCast), 'Votes'),
      metric(formatDashboardPercent(summary.averageParticipationRate), 'Avg turnout'),
    ),
  );
}

function metric(value, label) {
  return h('div', { class: 'public-metric' },
    h('strong', { text: value }),
    h('span', { text: label }),
  );
}

function spotlightPanel(rows) {
  const visibleRows = rows.filter((row) => Number(row.votes) > 0 || Number(row.wins) > 0).slice(0, 3);
  return h('section', { class: 'spotlight-panel' },
    h('div', {},
      h('p', { class: 'eyebrow', text: 'Winner board' }),
      h('h2', { text: 'Top finishers' }),
    ),
    visibleRows.length ? h('div', { class: 'spotlight-grid' }, visibleRows.map((row, index) => h('article', { class: `spotlight-card rank-${index + 1}` },
      h('span', { class: 'spotlight-rank', text: `#${index + 1}` }),
      h('strong', { text: row.name }),
      row.subtitle ? h('small', { text: row.subtitle }) : null,
      h('div', { class: 'spotlight-stats' },
        h('span', { text: `${row.wins} win${row.wins === 1 ? '' : 's'}` }),
        h('span', { text: votesText(row.votes) }),
      ),
    ))) : h('p', { class: 'muted', text: 'No winners recorded.' }),
  );
}

function quickestJudgePanel(award) {
  const rows = award?.leaderboard ?? [];
  if (!award || !rows.length) return null;
  return h('section', { class: 'public-quickest-board' },
    h('div', { class: 'public-quickest-head' },
      h('div', {},
        h('p', { class: 'eyebrow', text: 'Special award' }),
        h('h2', { text: award.title ?? 'Quickest to Judge Award' }),
        h('p', { text: `${award.winnerLabel} wins with a ${averageTimeText(award.averageSeconds, award.averageMs)} average.` }),
      ),
      h('div', { class: 'public-quickest-winner' },
        h('span', { text: '#1' }),
        h('strong', { text: award.winnerLabel }),
        h('small', { text: `${averageTimeText(award.averageSeconds, award.averageMs)} avg` }),
      ),
    ),
    h('div', { class: 'public-quickest-list' }, rows.map(quickestRankRow)),
  );
}

function quickestRankRow(row) {
  const hasAverage = row.averageMs !== null && row.averageMs !== undefined && Number.isFinite(Number(row.averageMs));
  return h('div', { class: `public-quickest-row${row.rank === 1 ? ' first' : ''}${hasAverage ? '' : ' no-average'}` },
    h('span', { class: 'public-quickest-rank', text: `#${row.rank}` }),
    h('strong', { text: row.label }),
    h('span', { class: 'public-quickest-time', text: averageTimeText(row.averageSeconds, row.averageMs) }),
    h('small', { text: votesText(row.votesCast) }),
  );
}

function averageTimeText(seconds, milliseconds) {
  const value = Number(seconds);
  if (seconds !== null && seconds !== undefined && Number.isFinite(value)) return `${value.toFixed(1)}s`;
  const fallback = Number(milliseconds);
  if (milliseconds !== null && milliseconds !== undefined && Number.isFinite(fallback)) return `${(fallback / 1000).toFixed(1)}s`;
  return 'No votes';
}

function awardCard(award) {
  return h('article', { class: 'public-award-card' },
    h('div', { class: 'public-award-head' },
      h('div', {},
        h('h2', { text: award.title }),
        award.description ? h('p', { text: award.description }) : null,
      ),
      h('span', { class: 'public-pill', text: resultPillText(award) }),
    ),
    winnerBlock(award),
    awardStats(award),
    resultBars(award.results, award.votesCast),
    excludedNomineesNote(award.excludedNominees),
  );
}

function excludedNomineesNote(excludedNominees) {
  const names = (excludedNominees ?? []).map(formatNomineeName);
  if (!names.length) return null;
  return h('p', { class: 'public-excluded-note', text: `Excluded from option: ${formatNameList(names)}.` });
}

function formatNomineeName(nominee) {
  return nominee.subtitle ? `${nominee.name} (${nominee.subtitle})` : nominee.name;
}

function winnerBlock(award) {
  if (!award.winners?.length) return h('div', { class: 'public-winner empty', text: award.votesCast ? 'No winner revealed' : 'No votes cast' });
  return h('div', { class: 'public-winner' },
    h('span', { text: award.winnerMode === 'joint' ? 'Joint winners' : 'Winner' }),
    h('div', { class: 'public-winner-list' }, award.winners.map((winner) => h('div', {},
      h('strong', { text: winner.name }),
      winner.subtitle ? h('small', { text: winner.subtitle }) : null,
    ))),
  );
}

function awardStats(award) {
  const margin = award.margin === null ? 'No result' : award.winnerMode === 'joint' ? 'Joint' : votesText(award.margin);
  return h('div', { class: 'public-award-stats' },
    stat('Top score', votesText(award.topCount)),
    stat('Margin', margin),
    stat('Turnout', formatDashboardPercent(award.participationRate)),
  );
}

function stat(label, value) {
  return h('div', {}, h('span', { text: label }), h('strong', { text: value }));
}

function resultBars(results, total) {
  const rows = (results ?? []).filter((row) => Number(row.count) > 0).slice(0, 6);
  if (!rows.length) return null;
  const maxCount = Math.max(...rows.map((row) => row.count), 1);
  let previousCount = null;
  let displayRank = 0;
  return h('div', { class: 'public-bars' }, rows.map((row, index) => {
    if (row.count !== previousCount) {
      displayRank = index + 1;
      previousCount = row.count;
    }
    const width = Math.max(0, Math.round((row.count / maxCount) * 100));
    return h('div', { class: `public-bar-row${row.isWinner ? ' winner' : ''}` },
      h('div', { class: 'public-bar-name' },
        h('span', { class: 'public-rank', text: `#${displayRank}` }),
        h('strong', { text: row.name }),
        row.subtitle ? h('small', { text: row.subtitle }) : null,
      ),
      h('div', { class: 'public-bar-track' }, h('div', { class: `public-bar-fill ${barWidthClass(width)}` })),
      h('div', { class: 'public-bar-count' },
        h('strong', { text: row.count }),
        h('small', { text: formatPercent(row.count, total) }),
      ),
    );
  }));
}

function barWidthClass(width) {
  const value = Math.max(0, Math.min(100, Math.round(Number(width) || 0)));
  return `bar-width-${value}`;
}

function formatNameList(names) {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function resultPillText(award) {
  if (award.roundNumber > 1) return `Runoff R${award.roundNumber}`;
  return votesText(award.votesCast);
}

function votesText(value) {
  const count = Number(value) || 0;
  return `${formatInteger(count)} vote${count === 1 ? '' : 's'}`;
}

function formatInteger(value) {
  return (Number(value) || 0).toLocaleString();
}

function formatDashboardPercent(value) {
  return `${Math.round(Number(value) || 0)}%`;
}

function finishedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function friendlyError(error) {
  if (error instanceof ApiError) {
    if (error.status === 403 && passwordRequired) return 'Incorrect dashboard password.';
    if (error.status === 403) return 'This dashboard link is invalid or expired.';
    if (error.code === 'RESULTS_UNAVAILABLE') return error.message;
    return error.message;
  }
  return 'Unable to reach the dashboard.';
}
