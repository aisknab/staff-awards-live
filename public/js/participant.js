import { ApiClient, ApiError } from './common/api.js';
import { clear, formatPercent, h } from './common/dom.js';
import { LiveConnection } from './common/connection.js';
import { playRevealBurst } from './common/reveal-effects.js';

const root = document.querySelector('#app');
const api = new ApiClient();
const REVEAL_COUNTDOWN_MS = 5000;
const SPECIAL_AWARD_COUNTDOWN_MS = 5000;
const SPECIAL_AWARD_VIBRATION = [180, 70, 180, 70, 180, 70, 240, 90, 240, 90, 320];
let state = null;
let connection = null;
let connectionStatus = 'reconnecting';
let message = '';
let busy = false;
let selectedNomineeId = null;
let selectionRoundId = null;
let filterText = '';
const animatedRevealKeys = new Set();
const animatedSpecialAwardKeys = new Set();
const vibratedSpecialAwardKeys = new Set();
let revealCountdown = null;
let countdownTimer = null;
let specialAwardCountdown = null;
let specialAwardTimer = null;

void initialise();

async function initialise() {
  const token = readFragment('join');
  if (token) {
    try {
      state = await api.request('/api/participant/join', { method: 'POST', body: { token }, csrf: false });
      syncSpecialAwardCountdown(null, state.specialAward);
      history.replaceState({}, '', '/');
      connect();
    } catch (error) {
      message = friendlyError(error);
      history.replaceState({}, '', '/');
    }
    render();
    return;
  }
  try {
    state = await api.request('/api/participant/state');
    syncSpecialAwardCountdown(null, state.specialAward);
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
    streamUrl: '/api/participant/stream',
    poll: () => api.request('/api/participant/state'),
    onStatus: (status) => { connectionStatus = status; renderHeaderOnly(); },
    onEvent: (type, payload) => {
      if (type === 'session-revoked') {
        state = null;
        message = 'This participant session has ended.';
        connection?.close();
        clearSpecialAwardCountdown();
      } else if (type === 'snapshot') {
        const previousRound = state?.round;
        const previousSpecialAward = state?.specialAward;
        state = payload;
        api.setCsrf(payload.csrfToken);
        startCountdownForTransition(previousRound, state.round, 'participant');
        syncSpecialAwardCountdown(previousSpecialAward, state.specialAward);
      } else if (type === 'presence' && state) {
        state.progress = payload.progress;
      } else if (type === 'vote-progress' && state?.round?.id === payload.roundId) {
        state.round.maskedTally.votesCast = payload.votesCast;
      } else if (type === 'round-revealed' && state?.round?.id === payload.roundId) {
        startRevealCountdown(revealKeyFromPayload(payload), payload.roundId, 'participant');
      }
      render();
    },
  });
  connection.open();
}

function renderHeaderOnly() {
  const badge = document.querySelector('[data-connection]');
  if (!badge) return;
  badge.className = `pill ${connectionStatus}`;
  badge.textContent = connectionStatus === 'connected' ? 'Live' : 'Reconnecting';
}

function render() {
  if (!state) {
    document.body.classList.remove('quickest-winner-active');
    return renderJoin();
  }
  document.title = `${state.event.title} · Staff Awards`;
  if (state.round?.id !== selectionRoundId) {
    selectionRoundId = state.round?.id ?? null;
    selectedNomineeId = state.round?.ownVote?.nomineeId ?? null;
    filterText = '';
  } else if (!selectedNomineeId && state.round?.ownVote?.nomineeId) {
    selectedNomineeId = state.round.ownVote.nomineeId;
  }
  const winnerShowing = isSpecialAwardWinnerShowing();
  document.body.classList.toggle('quickest-winner-active', winnerShowing);

  const shell = h('main', { class: `participant-shell${winnerShowing ? ' quickest-winner-shell' : ''}` },
    header(),
    message ? h('div', { class: 'error-banner', text: message }) : null,
    screenForState(),
  );
  clear(root, shell);
}

function header() {
  const title = state?.event?.title ?? 'Staff Awards';
  return h('header', { class: 'participant-header' },
    h('div', { class: 'brand-lockup' },
      h('img', { class: 'brand-logo', src: '/brand/logos/criteo-logo-sunrise.svg', alt: 'Criteo' }),
      h('div', { class: 'brand-event' },
        h('div', { class: 'brand-event-title', text: title }),
      ),
    ),
    h('span', { class: `pill ${connectionStatus}`, dataset: { connection: 'true' }, text: connectionStatus === 'connected' ? 'Live' : 'Reconnecting' }),
  );
}

