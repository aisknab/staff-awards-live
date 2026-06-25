import { ApiClient, ApiError } from './common/api.js';
import { clear, copyText, formatPercent, h } from './common/dom.js';
import { LiveConnection } from './common/connection.js';

const root = document.querySelector('#app');
const api = new ApiClient();
let appState = null;
let authenticated = false;
let connection = null;
let connectionStatus = 'reconnecting';
let message = '';
let busy = false;
let hideTally = false;
let draft = null;
let creatingNew = false;
let editingDetails = false;
let detailsDraft = null;
let selectedPeopleListId = '';
let peopleListName = '';

void initialise();

async function initialise() {
  try {
    appState = await api.request('/api/admin/state');
    authenticated = true;
    if (appState.selectedEventId) connect(appState.selectedEventId);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) message = friendlyError(error);
  }
  render();
}

function connect(eventId) {
  connection?.close();
  connection = new LiveConnection({
    streamUrl: `/api/admin/stream?eventId=${encodeURIComponent(eventId)}`,
    poll: () => api.request(`/api/admin/state?eventId=${encodeURIComponent(eventId)}`),
    onStatus: (status) => { connectionStatus = status; renderConnectionBadge(); },
    onEvent: (type, payload) => {
      if (type === 'snapshot') {
        appState = payload;
        api.setCsrf(payload.csrfToken);
      } else if (type === 'presence' && appState) {
        appState.progress = payload.progress;
      } else if (type === 'session-revoked') {
        authenticated = false;
        appState = null;
        connection?.close();
        message = 'Your admin session has ended.';
      }
      render();
    },
  });
  connection.open();
}

function renderConnectionBadge() {
  const badge = document.querySelector('[data-admin-connection]');
  if (!badge) return;
  badge.className = `pill ${connectionStatus}`;
  badge.textContent = connectionStatus === 'connected' ? 'Live' : 'Reconnecting';
}

function render() {
  if (!authenticated) return renderLogin();
  const isConfigMode = creatingNew || !appState?.event || appState.event.status === 'DRAFT';
  if (isConfigMode) {
    ensureDraft();
    editingDetails = false;
    detailsDraft = null;
  } else {
    draft = null;
    if (editingDetails) ensureDetailsDraft();
    else detailsDraft = null;
  }

  const shell = h('main', { class: 'admin-shell' },
    adminHeader(),
    message ? h('div', { class: 'error-banner', text: message }) : null,
    eventToolbar(),
    isConfigMode ? configEditor() : liveController(),
  );
  clear(root, shell);
}

