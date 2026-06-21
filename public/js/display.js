import { ApiClient, ApiError } from './common/api.js';
import { clear, formatPercent, h } from './common/dom.js';
import { LiveConnection } from './common/connection.js';
import { playRevealBurst } from './common/reveal-effects.js';

const root = document.querySelector('#app');
const api = new ApiClient();
const REVEAL_COUNTDOWN_MS = 5000;
let state = null;
let connection = null;
let connectionStatus = 'reconnecting';
let message = '';
const animatedRevealKeys = new Set();
let revealCountdown = null;
let countdownTimer = null;

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
        const previousRound = state?.round;
        state = payload;
        startCountdownForTransition(previousRound, state.round, 'display');
      } else if (type === 'presence' && state) {
        state.progress = payload.progress;
      } else if (type === 'vote-progress' && state?.round?.id === payload.roundId) {
        state.round.maskedTally.votesCast = payload.votesCast;
      } else if (type === 'round-revealed' && state?.round?.id === payload.roundId) {
        startRevealCountdown(revealKeyFromPayload(payload), payload.roundId, 'display');
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
  const round = state.round;
  if (revealCountdown && revealCountdown.roundId !== round?.id) clearRevealCountdown();
  if (!round) return lobby();
  if (round.status === 'PREVIEW') return panel(round.award.title, round.award.description || 'Voting will open shortly.', round.roundNumber > 1 ? 'Runoff round' : 'Next award');
  if (round.status === 'OPEN') return voting(round, false);
  if (round.status === 'LOCKED') return voting(round, true);
  if (['REVEALED', 'COMPLETE'].includes(round.status)) {
    const countdownSeconds = secondsRemainingForReveal(revealKeyFromRound(round));
    if (countdownSeconds) return revealCountdownPanel(round, countdownSeconds);
    return reveal(round);
  }
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

function revealCountdownPanel(round, seconds) {
  return h('div', { class: 'display-panel display-countdown', role: 'status', 'aria-live': 'assertive' },
    h('p', { class: 'display-kicker', text: 'Winner reveal' }),
    h('p', { class: 'display-subtitle', text: round.award.title }),
    h('div', { class: 'display-countdown-number', text: seconds }),
  );
}

function reveal(round) {
  const revealed = round.revealed;
  const winners = revealed?.winners ?? [];
  if (!winners.length) return panel(round.award.title, 'No votes were cast for this award.', 'Result');
  const mode = revealed.winnerMode ?? (winners.length > 1 ? 'joint' : 'single');
  const revealKey = revealKeyFromRound(round);
  scheduleRevealAnimation(revealKey, 'display');
  return h('div', { class: `display-panel display-winner winner-burst${mode === 'joint' ? ' joint' : ''}`, dataset: { revealKey } },
    h('div', { class: 'reveal-content' },
      h('p', { class: 'sr-only', 'aria-live': 'polite', text: `${mode === 'joint' ? 'Joint winners' : 'Winner'}: ${winners.map((winner) => winner.name).join(', ')}` }),
      h('p', { class: 'display-kicker', text: mode === 'joint' ? 'Joint winners' : 'Winner' }),
      h('p', { class: 'display-subtitle award-title', text: round.award.title }),
      h('div', { class: 'display-winner-list' }, winners.map((winner) => h('div', { class: 'display-winner-card' },
        h('h1', { class: 'display-winner-name', text: winner.name }),
        winner.subtitle ? h('p', { class: 'display-winner-meta', text: winner.subtitle }) : null,
        h('p', { class: 'display-winner-meta', text: `${winnerVoteCount(winner)} vote${winnerVoteCount(winner) === 1 ? '' : 's'} · ${winnerPercentage(winner, revealed.votesCast)}` }),
      ))),
    ),
  );
}

function winnerVoteCount(winner) {
  return winner.voteCount ?? winner.count ?? 0;
}

function winnerPercentage(winner, votesCast) {
  return Number.isFinite(winner.percentage) ? `${winner.percentage}%` : formatPercent(winnerVoteCount(winner), votesCast);
}

function revealKeyFromRound(round) {
  const winners = round.revealed?.winners ?? [];
  return `${round.id}:${round.revealed?.winnerMode ?? winners.length}:${winners.map((winner) => winner.nomineeId).join(',')}`;
}

function revealKeyFromPayload(payload) {
  return `${payload.roundId}:${payload.winnerMode ?? payload.winners?.length ?? 0}:${(payload.winners ?? []).map((winner) => winner.nomineeId).join(',')}`;
}

function startCountdownForTransition(previousRound, nextRound, variant) {
  if (!nextRound || !['REVEALED', 'COMPLETE'].includes(nextRound.status)) return;
  if (previousRound?.id !== nextRound.id || ['REVEALED', 'COMPLETE'].includes(previousRound?.status)) return;
  startRevealCountdown(revealKeyFromRound(nextRound), nextRound.id, variant);
}

function startRevealCountdown(revealKey, roundId, variant) {
  if (!revealKey || !roundId || animatedRevealKeys.has(revealKey)) return;
  if (revealCountdown?.key === revealKey) return;
  clearRevealCountdown();
  revealCountdown = { key: revealKey, roundId, variant, endsAt: Date.now() + REVEAL_COUNTDOWN_MS };
  countdownTimer = window.setInterval(() => {
    if (!revealCountdown) return;
    if (Date.now() >= revealCountdown.endsAt) clearRevealCountdown();
    render();
  }, 200);
}

function secondsRemainingForReveal(revealKey) {
  if (!revealCountdown || revealCountdown.key !== revealKey) return 0;
  const remaining = revealCountdown.endsAt - Date.now();
  if (remaining <= 0) {
    clearRevealCountdown();
    return 0;
  }
  return Math.max(1, Math.ceil(remaining / 1000));
}

function clearRevealCountdown() {
  if (countdownTimer) window.clearInterval(countdownTimer);
  countdownTimer = null;
  revealCountdown = null;
}

function scheduleRevealAnimation(revealKey, variant) {
  if (!revealKey || animatedRevealKeys.has(revealKey)) return;
  animatedRevealKeys.add(revealKey);
  queueMicrotask(() => {
    const node = document.querySelector('[data-reveal-key]');
    if (node?.dataset.revealKey === revealKey) playRevealBurst(node, { variant });
  });
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