function renderJoin() {
  document.body.classList.remove('quickest-winner-active');
  const form = h('form', { class: 'join-form', onSubmit: joinWithCode },
    h('div', { class: 'field' },
      h('label', { for: 'event-code', text: 'Event code' }),
      h('input', { id: 'event-code', class: 'input code-input', name: 'code', maxlength: '6', autocomplete: 'one-time-code', placeholder: 'K7DM4P', required: true }),
    ),
    h('button', { class: 'button', type: 'submit', disabled: busy, text: busy ? 'Joining…' : 'Join event' }),
  );
  clear(root, h('main', { class: 'participant-shell' },
    h('section', { class: 'card participant-card join-card' },
      h('img', { class: 'join-logo', src: '/brand/logos/criteo-logo-sunrise.svg', alt: 'Criteo' }),
      h('p', { class: 'eyebrow', text: 'Live staff awards' }),
      h('h1', { class: 'title', text: 'Join the vote' }),
      h('p', { class: 'subtitle', text: 'Scan the event QR code or enter the six-character code shown on screen.' }),
      message ? h('div', { class: 'error-banner', text: message }) : null,
      form,
    ),
  ));
}

async function joinWithCode(event) {
  event.preventDefault();
  if (busy) return;
  busy = true;
  message = '';
  renderJoin();
  const code = new FormData(event.currentTarget).get('code');
  try {
    state = await api.request('/api/participant/join', { method: 'POST', body: { code }, csrf: false });
    syncSpecialAwardCountdown(null, state.specialAward);
    connect();
  } catch (error) {
    message = friendlyError(error);
  } finally {
    busy = false;
    render();
  }
}

function screenForState() {
  if (state.specialAward) return specialAwardScreen(state.specialAward);
  if (state.event.status === 'FINISHED') return simpleScreen('Event complete', 'Thanks for voting.');
  const round = state.round;
  if (revealCountdown && revealCountdown.roundId !== round?.id) clearRevealCountdown();
  if (!round) return lobbyScreen();
  if (round.status === 'PREVIEW') return previewScreen(round);
  if (round.status === 'OPEN') return votingScreen(round);
  if (round.status === 'LOCKED') return lockedScreen(round);
  if (['REVEALED', 'COMPLETE'].includes(round.status)) {
    const countdownSeconds = secondsRemainingForReveal(revealKeyFromRound(round));
    if (countdownSeconds) return revealCountdownScreen(round, countdownSeconds);
    return revealScreen(round);
  }
  return simpleScreen('Please wait', 'The controller is preparing the next award.');
}

function lobbyScreen() {
  return h('section', { class: 'card participant-card hero' },
    h('p', { class: 'eyebrow', text: 'You are connected' }),
    h('h1', { class: 'title', text: state.event.title }),
    state.event.subtitle ? h('p', { class: 'subtitle', text: state.event.subtitle }) : null,
    metrics(),
    h('p', { class: 'subtitle', text: 'Waiting for the first award…' }),
  );
}

function previewScreen(round) {
  return h('section', { class: 'card participant-card hero' },
    h('p', { class: 'eyebrow', text: round.roundNumber > 1 ? 'Runoff round' : 'Next award' }),
    h('h1', { class: 'title', text: round.award.title }),
    round.award.description ? h('p', { class: 'subtitle', text: round.award.description }) : null,
    h('div', { class: 'notice-banner', text: 'Voting will open shortly.' }),
  );
}