function renderLogin() {
  const form = h('form', { class: 'stack', onSubmit: login },
    h('div', { class: 'field' }, h('label', { for: 'username', text: 'Username' }), h('input', { id: 'username', class: 'input', name: 'username', autocomplete: 'username', value: 'admin', required: true })),
    h('div', { class: 'field' }, h('label', { for: 'password', text: 'Password' }), h('input', { id: 'password', class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
    h('button', { class: 'button', type: 'submit', disabled: busy, text: busy ? 'Signing in…' : 'Sign in' }),
  );
  clear(root, h('main', { class: 'login-wrap' }, h('section', { class: 'card login-card stack' },
    h('img', { class: 'login-logo', src: '/brand/logos/criteo-logo-sunrise.svg', alt: 'Criteo' }),
    h('div', {}, h('p', { class: 'eyebrow', text: 'Controller access' }), h('h1', { class: 'title', text: 'Staff Awards' }), h('p', { class: 'subtitle', text: 'Sign in to configure and run the event.' })),
    message ? h('div', { class: 'error-banner', text: message }) : null,
    form,
  )));
}

async function login(event) {
  event.preventDefault();
  if (busy) return;
  busy = true;
  message = '';
  renderLogin();
  const form = new FormData(event.currentTarget);
  try {
    appState = await api.request('/api/admin/login', { method: 'POST', body: { username: form.get('username'), password: form.get('password') }, csrf: false });
    authenticated = true;
    if (appState.selectedEventId) connect(appState.selectedEventId);
  } catch (error) {
    message = friendlyError(error);
  } finally {
    busy = false;
    render();
  }
}

function adminHeader() {
  return h('header', { class: 'admin-header' },
    h('div', { class: 'brand-lockup' },
      h('img', { class: 'brand-logo', src: '/brand/logos/criteo-logo-sunrise.svg', alt: 'Criteo' }),
      h('div', { class: 'brand-event' },
        h('div', { class: 'admin-title brand-event-title', text: 'Staff Awards Controller' }),
        h('div', { class: 'brand-event-subtitle', text: appState?.event?.title ?? 'No event selected' }),
      ),
    ),
    h('div', { class: 'row' },
      appState?.selectedEventId ? h('span', { class: `pill ${connectionStatus}`, dataset: { adminConnection: 'true' }, text: connectionStatus === 'connected' ? 'Live' : 'Reconnecting' }) : null,
      h('button', { class: 'button ghost small', type: 'button', onClick: logout, text: 'Sign out' }),
    ),
  );
}

function eventToolbar() {
  const select = h('select', { class: 'select', onChange: selectEvent },
    h('option', { value: '', text: 'Select an event' }),
    ...(appState?.events ?? []).map((event) => h('option', { value: event.id, selected: !creatingNew && event.id === appState.selectedEventId, text: `${event.title} · ${event.status}` })),
  );
  return h('section', { class: 'card admin-toolbar' },
    h('div', { class: 'field' }, h('label', { text: 'Event' }), select),
    h('button', { class: 'button secondary', type: 'button', onClick: newEvent, text: 'New event' }),
    appState?.event && !creatingNew && appState.event.status !== 'DRAFT' ? h('button', { class: 'button secondary', type: 'button', disabled: editingDetails, onClick: editEventDetails, text: 'Edit details' }) : null,
    appState?.event && !creatingNew ? h('a', { class: 'button secondary', href: `/api/admin/export.csv?eventId=${encodeURIComponent(appState.event.id)}`, text: 'Export CSV' }) : null,
  );
}

async function selectEvent(event) {
  const eventId = event.target.value;
  if (!eventId) return;
  creatingNew = false;
  draft = null;
  editingDetails = false;
  detailsDraft = null;
  selectedPeopleListId = '';
  peopleListName = '';
  message = '';
  try {
    appState = await api.request(`/api/admin/state?eventId=${encodeURIComponent(eventId)}`);
    connect(eventId);
  } catch (error) {
    message = friendlyError(error);
  }
  render();
}

function newEvent() {
  creatingNew = true;
  connection?.close();
  draft = emptyDraft();
  editingDetails = false;
  detailsDraft = null;
  selectedPeopleListId = '';
  peopleListName = '';
  message = '';
  render();
}

function ensureDraft() {
  if (draft) return;
  draft = creatingNew || !appState?.event ? emptyDraft() : draftFromEvent(appState.event);
}

function emptyDraft() {
  return {
    eventId: null,
    expectedEventVersion: null,
    title: '',
    subtitle: '',
    participantLimit: 30,
    nomineeText: '',
    awards: [{ title: 'Mr Mute', description: 'The person most likely to deliver their best point while still on mute', eligibleKeys: new Set() }],
  };
}

function draftFromEvent(event) {
  const idToKey = new Map(event.nominees.map((nominee, index) => [nominee.id, `nominee-${index + 1}`]));
  return {
    eventId: event.id,
    expectedEventVersion: event.version,
    title: event.title,
    subtitle: event.subtitle,
    participantLimit: event.participantLimit,
    nomineeText: event.nominees.map((nominee) => `${nominee.displayName}${nominee.subtitle ? ` | ${nominee.subtitle}` : ''}`).join('\n'),
    awards: event.awards.map((award) => ({
      title: award.title,
      description: award.description,
      eligibleKeys: new Set(award.eligibleNomineeIds.map((id) => idToKey.get(id)).filter(Boolean)),
    })),
  };
}

function parsedNominees() {
  return draft.nomineeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const [name, ...subtitleParts] = line.split('|');
    return { key: `nominee-${index + 1}`, displayName: name.trim(), subtitle: subtitleParts.join('|').trim() };
  });
}

function configEditor() {
  const isNewEvent = creatingNew || !appState?.event;
  const nominees = parsedNominees();
  const section = h('section', { class: 'card admin-card stack' },
    h('div', { class: 'row between' },
      h('div', {}, h('p', { class: 'eyebrow', text: isNewEvent ? 'New event' : 'Draft event' }), h('h1', { class: 'title', text: isNewEvent ? 'Configure event' : draft.title || 'Configure event' })),
      !creatingNew && appState?.event ? h('button', { class: 'button', type: 'button', disabled: busy, onClick: () => action('OPEN_LOBBY'), text: 'Open lobby' }) : null,
    ),
    h('div', { class: 'config-grid' },
      h('div', { class: 'stack' },
        field('Event title', h('input', { class: 'input', value: draft.title, maxlength: '100', onInput: (event) => { draft.title = event.target.value; } })),
        field('Subtitle', h('input', { class: 'input', value: draft.subtitle, maxlength: '200', onInput: (event) => { draft.subtitle = event.target.value; } })),
        field('Participant limit', h('input', { class: 'input', type: 'number', min: '2', max: '250', value: draft.participantLimit, onInput: (event) => { draft.participantLimit = Number(event.target.value); } })),
        peopleListControls(),
        field('Nominees', h('textarea', {
          class: 'textarea', value: draft.nomineeText, placeholder: 'Alex Smith | Sales\nCharlie Lee | Engineering',
          onInput: (event) => { draft.nomineeText = event.target.value; },
          onChange: () => {
            selectAllAwardNominees();
            setTimeout(render, 0);
          },
        })),
        h('p', { class: 'muted', text: 'Enter one nominee per line. Add an optional team after a vertical bar.' }),
      ),
      h('div', { class: 'stack' },
        h('div', { class: 'row between' }, h('h2', { text: 'Awards' }), h('button', { class: 'button secondary small', type: 'button', onClick: addAward, text: 'Add award' })),
        h('div', { class: 'award-editor-list' }, draft.awards.map((award, index) => awardEditor(award, index, nominees))),
      ),
    ),
    h('div', { class: 'row' },
      h('button', { class: 'button', type: 'button', disabled: busy, onClick: saveDraft, text: busy ? 'Saving…' : 'Save configuration' }),
      h('span', { class: 'muted', text: `${nominees.length} nominees · ${draft.awards.length} awards` }),
    ),
  );
  return section;
}

function field(label, control) {
  return h('div', { class: 'field' }, h('label', { text: label }), control);
}

function peopleListControls() {
  const lists = appState?.peopleLists ?? [];
  return h('div', { class: 'people-list-tools' },
    field('Saved people list', h('select', { class: 'select', onChange: selectPeopleList },
      h('option', { value: '', selected: !selectedPeopleListId, text: lists.length ? 'Choose a list' : 'No saved lists' }),
      ...lists.map((list) => h('option', { value: list.id, selected: list.id === selectedPeopleListId, text: `${list.name} · ${list.entries.length}` })),
    )),
    field('List name', h('input', { class: 'input', value: peopleListName, maxlength: '100', placeholder: 'All staff', onInput: (event) => { peopleListName = event.target.value; } })),
    h('div', { class: 'people-list-buttons' },
      h('button', { class: 'button secondary small', type: 'button', disabled: !selectedPeopleListId || busy, onClick: loadSelectedPeopleList, text: 'Load' }),
      h('button', { class: 'button small', type: 'button', disabled: busy, onClick: savePeopleList, text: selectedPeopleListId ? 'Update list' : 'Save list' }),
      h('button', { class: 'button ghost small', type: 'button', disabled: busy, onClick: clearPeopleListSelection, text: 'New list' }),
      h('button', { class: 'button danger small', type: 'button', disabled: !selectedPeopleListId || busy, onClick: deleteSelectedPeopleList, text: 'Delete' }),
    ),
  );
}

function selectPeopleList(event) {
  selectedPeopleListId = event.target.value;
  const list = selectedPeopleList();
  peopleListName = list?.name ?? '';
  render();
}

function selectedPeopleList() {
  return (appState?.peopleLists ?? []).find((list) => list.id === selectedPeopleListId) ?? null;
}

function nomineeLine(entry) {
  return `${entry.displayName}${entry.subtitle ? ` | ${entry.subtitle}` : ''}`;
}

function selectAllAwardNominees() {
  const keys = parsedNominees().map((nominee) => nominee.key);
  for (const award of draft.awards) award.eligibleKeys = new Set(keys);
}

function loadSelectedPeopleList() {
  const list = selectedPeopleList();
  if (!list) return;
  const nextText = list.entries.map(nomineeLine).join('\n');
  if (draft.nomineeText.trim() && draft.nomineeText.trim() !== nextText.trim() && !confirm(`Replace the current nominees with "${list.name}"?`)) return;
  draft.nomineeText = nextText;
  peopleListName = list.name;
  selectAllAwardNominees();
  render();
}

function clearPeopleListSelection() {
  selectedPeopleListId = '';
  peopleListName = '';
  render();
}

async function savePeopleList() {
  if (busy) return;
  const entries = parsedNominees().map((nominee) => ({ displayName: nominee.displayName, subtitle: nominee.subtitle }));
  if (!entries.length) {
    message = 'Add at least one person before saving a list.';
    render();
    return;
  }
  busy = true;
  message = '';
  render();
  try {
    appState = await api.request('/api/admin/people-lists', {
      method: 'PUT',
      body: {
        eventId: draft.eventId ?? appState?.selectedEventId ?? null,
        listId: selectedPeopleListId || null,
        name: peopleListName,
        entries,
      },
    });
    const saved = (appState.peopleLists ?? []).find((list) => list.id === selectedPeopleListId)
      ?? (appState.peopleLists ?? []).find((list) => list.name.toLocaleLowerCase() === peopleListName.trim().toLocaleLowerCase());
    selectedPeopleListId = saved?.id ?? '';
    peopleListName = saved?.name ?? peopleListName;
    message = 'People list saved.';
  } catch (error) {
    message = friendlyError(error);
  } finally {
    busy = false;
    render();
  }
}

async function deleteSelectedPeopleList() {
  if (busy) return;
  const list = selectedPeopleList();
  if (!list || !confirm(`Delete "${list.name}"? Events already saved will not change.`)) return;
  busy = true;
  message = '';
  render();
  try {
    appState = await api.request('/api/admin/people-lists', {
      method: 'DELETE',
      body: { eventId: draft.eventId ?? appState?.selectedEventId ?? null, listId: list.id },
    });
    selectedPeopleListId = '';
    peopleListName = '';
    message = 'People list deleted.';
  } catch (error) {
    message = friendlyError(error);
  } finally {
    busy = false;
    render();
  }
}

function awardEditor(award, index, nominees) {
  if (award.eligibleKeys.size === 0 && nominees.length) award.eligibleKeys = new Set(nominees.map((nominee) => nominee.key));
  return h('article', { class: 'award-editor' },
    h('div', { class: 'award-editor-head' },
      h('strong', { text: `Award ${index + 1}` }),
      h('div', { class: 'row' },
        h('button', { class: 'button ghost small', type: 'button', disabled: index === 0, onClick: () => { [draft.awards[index - 1], draft.awards[index]] = [draft.awards[index], draft.awards[index - 1]]; render(); }, text: 'Up' }),
        h('button', { class: 'button ghost small', type: 'button', disabled: index === draft.awards.length - 1, onClick: () => { [draft.awards[index + 1], draft.awards[index]] = [draft.awards[index], draft.awards[index + 1]]; render(); }, text: 'Down' }),
        h('button', { class: 'button danger small', type: 'button', disabled: draft.awards.length === 1, onClick: () => { draft.awards.splice(index, 1); render(); }, text: 'Remove' }),
      ),
    ),
    h('div', { class: 'stack' },
      field('Title', h('input', { class: 'input', value: award.title, maxlength: '100', onInput: (event) => { award.title = event.target.value; } })),
      field('Description', h('textarea', { class: 'textarea', value: award.description, maxlength: '500', onInput: (event) => { award.description = event.target.value; } })),
      h('div', { class: 'field' },
        h('div', { class: 'row between' }, h('label', { text: 'Eligible nominees' }), h('button', { class: 'button ghost small', type: 'button', onClick: () => { award.eligibleKeys = new Set(nominees.map((nominee) => nominee.key)); render(); }, text: 'Select all' })),
        h('div', { class: 'nominee-checks' }, nominees.length ? nominees.map((nominee) => h('label', {},
          h('input', { type: 'checkbox', checked: award.eligibleKeys.has(nominee.key), onChange: (event) => { if (event.target.checked) award.eligibleKeys.add(nominee.key); else award.eligibleKeys.delete(nominee.key); } }),
          h('span', { text: nominee.subtitle ? `${nominee.displayName} · ${nominee.subtitle}` : nominee.displayName }),
        )) : h('span', { class: 'muted', text: 'Add nominees first.' })),
      ),
    ),
  );
}

function addAward() {
  const keys = parsedNominees().map((nominee) => nominee.key);
  draft.awards.push({ title: '', description: '', eligibleKeys: new Set(keys) });
  render();
}

async function saveDraft() {
  if (busy) return;
  const nominees = parsedNominees();
  const payload = {
    eventId: draft.eventId,
    expectedEventVersion: draft.expectedEventVersion,
    title: draft.title,
    subtitle: draft.subtitle,
    participantLimit: Number(draft.participantLimit),
    nominees,
    awards: draft.awards.map((award) => ({ title: award.title, description: award.description, eligibleNomineeKeys: [...award.eligibleKeys] })),
  };
  busy = true;
  message = '';
  render();
  try {
    appState = await api.request('/api/admin/event-config', { method: 'PUT', body: payload });
    creatingNew = false;
    draft = null;
    connect(appState.selectedEventId);
  } catch (error) {
    message = friendlyError(error);
  } finally {
    busy = false;
    render();
  }
}

function liveController() {
  const event = appState.event;
  const round = event.currentRound;
  return h('div', { class: 'admin-grid' },
    h('div', { class: 'stack' },
      h('section', { class: 'card admin-card stack' },
        h('div', { class: 'row between' },
          h('div', {}, h('p', { class: 'eyebrow', text: `${event.status} · version ${event.version}` }), h('h1', { class: 'title', text: round?.award?.title ?? event.title }), round?.award?.description ? h('p', { class: 'subtitle', text: round.award.description }) : null),
          round ? h('span', { class: 'pill connected', text: round.status }) : null,
        ),
        metrics(),
        h('div', { class: 'control-grid' }, ...actionButtons(event, round)),
      ),
      accessPanel(event),
      participantsPanel(),
    ),
    h('aside', { class: 'side-stack' },
      eventDetailsPanel(event),
      namedTallyPanel(),
      h('section', { class: 'card admin-card stack' },
        h('h3', { text: 'Display controls' }),
        h('div', { class: 'control-grid' },
          ['LOBBY', 'LIVE'].includes(event.status) ? h('button', { class: 'button secondary', type: 'button', onClick: () => action(event.displayBlanked ? 'UNBLANK_DISPLAY' : 'BLANK_DISPLAY'), text: event.displayBlanked ? 'Unblank display' : 'Blank display' }) : null,
          h('button', { class: 'button warning', type: 'button', onClick: () => action('ROTATE_DISPLAY_TOKEN'), text: 'Rotate display link' }),
        ),
      ),
    ),
  );
}

function detailsDraftFromEvent(event) {
  return {
    eventId: event.id,
    expectedEventVersion: event.version,
    title: event.title,
    subtitle: event.subtitle,
    participantLimit: event.participantLimit,
  };
}

function ensureDetailsDraft() {
  if (!appState?.event) return;
  if (!detailsDraft || detailsDraft.eventId !== appState.event.id) {
    detailsDraft = detailsDraftFromEvent(appState.event);
  }
}

function editEventDetails() {
  if (!appState?.event) return;
  detailsDraft = detailsDraftFromEvent(appState.event);
  editingDetails = true;
  message = '';
  render();
}

function cancelEditDetails() {
  editingDetails = false;
  detailsDraft = null;
  render();
}

function eventDetailsPanel(event) {
  if (editingDetails) {
    ensureDetailsDraft();
    return h('section', { class: 'card admin-card stack' },
      h('div', { class: 'row between' },
        h('h2', { text: 'Event details' }),
        h('button', { class: 'button ghost small', type: 'button', disabled: busy, onClick: cancelEditDetails, text: 'Cancel' }),
      ),
      h('form', { class: 'stack', onSubmit: saveEventDetails },
        field('Event title', h('input', { class: 'input', value: detailsDraft.title, maxlength: '100', onInput: (inputEvent) => { detailsDraft.title = inputEvent.target.value; } })),
        field('Subtitle', h('input', { class: 'input', value: detailsDraft.subtitle, maxlength: '200', onInput: (inputEvent) => { detailsDraft.subtitle = inputEvent.target.value; } })),
        field('Participant limit', h('input', { class: 'input', type: 'number', min: '2', max: '250', value: detailsDraft.participantLimit, onInput: (inputEvent) => { detailsDraft.participantLimit = Number(inputEvent.target.value); } })),
        h('div', { class: 'row' },
          h('button', { class: 'button small', type: 'submit', disabled: busy, text: busy ? 'Saving…' : 'Save details' }),
          h('button', { class: 'button secondary small', type: 'button', disabled: busy, onClick: cancelEditDetails, text: 'Cancel' }),
        ),
      ),
    );
  }

  return h('section', { class: 'card admin-card stack' },
    h('div', { class: 'row between' },
      h('h2', { text: 'Event details' }),
      h('button', { class: 'button secondary small', type: 'button', disabled: busy, onClick: editEventDetails, text: 'Edit' }),
    ),
    h('div', { class: 'stack' },
      detailItem('Title', event.title),
      event.subtitle ? detailItem('Subtitle', event.subtitle) : null,
      detailItem('Participant limit', event.participantLimit),
    ),
  );
}

function detailItem(label, value) {
  return h('div', {}, h('div', { class: 'label', text: label }), h('div', { text: value }));
}

async function saveEventDetails(event) {
  event.preventDefault();
  if (busy || !detailsDraft) return;
  const payload = {
    eventId: detailsDraft.eventId,
    expectedEventVersion: detailsDraft.expectedEventVersion,
    title: detailsDraft.title,
    subtitle: detailsDraft.subtitle,
    participantLimit: Number(detailsDraft.participantLimit),
  };
  busy = true;
  message = '';
  render();
  try {
    appState = await api.request('/api/admin/event-details', { method: 'PUT', body: payload });
    editingDetails = false;
    detailsDraft = null;
    message = 'Event details saved.';
  } catch (error) {
    message = friendlyError(error);
    if (error.code === 'CONFLICT') {
      try { appState = await api.request(`/api/admin/state?eventId=${encodeURIComponent(payload.eventId)}`); } catch {}
    }
  } finally {
    busy = false;
    render();
  }
}

function metrics() {
  const progress = appState.progress ?? {};
  return h('div', { class: 'metric-grid' },
    metric(progress.registeredParticipants ?? 0, 'Joined'),
    metric(progress.connectedParticipants ?? 0, 'Connected'),
    metric(progress.votesCast ?? 0, 'Votes this round'),
    metric(`${progress.completedAwards ?? 0}/${progress.awardCount ?? 0}`, 'Awards complete'),
  );
}

function metric(value, label) {
  return h('div', { class: 'admin-metric' }, h('strong', { text: value }), h('span', { text: label }));
}

function actionButtons(event, round) {
  const buttons = [];
  const add = (label, actionName, className = 'button') => buttons.push(h('button', { class: className, type: 'button', disabled: busy, onClick: () => action(actionName), text: label }));
  if (!round && ['LOBBY', 'LIVE'].includes(event.status)) add('Show first question', 'SHOW_AWARD');
  if (round?.status === 'PREVIEW') add('Open voting', 'OPEN_VOTING');
  if (round?.status === 'OPEN') add('Reveal winner', 'REVEAL_WINNER');
  if (round?.status === 'LOCKED') {
    const decision = round.resultDecision;
    if (decision?.mode === 'tie') buttons.push(tieChoicePanel(round, decision));
    else if (decision?.mode === 'none') buttons.push(noVotePanel(round, decision));
    else add('Reveal winner', 'REVEAL_WINNER');
    add('Reopen voting', 'REOPEN_VOTING', 'button warning');
  }
  if (round?.status === 'REVEALED') {
    if (isFinalRevealedQuestion()) add('Next award', 'NEXT_AWARD');
    else add('Next question', 'NEXT_QUESTION');
  }
  if (['LOBBY', 'LIVE'].includes(event.status)) {
    add(event.joinOpen ? 'Close joining' : 'Reopen joining', event.joinOpen ? 'CLOSE_JOINS' : 'REOPEN_JOINS', 'button secondary');
    if (round && ['PREVIEW', 'OPEN', 'LOCKED'].includes(round.status)) add('Reset round', 'RESET_CURRENT_ROUND', 'button danger');
    if (round?.status !== 'REVEALED') add('Finish event', 'FINISH_EVENT', 'button danger');
  }
  if (event.status === 'FINISHED') {
    add('Reopen event', 'REOPEN_EVENT');
    add('Revise choices/questions', 'REVISE_FINISHED_CONFIG', 'button warning');
    add('Restart event', 'RESTART_EVENT', 'button danger');
  }
  return buttons;
}

function isFinalRevealedQuestion() {
  const progress = appState?.progress ?? {};
  return Number(progress.completedAwards ?? 0) + 1 >= Number(progress.awardCount ?? 0);
}

function tieChoicePanel(round, decision) {
  const names = decision.tiedNominees.map((nominee) => nominee.name);
  const voteWord = decision.topCount === 1 ? 'vote' : 'votes';
  return h('section', { class: 'tie-choice-panel stack', 'aria-labelledby': 'tie-detected-title' },
    h('div', {},
      h('p', { class: 'eyebrow', text: 'Tie detected' }),
      h('h2', { id: 'tie-detected-title', text: `${decision.topCount} ${voteWord} each` }),
      h('p', { class: 'muted', text: `${formatNameList(names)} are tied for first place.` }),
    ),
    h('ul', { class: 'tie-list' }, decision.tiedNominees.map((nominee) => h('li', {},
      h('strong', { text: nominee.name }),
      nominee.subtitle ? h('span', { class: 'muted', text: nominee.subtitle }) : null,
      h('span', { class: 'tie-vote-count', text: `${nominee.voteCount} ${voteWord}` }),
    ))),
    h('p', { class: 'notice-banner', text: `Reveal ${formatNameList(names)} as joint winners for ${round.award.title}?` }),
    h('div', { class: 'row' },
      h('button', { class: 'button', type: 'button', disabled: busy, onClick: () => action('REVEAL_JOINT_WINNERS'), text: 'Reveal joint winners' }),
      h('button', { class: 'button secondary', type: 'button', disabled: busy, onClick: () => action('START_RUNOFF'), text: 'Start tie-break vote' }),
    ),
  );
}

function noVotePanel(round, decision) {
  return h('section', { class: 'tie-choice-panel stack' },
    h('div', {},
      h('p', { class: 'eyebrow', text: 'No result' }),
      h('h2', { text: decision.message ?? 'No votes were cast for this award' }),
      h('p', { class: 'muted', text: 'Reveal the award as having no winner, or reopen voting to collect votes.' }),
    ),
    h('button', { class: 'button', type: 'button', disabled: busy, onClick: () => action('REVEAL_WINNER'), text: 'Reveal no-vote result' }),
  );
}

async function action(actionName) {
  if (busy || !appState?.event) return;
  const round = appState.event.currentRound;
  if (actionName === 'REVEAL_JOINT_WINNERS') {
    const names = round?.resultDecision?.tiedNominees?.map((nominee) => nominee.name) ?? [];
    const promptText = names.length
      ? `Reveal ${formatNameList(names)} as joint winners for ${round.award.title}?`
      : 'Reveal joint winners to every connected screen?';
    if (!confirm(promptText)) return;
  }
  if (actionName === 'REVEAL_WINNER') {
    const promptText = round?.resultDecision?.mode === 'none'
      ? `Reveal no winner for ${round.award.title}?`
      : 'Reveal the result to every connected screen?';
    if (!confirm(promptText)) return;
  }
  if (actionName === 'FINISH_EVENT' && !confirm('Finish this event? No further votes will be accepted.')) return;
  if (actionName === 'REOPEN_EVENT' && !confirm('Reopen this event? Existing results will be kept and joining will reopen.')) return;
  if (actionName === 'RESTART_EVENT') {
    const typed = prompt(`Type the event title to clear participants, votes, and results, then return to the lobby:\n${appState.event.title}`);
    if (typed !== appState.event.title) return;
  }
  if (actionName === 'REVISE_FINISHED_CONFIG') {
    const typed = prompt(`Type the event title to clear participants, votes, and results, then return to draft configuration:\n${appState.event.title}`);
    if (typed !== appState.event.title) return;
  }
  if (actionName === 'ROTATE_DISPLAY_TOKEN' && !confirm('Rotate the display link and disconnect existing displays?')) return;
  if (actionName === 'ROTATE_JOIN_TOKEN' && !confirm('Rotate the participant link and manual code? Existing participants will stay connected.')) return;
  if (actionName === 'RESET_CURRENT_ROUND') {
    const typed = prompt(`Type the award title to delete this round's votes:\n${round?.award?.title ?? ''}`);
    if (typed !== round?.award?.title) return;
  }
  busy = true;
  message = '';
  render();
  try {
    appState = await api.request('/api/admin/action', {
      method: 'POST',
      body: {
        eventId: appState.event.id,
        action: actionName,
        expectedEventVersion: appState.event.version,
        expectedRoundVersion: round?.version ?? null,
      },
    });
  } catch (error) {
    message = friendlyError(error);
    if (error.code === 'CONFLICT') {
      try { appState = await api.request(`/api/admin/state?eventId=${encodeURIComponent(appState.event.id)}`); } catch {}
    }
  } finally {
    busy = false;
    render();
  }
}

function formatNameList(names) {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function accessPanel(event) {
  const access = event.access;
  return h('section', { class: 'card admin-card stack' },
    h('div', { class: 'row between' }, h('h2', { text: 'Join and display links' }), h('button', { class: 'button warning small', type: 'button', onClick: () => action('ROTATE_JOIN_TOKEN'), text: 'Rotate participant link' })),
    h('div', { class: 'access-grid' },
      h('div', { class: 'access-card' },
        h('h3', { text: 'Participants' }),
        h('img', { src: `/api/admin/join-qr.svg?eventId=${encodeURIComponent(event.id)}&v=${event.version}`, alt: 'Participant join QR code' }),
        h('div', { class: 'code-large', text: access.manualCode }),
        urlRow(access.joinUrl),
      ),
      h('div', { class: 'access-card' },
        h('h3', { text: 'Presentation display' }),
        h('img', { src: `/api/admin/display-qr.svg?eventId=${encodeURIComponent(event.id)}&v=${event.version}`, alt: 'Display access QR code' }),
        h('p', { class: 'muted', text: 'Private link for the projector or shared screen.' }),
        urlRow(access.displayUrl),
      ),
    ),
  );
}

function urlRow(value) {
  return h('div', { class: 'url-box' },
    h('code', { text: value }),
    h('button', { class: 'button secondary small', type: 'button', onClick: async () => { try { await copyText(value); message = 'Link copied.'; } catch { message = 'Clipboard access was unavailable.'; } render(); }, text: 'Copy' }),
  );
}

function namedTallyPanel() {
  const tally = appState.namedTally;
  return h('section', { class: 'card admin-card stack' },
    h('div', { class: 'row between' }, h('h2', { text: 'Private named tally' }), h('button', { class: 'button secondary small', type: 'button', onClick: () => { hideTally = !hideTally; render(); }, text: hideTally ? 'Show' : 'Hide' })),
    hideTally ? h('div', { class: 'hidden-tally', text: 'Named tally hidden for screen sharing' }) : tallyTable(tally),
  );
}

function tallyTable(tally) {
  if (!tally) return h('p', { class: 'muted', text: 'No active round.' });
  const total = tally.votesCast;
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', { text: 'Nominee' }), h('th', { text: 'Votes' }), h('th', { text: '%' }))),
    h('tbody', {}, tally.results.map((row, index) => h('tr', {},
      h('td', { class: index === 0 && row.count > 0 ? 'rank-first' : '' }, row.name, row.subtitle ? h('div', { class: 'muted', text: row.subtitle }) : null),
      h('td', { text: row.count }),
      h('td', { text: formatPercent(row.count, total) }),
    ))),
  ));
}

