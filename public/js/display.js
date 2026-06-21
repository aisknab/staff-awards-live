import { ApiClient, ApiError } from './common/api.js';
import { clear, formatPercent, h } from './common/dom.js';
import { LiveConnection } from './common/connection.js';

const root = document.querySelector('#app');
const api = new ApiClient();
let state = null;
let connection = null;
let connectionStatus = 'reconnecting';
let message = '';

void initialise();

async function initialise() {
  const token = readFragment('display');
  if (token) {
    try {
      state = await api.request('/api/display/join', { method: 'POST', body: { token }, csrf: false });
      history.replaceState({}, '', '/display');
      connect();
    } catch (error) {
      message = friendlyError(error);
      history.replaceState({}, '', '/display');
    }
    render();
    return;
  }
  try {
    state = await api.request('/api/display/state');
    connect();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) message = friendlyError(error);
  }
  render();
}

function readFragment(kind) {
  const prefix = `#${kind}/`;
  return location.hash.startsWith(prefix) ? location.hash.slice(prefix.length) : null;
}

function connect() {
  connection?.close();
  connection = new LiveConnection({
    streamUrl: '/api/display/stream',
    poll: () => api.request('/api/display/state'),
    onStatus: (status) => { connectionStatus = status; renderStatus(); },
    onEvent: (type, payload) => {
      if (type === 'session-revoked') {
        state = null;
        message = 'This display link was rotated. Open the new display URL from the controller.';
        connection?.close();
      } else if (type === 'snapshot') {
        state = payload;
      } else if (type === 'presence' && state) {
        state.progress = payload.progress;
      } else if (type === 'vote-progress' && state?.round?.id === payload.roundId) {
        state.round.maskedTally.votesCast = payload.votesCast;
      }
      render();
    },
  });
  connection.open();
}

function renderStatus() {
  const node = document.querySelector('[data-display-status]');
  if (!node) return;
  node.className = `pill ${connectionStatus}`;
  node.textContent = connectionStatus === 'connected' ? 'Live' : 'Reconnecting';
}

function render() {
  if (!state) {
    clear(root, h('main', { class: 'display-screen' },
      h('div'),
      h('section', { class: 'display-main' }, h('div', { class: 'display-panel' },
        h('p', { class: 'display-kicker', text: 'Presentation display' }),
        h('h1', { class: 'display-title', text: 'Open the display link' }),
        h('p', { class: 'display-subtitle', text: message || 'Use the private display URL or QR code shown in the controller.' }),
      )),
      h('div'),
    ));
    return;
  }
  document.title = `${state.event.title} · Display`;
  if (state.event.displayBlanked) {
    clear(root, h('div', { class: 'blank-screen', 'aria-label': 'Display blanked' }));
    return;
  }

  const content = contentForState();
  clear(root,
    h('button', { class: 'button secondary small fullscreen-button', type: 'button', onClick: toggleFullscreen, text: 'Fullscreen' }),
    h('main', { class: 'display-screen' },
      h('header', { class: 'display-header' },
        h('div', { class: 'display-brand', text: state.event.title }),
        h('span', { class: `pill ${connectionStatus}`, dataset: { displayStatus: 'true' }, text: connectionStatus === 'connected' ? 'Live' : 'Reconnecting' }),
      ),
      h('section', { class: 'display-main' }, content),
      footer(),
    ),
  );
}

function contentForState() {
  if (state.event.status === 'FINISHED') return panel('Event complete', 'Thanks for taking part.');
  if (!state.round) return lobby();
  const round = state.round;
  if (round.status === 'PREVIEW') return panel(round.award.title, round.award.description || 'Voting will open shortly.', round.roundNumber > 1 ? 'Runoff round' : 'Next award');
  if (round.status === 'OPEN') return voting(round, false);
  if (round.status === 'LOCKED') return voting(round, true);
  if (['REVEALED', 'COMPLETE'].includes(round.status)) return reveal(round);
  return panel('Please wait', 'The controller is preparing the next award.');
}

