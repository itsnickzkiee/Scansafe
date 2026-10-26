/* ScanSafe: authenticated necessity requests and staff fulfilment queue. */
(function () {
  'use strict';

  const categories = { food: 'Food', water: 'Water', hygiene: 'Hygiene', bedding: 'Bedding', baby: 'Baby supplies', medical: 'Medical assistance', other: 'Other' };
  const statuses = { pending: 'Pending', preparing: 'Preparing', ready_for_pickup: 'Ready for Pickup', for_delivery: 'For Delivery', provided: 'Provided', unavailable: 'Unavailable', cancelled: 'Cancelled' };
  const transitions = { pending: ['preparing', 'unavailable'], preparing: ['ready_for_pickup', 'for_delivery', 'unavailable'], ready_for_pickup: ['provided', 'unavailable'], for_delivery: ['provided', 'unavailable'], provided: [], unavailable: [], cancelled: [] };
  const terminal = new Set(['provided', 'unavailable', 'cancelled']);
  const page = String(window.location?.pathname || '').split('/').pop();
  const pageMode = page === 'user-needs.html' ? 'evacuee' : page === 'needs-requests.html' ? 'staff' : null;
  let options = {};
  let mount = null;
  let revision = 0;
  let fetchRevision = 0;
  let refreshPromise = null;
  let mountedKey = '';
  let timer = null;
  let listenersInstalled = false;
  let authClient = null;
  let authSubscription = null;
  let nextItemId = 0;
  let pendingListRender = false;
  const drafts = new Map();
  const updateErrors = new Map();
  const filters = { search: '', status: '', category: '', urgency: '', space: '' };
  const state = {
    ownerId: null, role: null, mode: null, loaded: false, eligible: false,
    eligibilityReason: '', account: null, requests: [], counts: {}, error: null,
    submitting: false, updating: new Set(), token: null, fingerprint: null
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }
  function $(id) { return document.getElementById(id); }
  function setLoading(value) { if (mount) mount.setAttribute('aria-busy', String(!!value)); }
  function client() { return typeof options.getClient === 'function' ? options.getClient() : window.ScanSafeDB?.client; }
  function context() {
    const source = (typeof options.getContext === 'function' ? options.getContext() : window.ScanSafeDB) || {};
    const ownerId = source.userId || source.ownerId || source.subjectId || source.session?.user?.id || source.user?.id || null;
    const profile = source.profile || null;
    const role = source.role || profile?.role || null;
    if (profile?.id && String(profile.id) !== String(ownerId)) return { ownerId: null, role: null, mode: null };
    return { ownerId: ownerId ? String(ownerId) : null, role, mode: role === 'evacuee' ? 'evacuee' : ['admin', 'staff'].includes(role) ? 'staff' : null };
  }
  function keyOf(subject) { return [subject.ownerId || '', subject.role || '', subject.mode || ''].join('|'); }
  function isCurrent(generation, key) { return revision === generation && keyOf(context()) === key && keyOf(state) === key; }
  function number(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; }
  function date(value) {
    if (!value) return 'Not recorded';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Not recorded' : parsed.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function label(value) { return statuses[value] || String(value || 'Unknown'); }
  function location(record) { return [record?.space_name || record?.space_code, record?.shelter_name].filter(Boolean).join(' · ') || 'No active accommodation assignment'; }
  function readableError(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || error || 'The request could not be completed.');
    if (['PGRST202', 'PGRST204', '42883', '42P01'].includes(code) || /could not find.*(function|table)|schema cache/i.test(message)) {
      return 'Request Needs is not set up yet. Run SUPABASE_NEEDS_REQUESTS.sql in Supabase, then refresh this page.';
    }
    if (code === '40001') return 'This request changed while you were editing. Review the latest status, then try again. Your reply has been kept.';
    if (code === 'P5502') return 'There is already an active request for one of these items in your group. Check the request history or ask shelter staff before requesting it again.';
    if (/failed to fetch|network|load failed/i.test(message)) return 'Connection failed. Your draft has been kept. Reconnect and retry the same request.';
    return message;
  }
  function feedback(message, kind) {
    const element = $('needsFeedback');
    if (!element) return;
    element.textContent = message || '';
    element.hidden = !message;
    element.className = 'needs-feedback' + (kind === 'success' ? ' is-success' : ' is-error');
  }
  function updateNeedsNavigation(available, reason) {
    const message = available
      ? 'Request necessities for your assigned accommodation.'
      : String(reason || 'Waiting for accommodation assignment.');

    document.querySelectorAll('a[href="user-needs.html"]').forEach(link => {
      link.classList.toggle('needs-nav-locked', !available);
      link.setAttribute('aria-disabled', String(!available));
      link.dataset.needsEligibility = available ? 'available' : 'locked';
      link.title = message;

      let lock = link.querySelector('[data-needs-lock]');
      if (!available) {
        if (!lock) {
          lock = document.createElement('span');
          lock.className = 'needs-lock-badge';
          lock.setAttribute('data-needs-lock', '');
          lock.setAttribute('aria-hidden', 'true');
          lock.textContent = '🔒';
          link.appendChild(lock);
        }
      } else if (lock) {
        lock.remove();
      }
    });
  }

  function clearBadges() {
    document.querySelectorAll('[data-needs-count]').forEach(element => { element.textContent = ''; element.hidden = true; });
    document.querySelectorAll('[data-needs-alert]').forEach(element => { element.removeAttribute('data-needs-active'); element.removeAttribute('aria-label'); });
    document.querySelectorAll('[data-needs-gated]').forEach(element => {
      element.disabled = true;
      element.setAttribute('aria-disabled', 'true');
      element.title = 'Waiting for accommodation assignment.';
    });
    updateNeedsNavigation(false, state.eligibilityReason || 'Waiting for accommodation assignment.');
  }
  function updateBadges() {
    const count = state.mode === 'staff' ? number(state.counts.pending) : number(state.counts.active);
    document.querySelectorAll('[data-needs-count]').forEach(element => { element.textContent = String(count); element.hidden = count === 0; });
    document.querySelectorAll('[data-needs-alert]').forEach(element => {
      if (count) element.setAttribute('data-needs-active', 'true'); else element.removeAttribute('data-needs-active');
      element.setAttribute('aria-label', state.mode === 'staff' ? count + ' pending necessity requests' : count + ' active necessity requests');
    });
    const available = state.mode === 'evacuee' && state.loaded && state.eligible === true && !state.error;
    const reason = available
      ? 'Request necessities for your assigned accommodation.'
      : state.eligibilityReason || (state.error ? 'Request Needs is temporarily unavailable.' : 'Waiting for accommodation assignment.');

    document.querySelectorAll('[data-needs-gated]').forEach(element => {
      element.disabled = !available;
      element.setAttribute('aria-disabled', String(!available));
      element.title = reason;
    });

    if (state.mode === 'evacuee') updateNeedsNavigation(available, reason);
  }
  function reset() {
    revision += 1;
    fetchRevision += 1;
    refreshPromise = null;
    mountedKey = '';
    pendingListRender = false;
    state.ownerId = null;
    state.role = null;
    state.mode = null;
    state.loaded = false;
    state.eligible = false;
    state.eligibilityReason = '';
    state.account = null;
    state.requests = [];
    state.counts = {};
    state.error = null;
    state.submitting = false;
    state.updating.clear();
    state.token = null;
    state.fingerprint = null;
    drafts.clear();
    updateErrors.clear();
    Object.keys(filters).forEach(key => { filters[key] = ''; });
    clearBadges();
    mount = $('needsApp');
    if (mount) {
      mount.innerHTML = '<div class="needs-empty" role="status">Loading your account...</div>';
      setLoading(true);
    }
  }
  function synchronize() {
    const subject = context();
    if (keyOf(subject) !== keyOf(state)) {
      reset();
      state.ownerId = subject.ownerId;
      state.role = subject.role;
      state.mode = subject.mode;
    }
    return subject;
  }
  function categoryOptions(selected) {
    return Object.entries(categories).map(([value, text]) => '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + text + '</option>').join('');
  }
  function itemRow() {
    nextItemId += 1;
    const prefix = 'needsItem' + nextItemId;
    return '<div class="needs-item-row" data-needs-item><div class="needs-item-fields">' +
      '<label class="needs-field" for="' + prefix + 'Category">Category<select id="' + prefix + 'Category" name="category" class="select" data-needs-category>' + categoryOptions('food') + '</select></label>' +
      '<label class="needs-field" for="' + prefix + 'Name">Item<input id="' + prefix + 'Name" name="item_name" data-needs-item-name maxlength="100" placeholder="e.g. Rice meals" required></label>' +
      '<label class="needs-field" for="' + prefix + 'Quantity">Quantity<input id="' + prefix + 'Quantity" name="quantity" data-needs-quantity type="number" min="0.01" max="10000" step="0.01" value="1" required></label>' +
      '<label class="needs-field" for="' + prefix + 'Unit">Unit<input id="' + prefix + 'Unit" name="unit" data-needs-unit maxlength="30" value="pcs" placeholder="pcs, packs, bottles" required></label></div>' +
      '<button type="button" class="btn out" data-needs-action="remove-item" aria-label="Remove this item">Remove</button></div>';
  }
  function userShell() {
    return '<div id="needsFeedback" class="needs-feedback" role="status" aria-live="polite" hidden></div><div class="needs-layout">' +
      '<section class="needs-form card card-pad"><h2>New request</h2><div id="needsGate" class="needs-gate" role="status">Checking your accommodation assignment...</div>' +
      '<form id="needsForm"><fieldset id="needsFormFields" disabled><div id="needsItems" class="needs-item-list">' + itemRow() + '</div>' +
      '<button type="button" class="btn out" data-needs-action="add-item">+ Add item</button><p id="needsDuplicateWarning" class="needs-feedback is-error" role="status" hidden></p>' +
      '<div class="needs-field-grid"><label class="needs-field" for="needsPriority">Urgency<select id="needsPriority" class="select"><option value="normal">Normal</option><option value="urgent">Urgent</option></select></label></div>' +
      '<label class="needs-field" for="needsNotes">Notes <span class="muted">(optional)</span><textarea id="needsNotes" rows="3" maxlength="1000" placeholder="Additional details for shelter staff"></textarea></label>' +
      '<p class="muted">For immediate assistance, contact the nearest shelter staff member.</p>' +
      '<div class="needs-form-actions"><button id="needsSubmit" type="submit" class="btn red" disabled>Submit Request</button></div></fieldset></form></section>' +
      '<section class="needs-section card card-pad"><div class="needs-request-head"><h2>My requests</h2><button type="button" class="btn out" data-needs-action="refresh">Refresh</button></div><div id="needsSummary" class="needs-summary"></div><div id="needsHistory" class="needs-list"><div class="needs-empty">Loading your requests...</div></div></section></div>';
  }
  function staffShell() {
    return '<div id="needsFeedback" class="needs-feedback" role="status" aria-live="polite" hidden></div><section class="needs-section card card-pad">' +
      '<div class="needs-request-head"><h2>Request queue</h2><button type="button" class="btn out" data-needs-action="refresh">Refresh</button></div><div id="needsSummary" class="needs-summary"></div>' +
      '<form id="needsFilters" class="needs-filters" role="search"><label class="needs-field" for="needsSearch">Search<input id="needsSearch" type="search" placeholder="Name, item, request number..."></label>' +
      '<label class="needs-field" for="needsStatusFilter">Status<select id="needsStatusFilter" class="select"><option value="">All statuses</option>' + Object.entries(statuses).map(([value, text]) => '<option value="' + value + '">' + text + '</option>').join('') + '</select></label>' +
      '<label class="needs-field" for="needsCategoryFilter">Category<select id="needsCategoryFilter" class="select"><option value="">All categories</option>' + categoryOptions('') + '</select></label>' +
      '<label class="needs-field" for="needsUrgencyFilter">Urgency<select id="needsUrgencyFilter" class="select"><option value="">All urgency</option><option value="urgent">Urgent</option><option value="normal">Normal</option></select></label>' +
      '<label class="needs-field" for="needsSpaceFilter">Space<select id="needsSpaceFilter" class="select"><option value="">All spaces</option></select></label></form><div id="needsQueue" class="needs-list"><div class="needs-empty">Loading requests...</div></div></section>';
  }
  function mountPage() {
    mount = $('needsApp');
    if (!mount || !pageMode) return;
    if (!state.ownerId || !state.mode) {
      if (mountedKey !== 'loading') mount.innerHTML = '<div class="needs-empty" role="status">Sign in to load necessity requests.</div>';
      mountedKey = 'loading';
      setLoading(false);
      return;
    }
    if (pageMode !== state.mode) {
      mount.innerHTML = '<div class="needs-feedback is-error" role="alert">' + (pageMode === 'staff' ? 'Staff access is required to view this page.' : 'An evacuee account is required to view this page.') + '</div>';
      mountedKey = 'denied';
      setLoading(false);
      return;
    }
    const key = keyOf(state);
    if (mountedKey === key) return;
    mount.innerHTML = pageMode === 'evacuee' ? userShell() : staffShell();
    mountedKey = key;
    setLoading(false);
    updateGate();
  }
  function updateGate() {
    const gate = $('needsGate');
    const valid = state.loaded && state.eligible && !state.error;
    if (gate) {
      if (state.error) gate.textContent = 'Your assignment could not be confirmed. Refresh before submitting a request.';
      else if (!state.loaded) gate.textContent = 'Checking your accommodation assignment...';
      else if (valid) gate.textContent = (state.account?.full_name ? state.account.full_name + ' · ' : '') + 'Assigned to ' + location(state.account) + '. Group size: ' + number(state.account?.group_size) + '. You can request necessities here.';
      else gate.textContent = state.eligibilityReason || 'Waiting for accommodation assignment. You can request necessities once a space is assigned on the map.';
      gate.className = 'needs-gate' + (valid ? ' is-eligible' : '');
    }
    const fieldset = $('needsFormFields');
    if (fieldset) fieldset.disabled = !valid || state.submitting;
    const submit = $('needsSubmit');
    if (submit) { submit.disabled = !valid || state.submitting; submit.textContent = state.submitting ? 'Submitting...' : 'Submit Request'; }
    const rows = $('needsItems')?.querySelectorAll('[data-needs-item]') || [];
    rows.forEach(row => {
      const remove = row.querySelector('[data-needs-action="remove-item"]');
      if (remove) remove.disabled = !valid || state.submitting || rows.length < 2;
    });
    const add = mount?.querySelector('[data-needs-action="add-item"]');
    if (add) add.disabled = !valid || state.submitting || rows.length >= 20;
  }
  function summary() {
    const element = $('needsSummary');
    if (!element) return;
    const counts = state.counts || {};
    const pending = number(counts.pending);
    const active = number(counts.active);
    element.innerHTML = '<span class="needs-stat"><b>' + number(counts.total) + '</b> Total</span><span class="needs-stat"><b>' + pending + '</b> Pending</span><span class="needs-stat"><b>' + active + '</b> Active</span><span class="needs-stat"><b>' + number(counts.provided) + '</b> Provided</span>' + (number(counts.cancelled) ? '<span class="needs-stat"><b>' + number(counts.cancelled) + '</b> Cancelled</span>' : '');
  }
  function displayItems(record) {
    return '<table class="needs-items-table"><thead><tr><th scope="col">Item</th><th scope="col">Category</th><th scope="col">Quantity</th></tr></thead><tbody>' + (record.items || []).map(item => '<tr><td>' + esc(item.item_name) + '</td><td>' + esc(categories[item.category] || item.category) + '</td><td>' + esc(item.quantity) + ' ' + esc(item.unit) + '</td></tr>').join('') + '</tbody></table>';
  }
  function displayEvents(record) {
    const events = Array.isArray(record.events) ? record.events : [];
    if (!events.length) return '';
    return '<details class="needs-events"><summary>Request history (' + events.length + ')</summary><ol class="needs-event-list">' + events.map(event => '<li><strong>' + esc(label(event.to_status)) + '</strong><span> · ' + esc(date(event.created_at)) + (event.actor_name ? ' · ' + esc(event.actor_name) : '') + '</span>' + (event.response ? '<p>' + esc(event.response) + '</p>' : '') + '</li>').join('') + '</ol></details>';
  }
  function providedText(record) {
    if (record.status !== 'provided') return '';
    // Replies may add later provided -> provided events from different staff.
    // Attribute fulfilment to its original transition, not the latest reply.
    const event = (record.events || []).find(entry => entry.to_status === 'provided' && entry.from_status !== 'provided' &&
      (!record.provided_by || !entry.actor_id || String(entry.actor_id) === String(record.provided_by)));
    const actor = record.provided_by_name || event?.actor_name || 'Shelter staff';
    return '<p class="needs-request-meta">Provided by ' + esc(actor) + ' · ' + esc(date(record.provided_at || event?.created_at)) + '</p>';
  }
  function updateForm(record) {
    if (record.status === 'cancelled') return '<p class="needs-request-meta">This request was closed when the evacuation operation ended.</p>';
    const id = String(record.request_id);
    const draft = drafts.get(id);
    const status = draft?.status || record.status;
    const allowed = [record.status].concat(transitions[record.status] || []);
    if (!allowed.includes(status)) allowed.push(status);
    const busy = state.updating.has(id);
    return '<form class="needs-admin-update" data-needs-update-form data-request-id="' + esc(id) + '" data-version="' + esc(draft?.version ?? record.version) + '"><div class="needs-update-grid">' +
      '<label class="needs-field" for="needsUpdateStatus' + esc(id) + '">Status<select id="needsUpdateStatus' + esc(id) + '" class="select" name="status" data-needs-update-status' + (busy ? ' disabled' : '') + '>' + allowed.map(value => '<option value="' + esc(value) + '"' + (value === status ? ' selected' : '') + '>' + esc(label(value)) + '</option>').join('') + '</select></label>' +
      '<label class="needs-field" for="needsUpdateResponse' + esc(id) + '">Reply / reason<textarea id="needsUpdateResponse' + esc(id) + '" name="response" data-needs-update-response rows="2" maxlength="1000" placeholder="Reply to the evacuee; required if unavailable"' + (busy ? ' disabled' : '') + '>' + esc(draft?.response ?? record.response ?? '') + '</textarea></label></div>' +
      '<p class="needs-feedback is-error" id="needsUpdateFeedback' + esc(id) + '" role="status"' + (updateErrors.has(id) ? '' : ' hidden') + '>' + esc(updateErrors.get(id) || '') + '</p><button type="submit" class="btn red"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Saving...' : 'Update Request') + '</button></form>';
  }
  function card(record) {
    const status = Object.hasOwn(statuses, record.status) ? record.status : 'unknown';
    const urgent = record.priority === 'urgent';
    let currentLocation = '';
    if (state.mode === 'staff' && record.status !== 'cancelled') {
      if (!record.current_assignment) currentLocation = '<p class="needs-request-location"><strong>Current location:</strong> No active assignment. Confirm the recipient location before arranging delivery.</p>';
      else if (String(record.current_assignment.assignment_id) !== String(record.assignment_id)) currentLocation = '<p class="needs-request-location"><strong>Current location:</strong> ' + esc(location(record.current_assignment)) + ' <span class="muted">(changed since this request)</span></p>';
    }
    return '<article class="needs-request" data-needs-request="' + esc(record.request_id) + '"><div class="needs-request-head"><div><h3>Request #' + esc(record.request_id) + '</h3>' + (state.mode === 'staff' ? '<p><strong>' + esc(record.full_name) + '</strong> · Group of ' + esc(record.group_size) + '</p>' : '') + '</div><div><span class="needs-badge needs-status-' + status + '">' + esc(label(record.status)) + '</span>' + (urgent ? ' <span class="needs-badge needs-priority-urgent">Urgent</span>' : '') + '</div></div>' +
      '<p class="needs-request-meta">Submitted ' + esc(date(record.created_at)) + '</p><p class="needs-request-location"><strong>Assigned space at submission:</strong> ' + esc(location(record)) + '</p>' + currentLocation + displayItems(record) +
      (record.notes ? '<p class="needs-note"><strong>Notes:</strong> ' + esc(record.notes) + '</p>' : '') +
      (record.response ? '<p class="needs-response"><strong>Staff reply:</strong> ' + esc(record.response) + '</p>' : '') + providedText(record) + displayEvents(record) +
      (state.mode === 'staff' ? updateForm(record) : '') + '</article>';
  }
  function filteredRequests() {
    const term = filters.search.trim().toLowerCase();
    return state.requests.filter(record => {
      if (filters.status && record.status !== filters.status) return false;
      if (filters.urgency && record.priority !== filters.urgency) return false;
      if (filters.category && !(record.items || []).some(item => item.category === filters.category)) return false;
      if (filters.space && String(record.current_assignment?.space_code || record.space_code || '') !== filters.space) return false;
      if (!term) return true;
      return [record.request_id, record.full_name, record.space_code, record.space_name, record.current_assignment?.space_code, record.notes, ...(record.items || []).map(item => item.item_name)].join(' ').toLowerCase().includes(term);
    }).sort((left, right) => {
      if (state.mode === 'staff') {
        const leftClosed = terminal.has(left.status), rightClosed = terminal.has(right.status);
        if (leftClosed !== rightClosed) return leftClosed ? 1 : -1;
        if (!leftClosed && (left.priority === 'urgent') !== (right.priority === 'urgent')) return left.priority === 'urgent' ? -1 : 1;
      }
      return (Date.parse(right.created_at) || 0) - (Date.parse(left.created_at) || 0);
    });
  }
  function renderList(force) {
    const list = $(state.mode === 'staff' ? 'needsQueue' : 'needsHistory');
    if (!list) return;
    if (!force && state.mode === 'staff' && (state.updating.size || document.activeElement?.closest?.('[data-needs-update-form]'))) {
      pendingListRender = true;
      return;
    }
    pendingListRender = false;
    if (!state.loaded) { list.innerHTML = '<div class="needs-empty">' + (state.error ? 'Requests could not be loaded. Use Refresh to retry.' : 'Loading requests...') + '</div>'; return; }
    const records = filteredRequests();
    list.innerHTML = records.length ? records.map(card).join('') : '<div class="needs-empty">' + (state.requests.length ? 'No requests match these filters.' : state.mode === 'staff' ? 'No necessity requests have been submitted.' : 'You have no requests yet. Submitted requests and staff updates will appear here.') + '</div>';
  }
  function spaceOptions() {
    const select = $('needsSpaceFilter');
    if (!select) return;
    const values = [...new Set(state.requests.map(record => String(record.current_assignment?.space_code || record.space_code || '')).filter(Boolean))].sort();
    select.innerHTML = '<option value="">All spaces</option>' + values.map(value => '<option value="' + esc(value) + '"' + (value === filters.space ? ' selected' : '') + '>' + esc(value) + '</option>').join('');
    if (filters.space && !values.includes(filters.space)) { filters.space = ''; select.value = ''; }
  }
  function parseCounts(data) {
    const result = {};
    Object.keys(statuses).concat(['active', 'total']).forEach(key => { result[key] = number(data?.[key]); });
    return result;
  }
  function validateResponse(data, expectedMode, full) {
    if (!data || typeof data !== 'object' || data.mode !== expectedMode) throw new Error('The server returned an unexpected account role. Refresh your session before continuing.');
    if (!data.owner_id || String(data.owner_id) !== state.ownerId) throw new Error('The account changed. Sign in again before loading requests.');
    if (typeof data.eligible !== 'boolean' || (full && (!Array.isArray(data.requests) || !data.stats || typeof data.stats !== 'object' || Array.isArray(data.stats)))) throw new Error('The server returned incomplete request data. Refresh this page before continuing.');
    if (full && expectedMode === 'evacuee' && data.requests.some(record => !record.owner_id || String(record.owner_id) !== state.ownerId)) throw new Error('The server returned requests for another account. Requests have been hidden.');
  }
  function validateMutation(data, ownerId, requestId, expectedVersion) {
    const valid = data && typeof data === 'object' && !Array.isArray(data) && /^[1-9]\d*$/.test(String(data.request_id || '')) &&
      Object.hasOwn(statuses, data.status) && data.owner_id && String(data.owner_id) === String(ownerId) &&
      (requestId == null || (String(data.request_id) === String(requestId) && Number.isInteger(data.version) && data.version >= expectedVersion));
    if (!valid) throw new Error('The server response could not be confirmed. Refresh and retry the same request. Your draft has been kept.');
  }
  async function refresh(configuration) {
    synchronize();
    mountPage();
    const sb = client();
    if (!state.ownerId || !state.mode) { clearBadges(); return false; }
    if (pageMode && pageMode !== state.mode) { clearBadges(); return false; }
    if (!sb || typeof sb.rpc !== 'function') {
      state.error = 'The ScanSafe connection is unavailable. Refresh this page to reconnect.';
      state.eligible = false;
      setLoading(false); updateGate(); clearBadges(); feedback(state.error); return false;
    }
    if (refreshPromise && !configuration?.force) return refreshPromise;
    const generation = revision;
    const fetchGeneration = ++fetchRevision;
    const key = keyOf(state);
    const full = !!mount && pageMode === state.mode;
    if (full && !state.loaded) setLoading(true);
    const work = (async () => {
      try {
        const result = await sb.rpc(full ? 'get_scansafe_need_requests' : 'get_scansafe_need_request_counts');
        if (!isCurrent(generation, key)) { synchronize(); mountPage(); return false; }
        if (fetchGeneration !== fetchRevision) return false;
        if (result.error) throw result.error;
        validateResponse(result.data, state.mode, full);
        const data = result.data;
        state.loaded = true;
        state.error = null;
        state.eligible = state.mode === 'evacuee' && data.eligible === true;
        state.eligibilityReason = String(data.eligibility_reason || '');
        state.counts = parseCounts(full ? data.stats : data);
        if (full) {
          state.account = data.account || null;
          state.requests = Array.isArray(data.requests) ? data.requests : [];
          if (state.mode === 'evacuee' && (!state.account?.assignment_id || !state.account?.space_id)) state.eligible = false;
          updateGate(); summary(); spaceOptions(); renderList(); duplicateWarning();
          const notice = $('needsFeedback');
          if (notice && !notice.classList.contains('is-success')) feedback('');
        }
        updateBadges();
        return true;
      } catch (error) {
        if (!isCurrent(generation, key)) { synchronize(); mountPage(); return false; }
        if (fetchGeneration !== fetchRevision) return false;
        state.error = readableError(error);
        state.eligible = false;
        if (/another account|unexpected account role|account changed|incomplete request data/.test(state.error)) {
          state.requests = []; state.account = null; state.counts = {}; state.loaded = false; summary(); spaceOptions(); renderList(true);
        }
        updateGate(); clearBadges(); feedback(state.error); if (!state.loaded) renderList();
        return false;
      } finally {
        if (revision === generation && fetchGeneration === fetchRevision) {
          refreshPromise = null;
          setLoading(false);
        }
      }
    })();
    refreshPromise = work;
    return work;
  }
  function normalize(value) { return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
  function readItems() {
    return Array.from($('needsItems')?.querySelectorAll('[data-needs-item]') || []).map(row => ({
      category: row.querySelector('[data-needs-category]')?.value || '',
      item_name: String(row.querySelector('[data-needs-item-name]')?.value || '').trim(),
      quantity: Number(row.querySelector('[data-needs-quantity]')?.value),
      unit: String(row.querySelector('[data-needs-unit]')?.value || '').trim()
    }));
  }
  function duplicateWarning() {
    const element = $('needsDuplicateWarning');
    if (!element) return false;
    const active = state.requests.filter(record => !terminal.has(record.status));
    const seen = new Set();
    let duplicate = '';
    readItems().forEach(item => {
      if (!item.item_name) return;
      const key = item.category + '|' + normalize(item.item_name);
      if (seen.has(key)) duplicate = 'Combine duplicate items into one row and adjust the quantity.';
      if (active.some(record => (record.items || []).some(existing => existing.category === item.category && normalize(existing.item_name) === normalize(item.item_name)))) duplicate = 'You already have an active request for ' + item.item_name + '. Check its status before submitting another.';
      seen.add(key);
    });
    element.textContent = duplicate;
    element.hidden = !duplicate;
    return !!duplicate;
  }
  function token() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    if (!window.crypto?.getRandomValues) throw new Error('This browser cannot create a request token. Open ScanSafe over HTTPS and try again.');
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }
  async function submitRequest() {
    const subject = synchronize();
    if (subject.mode !== 'evacuee' || !state.loaded || !state.eligible || state.error || state.submitting) { updateGate(); return false; }
    const form = $('needsForm');
    if (form?.reportValidity && !form.reportValidity()) return false;
    const items = readItems();
    const notes = String($('needsNotes')?.value || '').trim();
    const priority = $('needsPriority')?.value || 'normal';
    if (!items.length || items.length > 20 || items.some(item => !Object.hasOwn(categories, item.category) || !item.item_name || item.item_name.length > 100 || !Number.isFinite(item.quantity) || item.quantity < 0.01 || item.quantity > 10000 || Math.abs(item.quantity * 100 - Math.round(item.quantity * 100)) > 0.000001 || !item.unit || item.unit.length > 30) || notes.length > 1000 || !['normal', 'urgent'].includes(priority)) {
      feedback('Check each item, quantity (0.01–10,000, up to 2 decimal places), unit, and notes.'); return false;
    }
    const fingerprint = JSON.stringify({ items, notes, priority });
    // A lost network response may already have created the same request. Keep
    // its token usable even after polling displays that newly created record.
    if (duplicateWarning() && !(state.token && state.fingerprint === fingerprint)) return false;
    try {
      if (!state.token || state.fingerprint !== fingerprint) { state.token = token(); state.fingerprint = fingerprint; }
    } catch (error) { feedback(readableError(error)); return false; }
    const sb = client();
    if (!sb?.rpc) { feedback('The ScanSafe connection is unavailable. Reconnect and retry your draft.'); return false; }
    const generation = revision;
    const key = keyOf(state);
    state.submitting = true;
    updateGate(); feedback('');
    try {
      const result = await sb.rpc('submit_scansafe_need_request', { p_items: items, p_notes: notes, p_priority: priority, p_client_token: state.token });
      if (!isCurrent(generation, key)) { synchronize(); mountPage(); return false; }
      if (result.error) throw result.error;
      validateMutation(result.data, state.ownerId);
      state.token = null; state.fingerprint = null;
      const container = $('needsItems'); if (container) container.innerHTML = itemRow();
      if ($('needsNotes')) $('needsNotes').value = '';
      if ($('needsPriority')) $('needsPriority').value = 'normal';
      feedback(result.data.status === 'cancelled' ? 'Your earlier request was received and then cancelled when the evacuation operation ended. Check its history for the reason.' : 'Request submitted. Shelter staff can now see your items and assigned space.', 'success');
      await refresh({ force: true });
      return true;
    } catch (error) {
      if (!isCurrent(generation, key)) { synchronize(); mountPage(); return false; }
      feedback(readableError(error));
      // Assignment eligibility may have changed while a form was being filled.
      if (String(error?.code) === '42501' || /assignment|accommodation|released|approved|group details|shelter stay|registration changed/i.test(String(error?.message || ''))) {
        state.eligible = false;
        state.eligibilityReason = 'Your accommodation must be confirmed before submitting. Use Refresh to check your assignment.';
        updateBadges();
      }
      return false;
    } finally {
      if (isCurrent(generation, key)) { state.submitting = false; updateGate(); }
    }
  }
  function rememberDraft(form) {
    if (!form) return null;
    const id = String(form.dataset.requestId || '');
    const draft = { status: form.querySelector('[data-needs-update-status]')?.value || '', response: form.querySelector('[data-needs-update-response]')?.value || '', version: Number(form.dataset.version) };
    drafts.set(id, draft);
    return draft;
  }
  async function updateRequest(form) {
    synchronize();
    if (state.mode !== 'staff' || !state.loaded) return false;
    const id = String(form.dataset.requestId || '');
    if (!/^\d+$/.test(id) || state.updating.has(id)) return false;
    const draft = rememberDraft(form);
    if (!draft || !Object.hasOwn(statuses, draft.status) || !Number.isInteger(draft.version) || draft.version < 1) return false;
    const record = state.requests.find(entry => String(entry.request_id) === id);
    if (!record) return false;
    if (record.status === 'cancelled') {
      drafts.delete(id); updateErrors.delete(id);
      feedback('This request was cancelled when the evacuation operation ended and can no longer be edited.', 'error');
      renderList(true); return false;
    }
    if (draft.status !== record.status && !(transitions[record.status] || []).includes(draft.status)) {
      updateErrors.set(id, 'This request has a newer status. Review it and select an available next step.');
      drafts.set(id, { ...draft, status: record.status, version: record.version }); renderList(true); return false;
    }
    if (draft.response.length > 1000 || (draft.status === 'unavailable' && !draft.response.trim())) {
      updateErrors.set(id, 'Add a reason when marking a request Unavailable. Replies can contain up to 1,000 characters.'); renderList(true); return false;
    }
    const sb = client();
    if (!sb?.rpc) { updateErrors.set(id, 'The ScanSafe connection is unavailable. Reconnect and retry.'); renderList(true); return false; }
    const generation = revision, key = keyOf(state);
    state.updating.add(id); updateErrors.delete(id); renderList(true);
    try {
      const result = await sb.rpc('update_scansafe_need_request', { p_request_id: id, p_status: draft.status, p_response: draft.response.trim(), p_expected_version: draft.version });
      if (!isCurrent(generation, key)) { synchronize(); mountPage(); return false; }
      if (result.error) throw result.error;
      validateMutation(result.data, record.owner_id, id, draft.version);
      drafts.delete(id); updateErrors.delete(id);
      feedback('Request updated. The evacuee can see the new status and reply.', 'success');
      await refresh({ force: true });
      return true;
    } catch (error) {
      if (!isCurrent(generation, key)) { synchronize(); mountPage(); return false; }
      updateErrors.set(id, readableError(error));
      if (String(error?.code) === '40001') {
        await refresh({ force: true });
        if (!isCurrent(generation, key)) { synchronize(); mountPage(); return false; }
        const latest = state.requests.find(entry => String(entry.request_id) === id);
        if (latest) drafts.set(id, { ...draft, status: latest.status, version: latest.version });
      }
      return false;
    } finally {
      if (isCurrent(generation, key)) { state.updating.delete(id); renderList(true); }
    }
  }
  function handleNeedsNavigation(event) {
    const link = event.target?.closest?.('a[href="user-needs.html"]');
    if (!link || !link.classList.contains('needs-nav-locked')) return;

    // If the evacuee is already on the Request Needs page, let the page remain
    // visible so the eligibility reason can be read. Block navigation elsewhere.
    if (page === 'user-needs.html') return;

    event.preventDefault();
    event.stopPropagation();
    const reason = state.eligibilityReason ||
      link.title ||
      'Request Needs becomes available after your accommodation is assigned.';
    if (typeof window.toast === 'function') window.toast(reason);
    else link.title = reason;
  }

  function handleClick(event) {
    const action = event.target?.closest?.('[data-needs-action]');
    if (!action || !mount?.contains(action)) return;
    const subject = synchronize();
    if (!subject.ownerId) { mountPage(); return; }
    const kind = action.dataset.needsAction;
    if (kind === 'refresh') { refresh(); return; }
    if (state.mode !== 'evacuee' || !state.eligible || state.error || state.submitting) return;
    const container = $('needsItems');
    const rows = container?.querySelectorAll('[data-needs-item]') || [];
    if (kind === 'add-item' && rows.length < 20) container.insertAdjacentHTML('beforeend', itemRow());
    else if (kind === 'remove-item' && rows.length > 1) action.closest('[data-needs-item]')?.remove();
    updateGate(); duplicateWarning();
  }
  function handleInput(event) {
    if (!mount?.contains(event.target)) return;
    const previousRevision = revision;
    synchronize();
    if (revision !== previousRevision) { mountPage(); return; }
    const form = event.target.closest?.('[data-needs-update-form]');
    if (form) { rememberDraft(form); return; }
    const map = { needsSearch: 'search', needsStatusFilter: 'status', needsCategoryFilter: 'category', needsUrgencyFilter: 'urgency', needsSpaceFilter: 'space' };
    const filter = map[event.target.id];
    if (filter) { filters[filter] = event.target.value || ''; renderList(true); return; }
    if (state.mode === 'evacuee') duplicateWarning();
  }
  function handleSubmit(event) {
    if (!mount?.contains(event.target)) return;
    if (event.target.id === 'needsForm') { event.preventDefault(); submitRequest(); }
    else if (event.target.matches?.('[data-needs-update-form]')) { event.preventDefault(); updateRequest(event.target); }
    else if (event.target.id === 'needsFilters') event.preventDefault();
  }
  function installListeners() {
    if (listenersInstalled) return;
    listenersInstalled = true;
    document.addEventListener('click', handleNeedsNavigation, true);
    document.addEventListener('click', handleClick);
    document.addEventListener('input', handleInput);
    document.addEventListener('change', handleInput);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('focusout', () => {
      if (pendingListRender) setTimeout(() => { if (pendingListRender) renderList(); }, 0);
    });
    window.addEventListener('focus', () => { refresh(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') refresh(); });
    timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') refresh(); }, 15000);
  }
  function installAuthListener() {
    const sb = client();
    if (!sb?.auth?.onAuthStateChange || authClient === sb) return;
    authSubscription?.unsubscribe?.();
    authClient = sb;
    const registered = sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (state.ownerId && String(session?.user?.id || '') !== state.ownerId)) reset();
      // Supabase auth callbacks must return before another request is made.
    });
    authSubscription = registered?.data?.subscription || null;
  }
  function init(configuration) {
    if (configuration) options = { ...options, ...configuration };
    installListeners();
    installAuthListener();
    return refresh();
  }
  function inspect() {
    return { mode: state.mode, ownerId: state.ownerId, subjectId: state.ownerId, loaded: state.loaded, eligible: state.eligible, busy: state.submitting || state.updating.size > 0, token: state.token, pendingToken: state.token, counts: { ...state.counts }, requestCount: state.requests.length, rows: state.requests.slice(), error: state.error, lastError: state.error, polling: timer !== null };
  }
  window.ScanSafeNeeds = { init, refresh, inspect, reset };
})();