function participantsPanel() {
  const participants = appState.participants ?? [];
  return h('section', { class: 'card admin-card stack' },
    h('h2', { text: 'Participants' }),
    participants.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'Label' }), h('th', { text: 'Status' }), h('th', { text: 'Joined' }), h('th', { text: '' }))),
      h('tbody', {}, participants.map((participant) => h('tr', {},
        h('td', { text: participant.label }),
        h('td', { text: participant.status }),
        h('td', { text: new Date(participant.joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
        h('td', {}, participant.status === 'ACTIVE' ? h('button', { class: 'button danger small', type: 'button', onClick: () => revokeParticipant(participant), text: 'Revoke' }) : null),
      ))),
    )) : h('p', { class: 'muted', text: 'No participants have joined yet.' }),
  );
}

async function revokeParticipant(participant) {
  if (!confirm(`Revoke ${participant.label}? Their session will disconnect.`)) return;
  try {
    appState = await api.request('/api/admin/revoke-participant', { method: 'POST', body: { eventId: appState.event.id, participantId: participant.id } });
  } catch (error) {
    message = friendlyError(error);
  }
  render();
}

async function logout() {
  try { await api.request('/api/admin/logout', { method: 'POST', body: {} }); } catch {}
  connection?.close();
  authenticated = false;
  appState = null;
  message = '';
  render();
}

function friendlyError(error) {
  if (error instanceof ApiError) {
    const map = {
      TIE_REQUIRES_DECISION: 'The top result is tied. Choose joint winners or start a runoff.',
      NOT_TIED: 'The current result is not tied.',
      CONFLICT: 'Another controller action changed the event. The latest state has been loaded.',
      PEOPLE_LIST_EXISTS: 'A saved people list with that name already exists.',
      CONFIG_LOCKED: 'Full award and nominee configuration is locked after the lobby opens.',
      INVALID_STATE_TRANSITION: error.message,
      PARTICIPANT_LIMIT_TOO_LOW: error.message,
      RATE_LIMITED: 'Too many requests. Wait briefly and try again.',
    };
    return map[error.code] ?? error.message;
  }
  return 'Unable to reach the server.';
}