function votingScreen(round) {
  const search = h('input', {
    class: 'input', type: 'search', placeholder: 'Search nominees', value: filterText,
    onInput: (event) => { filterText = event.target.value; renderNomineeList(round); },
  });
  const list = h('div', { class: 'nominee-list', id: 'nominee-list' });
  const card = h('section', { class: 'card participant-card stack' },
    h('div', {},
      h('p', { class: 'eyebrow', text: round.roundNumber > 1 ? 'Runoff voting' : 'Vote now' }),
      h('h1', { class: 'title', text: round.award.title }),
      round.award.description ? h('p', { class: 'subtitle', text: round.award.description }) : null,
    ),
    round.ownVote ? h('div', { class: 'notice-banner', text: 'Your vote is saved. You can change it until voting closes.' }) : null,
    h('div', { class: 'search-wrap' }, search),
    list,
    h('div', { class: 'vote-footer' },
      h('button', { id: 'vote-submit', class: 'button', type: 'button', disabled: busy || !selectedNomineeId, onClick: () => submitVote(round), text: busy ? 'Saving…' : round.ownVote ? 'Update vote' : 'Submit vote' }),
    ),
    round.ownVote ? maskedResults(round.maskedTally) : h('p', { class: 'muted', text: `${round.maskedTally.votesCast} of ${Math.max(round.maskedTally.eligibleParticipants, state.progress.registeredParticipants)} participants have voted` }),
  );
  queueMicrotask(() => renderNomineeList(round));
  return card;
}

function renderNomineeList(round) {
  const list = document.querySelector('#nominee-list');
  if (!list) return;
  const filter = filterText.trim().toLocaleLowerCase();
  const nominees = round.nominees.filter((nominee) => `${nominee.name} ${nominee.subtitle}`.toLocaleLowerCase().includes(filter));
  clear(list, nominees.length ? nominees.map((nominee) => h('button', {
    class: `nominee-card${selectedNomineeId === nominee.id ? ' selected' : ''}`,
    type: 'button',
    'aria-pressed': selectedNomineeId === nominee.id ? 'true' : 'false',
    onClick: () => { selectedNomineeId = nominee.id; renderNomineeList(round); const submit = document.querySelector('#vote-submit'); if (submit) submit.disabled = false; },
  },
  h('span', {}, h('span', { class: 'nominee-name', text: nominee.name }), nominee.subtitle ? h('span', { class: 'nominee-subtitle', text: nominee.subtitle }) : null),
  h('span', { class: 'nominee-check', 'aria-hidden': 'true' }),
  )) : h('p', { class: 'muted', text: 'No nominees match your search.' }));
}

async function submitVote(round) {
  if (!selectedNomineeId || busy) return;
  busy = true;
  message = '';
  render();
  try {
    state = await api.request('/api/participant/vote', {
      method: 'PUT',
      body: { roundId: round.id, nomineeId: selectedNomineeId, requestId: crypto.randomUUID(), expectedRoundVersion: round.version },
    });
    syncSpecialAwardCountdown(null, state.specialAward);
  } catch (error) {
    message = friendlyError(error);
    if (error.code === 'ROUND_LOCKED' || error.code === 'CONFLICT') {
      try { state = await api.request('/api/participant/state'); syncSpecialAwardCountdown(null, state.specialAward); } catch {}
    }
  } finally {
    busy = false;
    render();
  }
}

function lockedScreen(round) {
  return h('section', { class: 'card participant-card stack' },
    h('div', {}, h('p', { class: 'eyebrow', text: 'Voting closed' }), h('h1', { class: 'title', text: round.award.title })),
    maskedResults(round.maskedTally),
    h('div', { class: 'notice-banner', text: 'The winner is about to be revealed.' }),
  );
}

function revealCountdownScreen(round, seconds) {
  return h('section', { class: 'participant-countdown', role: 'status', 'aria-live': 'assertive' },
    h('p', { class: 'eyebrow', text: 'Winner reveal' }),
    h('h1', { class: 'title', text: round.award.title }),
    h('div', { class: 'countdown-number', text: seconds }),
  );
}

function revealScreen(round) {
  const revealed = round.revealed;
  const winners = revealed?.winners ?? [];
  if (!winners.length) return simpleScreen(round.award.title, 'No votes were cast for this award.');
  const mode = revealed.winnerMode ?? (winners.length > 1 ? 'joint' : 'single');
  const revealKey = revealKeyFromRound(round);
  scheduleRevealAnimation(revealKey, 'participant');
  return h('section', { class: `card participant-card reveal-card winner-burst${mode === 'joint' ? ' joint' : ''}`, dataset: { revealKey } },
    h('div', { class: 'reveal-content' },
      h('p', { class: 'sr-only', 'aria-live': 'polite', text: `${mode === 'joint' ? 'Joint winners' : 'Winner'}: ${winners.map((winner) => winner.name).join(', ')}` }),
      h('p', { class: 'eyebrow', text: mode === 'joint' ? 'Joint winners' : 'Winner' }),
      h('h1', { class: 'title', text: round.award.title }),
      h('div', { class: 'winner-chip-list' }, winners.map((winner) => h('div', { class: 'winner-chip' },
        h('div', { class: 'winner-name', text: winner.name }),
        winner.subtitle ? h('div', { class: 'winner-subtitle', text: winner.subtitle }) : null,
        h('div', { class: 'muted', text: `${winnerVoteCount(winner)} vote${winnerVoteCount(winner) === 1 ? '' : 's'} · ${winnerPercentage(winner, revealed.votesCast)}` }),
      ))),
    ),
  );
}

