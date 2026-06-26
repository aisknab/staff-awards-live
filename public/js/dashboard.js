import { ApiClient, ApiError } from './common/api.js';
import { clear, formatPercent, h } from './common/dom.js';

const root = document.querySelector('#app');
const api = new ApiClient();
let state = null;
let message = '';

void initialise();

async function initialise() {
  const token = readFragment('dashboard');
  if (!token) {
    message = 'Dashboard link unavailable.';
    render();
    return;
  }
  try {
    state = await api.request('/api/dashboard/state', { method: 'POST', body: { token }, csrf: false });
  } catch (error) {
    message = friendlyError(error);
  }
  render();
}

function readFragment(kind) {
  const prefix = `#${kind}/`;
  return location.hash.startsWith(prefix) ? location.hash.slice(prefix.length) : null;
}

function render() {
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
  ));
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
  );
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
      h('div', { class: 'public-bar-track' }, h('div', { class: 'public-bar-fill', style: `--bar-width: ${width}%;` })),
      h('div', { class: 'public-bar-count' },
        h('strong', { text: row.count }),
        h('small', { text: formatPercent(row.count, total) }),
      ),
    );
  }));
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
    if (error.status === 403) return 'This dashboard link is invalid or expired.';
    if (error.code === 'RESULTS_UNAVAILABLE') return error.message;
    return error.message;
  }
  return 'Unable to reach the dashboard.';
}