function lobby() {
  return h('div', { class: 'display-panel lobby-grid' },
    h('div', {},
      h('p', { class: 'display-kicker', text: 'Scan to join' }),
      h('h1', { class: 'display-title', text: state.event.title }),
      state.event.subtitle ? h('p', { class: 'display-subtitle', text: state.event.subtitle }) : null,
      h('p', { class: 'display-subtitle', text: 'Or enter this code at the event URL:' }),
      h('div', { class: 'manual-code', text: state.join.manualCode }),
    ),
    h('div', { class: 'qr-wrap' }, h('img', { src: `${state.join.qrUrl}?v=${state.event.version}`, alt: 'Participant join QR code' })),
  );
}

function voting(round, locked) {
  const tally = round.maskedTally;
  return h('div', { class: 'display-panel' },
    h('p', { class: 'display-kicker', text: locked ? 'Voting closed' : round.roundNumber > 1 ? 'Runoff voting' : 'Vote now' }),
    h('h1', { class: 'display-title', text: round.award.title }),
    round.award.description ? h('p', { class: 'display-subtitle', text: round.award.description }) : null,
    displayTally(tally),
    locked ? h('p', { class: 'display-subtitle', text: 'Winner about to be revealed…' }) : null,
  );
}

function displayTally(tally) {
  const statusText = {
    NO_VOTES: 'Waiting for the first votes', TOO_EARLY: 'Results appear after the first few votes', TIED: 'The top result is tied', VERY_CLOSE: 'The race is very close', LEADER_EMERGING: 'A leader is emerging', CLEAR_LEADER: 'There is a clear leader',
  }[tally.leaderStatus] ?? '';
  if (!tally.counts?.length) return h('div', { class: 'display-tally' }, h('p', { class: 'display-subtitle', text: statusText }));
  const max = Math.max(...tally.counts, 1);
  const labels = ['Leader', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];
  return h('div', { class: 'display-tally tally' },
    tally.counts.slice(0, 10).map((count, index) => h('div', { class: 'tally-row' },
      h('span', { class: 'tally-label', text: labels[index] ?? `#${index + 1}` }),
      h('progress', { class: 'tally-progress', max: String(max), value: String(count), 'aria-label': `${count} votes` }),
      h('span', { class: 'tally-count', text: count }),
    )),
    h('p', { class: 'display-subtitle', text: statusText }),
  );
}

function reveal(round) {
  const revealed = round.revealed;
  const winners = revealed?.winners ?? [];
  if (!winners.length) return panel(round.award.title, 'No votes were cast for this award.', 'Result');
  return h('div', { class: 'display-panel display-winner' },
    h('p', { class: 'display-kicker', text: winners.length > 1 ? 'Joint winners' : 'Winner' }),
    h('p', { class: 'display-subtitle', text: round.award.title }),
    winners.map((winner) => h('div', {},
      h('h1', { class: 'display-title', text: winner.name }),
      winner.subtitle ? h('p', { class: 'display-subtitle', text: winner.subtitle }) : null,
      h('p', { class: 'display-subtitle', text: `${winner.count} vote${winner.count === 1 ? '' : 's'} · ${formatPercent(winner.count, revealed.votesCast)}` }),
    )),
  );
}

function panel(title, subtitle, kicker = 'Staff awards') {
  return h('div', { class: 'display-panel' },
    h('p', { class: 'display-kicker', text: kicker }),
    h('h1', { class: 'display-title', text: title }),
    subtitle ? h('p', { class: 'display-subtitle', text: subtitle }) : null,
  );
}

function footer() {
  return h('footer', { class: 'display-footer' },
    h('div', { class: 'display-metrics' },
      h('div', { class: 'display-metric' }, h('strong', { text: state.progress.connectedParticipants ?? 0 }), h('span', { text: 'connected' })),
      h('div', { class: 'display-metric' }, h('strong', { text: state.round?.maskedTally?.votesCast ?? 0 }), h('span', { text: 'votes' })),
    ),
    h('div', { text: 'Live counts are anonymous until reveal' }),
  );
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {}
}

function friendlyError(error) {
  if (error instanceof ApiError) return error.message;
  return 'Unable to reach the event server.';
}