function specialAwardScreen(award) {
  const countdownSeconds = secondsRemainingForSpecialAward(specialAwardKey(award));
  if (countdownSeconds) return specialAwardCountdownScreen(award, countdownSeconds);
  return award.isWinner ? specialAwardWinnerScreen(award) : specialAwardAudienceScreen(award);
}

function specialAwardCountdownScreen(award, seconds) {
  return h('section', { class: 'participant-countdown special-award-countdown', role: 'status', 'aria-live': 'assertive' },
    h('p', { class: 'eyebrow', text: 'Special award' }),
    h('h1', { class: 'title', text: award.title ?? 'Quickest to Judge Award' }),
    h('div', { class: 'countdown-number', text: seconds }),
  );
}

function specialAwardWinnerScreen(award) {
  const key = specialAwardKey(award);
  scheduleSpecialAwardCelebration(award);
  return h('section', { class: 'participant-card quickest-award-winner winner-burst', dataset: { specialAwardKey: key } },
    h('div', { class: 'reveal-content' },
      h('p', { class: 'sr-only', 'aria-live': 'polite', text: 'You win the quickest to judge award' }),
      h('p', { class: 'eyebrow', text: 'Quickest to judge' }),
      h('h1', { class: 'title', text: 'You win the quickest to judge award' }),
      h('p', { class: 'subtitle', text: specialAwardDetail(award) || 'Fastest average vote time' }),
    ),
  );
}

function specialAwardAudienceScreen(award) {
  return h('section', { class: 'card participant-card hero special-award-card' },
    h('p', { class: 'eyebrow', text: 'Quickest to judge award' }),
    h('h1', { class: 'title', text: `${award.winnerLabel} wins` }),
    h('p', { class: 'subtitle', text: specialAwardDetail(award) || 'Fastest average vote time' }),
  );
}

function specialAwardDetail(award) {
  if (!Number.isFinite(Number(award.averageSeconds))) return '';
  const votes = Number(award.winnerVotesCast ?? 0);
  return `${Number(award.averageSeconds).toFixed(1)}s average across ${votes} vote${votes === 1 ? '' : 's'}`;
}

function isSpecialAwardWinnerShowing() {
  const award = state?.specialAward;
  if (!award?.isWinner) return false;
  return secondsRemainingForSpecialAward(specialAwardKey(award)) === 0;
}

function scheduleSpecialAwardCelebration(award) {
  const key = specialAwardKey(award);
  if (award.isWinner && !vibratedSpecialAwardKeys.has(key)) {
    vibratedSpecialAwardKeys.add(key);
    navigator.vibrate?.(SPECIAL_AWARD_VIBRATION);
  }
  if (!key || animatedSpecialAwardKeys.has(key)) return;
  animatedSpecialAwardKeys.add(key);
  queueMicrotask(() => {
    const node = document.querySelector('[data-special-award-key]');
    if (node?.dataset.specialAwardKey === key) playRevealBurst(node, { variant: 'participant' });
  });
}

function specialAwardKey(award) {
  return award?.key ?? `${award?.type ?? 'special'}:${award?.revealedAt ?? ''}:${award?.winnerLabel ?? ''}`;
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

function syncSpecialAwardCountdown(previousAward, nextAward) {
  if (!nextAward) {
    clearSpecialAwardCountdown();
    return;
  }
  const key = specialAwardKey(nextAward);
  if (previousAward?.key === key && specialAwardCountdown?.key === key) return;
  if (specialAwardCountdown?.key === key) return;
  const remainingMs = specialAwardRemainingMs(nextAward);
  if (remainingMs <= 0) {
    clearSpecialAwardCountdown();
    return;
  }
  clearSpecialAwardCountdown();
  specialAwardCountdown = { key, endsAt: Date.now() + remainingMs };
  specialAwardTimer = window.setInterval(() => {
    if (!specialAwardCountdown) return;
    if (Date.now() >= specialAwardCountdown.endsAt) clearSpecialAwardCountdown();
    render();
  }, 200);
}

function specialAwardRemainingMs(award) {
  const revealedAt = Date.parse(award?.revealedAt);
  if (!Number.isFinite(revealedAt)) return SPECIAL_AWARD_COUNTDOWN_MS;
  const serverTime = Date.parse(award?.serverTime);
  const now = Number.isFinite(serverTime) ? serverTime : Date.now();
  return Math.max(0, revealedAt + SPECIAL_AWARD_COUNTDOWN_MS - now);
}

function secondsRemainingForSpecialAward(key) {
  if (!specialAwardCountdown || specialAwardCountdown.key !== key) return 0;
  const remaining = specialAwardCountdown.endsAt - Date.now();
  if (remaining <= 0) {
    clearSpecialAwardCountdown();
    return 0;
  }
  return Math.max(1, Math.ceil(remaining / 1000));
}

function clearSpecialAwardCountdown() {
  if (specialAwardTimer) window.clearInterval(specialAwardTimer);
  specialAwardTimer = null;
  specialAwardCountdown = null;
}

function scheduleRevealAnimation(revealKey, variant) {
  if (!revealKey || animatedRevealKeys.has(revealKey)) return;
  animatedRevealKeys.add(revealKey);
  queueMicrotask(() => {
    const node = document.querySelector('[data-reveal-key]');
    if (node?.dataset.revealKey === revealKey) playRevealBurst(node, { variant });
  });
}

function maskedResults(tally) {
  const statusText = {
    NO_VOTES: 'No votes yet', TOO_EARLY: 'Results appear after the first few votes', TIED: 'The top result is tied', VERY_CLOSE: 'The race is very close', LEADER_EMERGING: 'A leader is emerging', CLEAR_LEADER: 'There is currently a clear leader',
  }[tally.leaderStatus] ?? '';
  if (!tally.counts?.length) return h('div', { class: 'stack' }, h('p', { class: 'muted', text: statusText }), h('p', { class: 'muted', text: `${tally.votesCast} votes submitted` }));
  const max = Math.max(...tally.counts, 1);
  const labels = ['Leader', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];
  return h('div', { class: 'stack' },
    h('div', { class: 'row between' }, h('strong', { text: 'Anonymous live results' }), h('span', { class: 'muted', text: statusText })),
    h('div', { class: 'tally' }, tally.counts.slice(0, 6).map((count, index) => h('div', { class: 'tally-row' },
      h('span', { class: 'tally-label', text: labels[index] ?? `#${index + 1}` }),
      h('progress', { class: 'tally-progress', max: String(max), value: String(count), 'aria-label': `${count} votes` }),
      h('span', { class: 'tally-count', text: count }),
    ))),
    h('p', { class: 'muted', text: `${tally.votesCast} votes submitted. Bars are deliberately not linked to nominee names.` }),
  );
}

function metrics() {
  return h('div', { class: 'status-grid' },
    h('div', { class: 'metric' }, h('strong', { text: state.progress.connectedParticipants ?? 0 }), h('span', { text: 'Connected now' })),
    h('div', { class: 'metric' }, h('strong', { text: state.progress.registeredParticipants ?? 0 }), h('span', { text: 'Joined event' })),
  );
}

function simpleScreen(title, subtitle) {
  return h('section', { class: 'card participant-card hero' }, h('h1', { class: 'title', text: title }), h('p', { class: 'subtitle', text: subtitle }));
}

function friendlyError(error) {
  if (error instanceof ApiError) {
    const map = {
      JOIN_CLOSED: 'Joining is currently closed.',
      PARTICIPANT_LIMIT_REACHED: 'This event has reached its participant limit.',
      ROUND_LOCKED: 'Voting has closed.',
      RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
      UNAUTHENTICATED: 'Your session has expired. Scan the QR code again.',
    };
    return map[error.code] ?? error.message;
  }
  return 'Unable to reach the event server.';
}
