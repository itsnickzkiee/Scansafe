/* ScanSafe: authenticated evacuation operations, release review and occupancy reconciliation. */
(function () {
  'use strict';

  const summaryKeys = ['groups', 'people', 'evacuees', 'pending_requests', 'occupied', 'capacity', 'spaces', 'discrepancies'];
  const boundMounts = new WeakSet();
  let options = {};
  let mount = null;
  let generation = 0;
  let requestNumber = 0;
  let refreshPromise = null;
  let timer = null;
  let nextRefresh = 0;
  let state = freshState();

  function freshState() {
    return {
      ownerId: null, role: null, loaded: false, error: '', data: null,
      busy: new Set(), feedback: '', feedbackKind: '', preview: null,
      start: { name: '', token: null, fingerprint: null },
      close: { reason: '', departed: false, text: '', cancelPending: false },
      readmit: { groupId: '', reason: '' }
    };
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }
  function $(id) { return document.getElementById(id); }
  function context() {
    const source = (typeof options.getContext === 'function' ? options.getContext() : null) || {};
    const ownerId = source.userId || source.ownerId || source.session?.user?.id || null;
    if (source.profile?.id && String(source.profile.id) !== String(ownerId)) return { ownerId: null, role: null };
    return { ownerId: ownerId ? String(ownerId) : null, role: source.role || source.profile?.role || null };
  }
  function keyOf(subject) { return [subject.ownerId || '', subject.role || ''].join('|'); }
  function isCurrent(revision, key) { return generation === revision && keyOf(state) === key && keyOf(context()) === key; }
  function client() { return typeof options.getClient === 'function' ? options.getClient() : null; }
  function currentId() { return state.data?.current_operation?.operation_id; }
  function sameId(first, second) { return first != null && second != null && String(first) === String(second); }
  function date(value) {
    const parsed = value ? new Date(value) : null;
    return !parsed || Number.isNaN(parsed.getTime()) ? 'Not recorded' : parsed.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function count(value) { return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0; }
  function displayCount(value) { return count(value).toLocaleString('en-PH'); }
  function validSummary(summary) { return summary && summaryKeys.every(key => Number.isFinite(Number(summary[key])) && Number(summary[key]) >= 0); }
  function summarySignature(summary) { return summaryKeys.map(key => String(summary?.[key] ?? '')).join('|'); }
  function validOperation(operation, status) {
    return operation && /^\d+$/.test(String(operation.operation_id)) && typeof operation.name === 'string' && operation.name.trim() && operation.status === status;
  }
  function readableError(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || error || 'The operation could not be completed.');
    if (['PGRST202', 'PGRST204', '42883', '42P01', '42703'].includes(code) || /could not find.*(function|table)|schema cache/i.test(message)) {
      return 'Evacuation operations are not set up yet. Run SUPABASE_EVACUATION_OPERATIONS.sql in Supabase, then refresh this page.';
    }
    if (code === '40001') return 'The operation changed. Load a fresh close review and confirm its latest counts before continuing. Your reason has been kept.';
    if (/failed to fetch|network|load failed|timeout/i.test(message)) return 'Connection failed. The result has not been confirmed. Your draft has been kept; refresh to check the current operation before retrying.';
    return message;
  }
  function clearSession() {
    generation += 1;
    requestNumber += 1;
    refreshPromise = null;
    state = freshState();
    if (mount) {
      mount.innerHTML = '';
      mount.hidden = true;
      mount.removeAttribute('aria-busy');
    }
  }
  function synchronize() {
    const subject = context();
    if (keyOf(subject) !== keyOf(state)) {
      clearSession();
      state.ownerId = subject.ownerId;
      state.role = subject.role;
    }
    if (mount) mount.hidden = !subject.ownerId || subject.role !== 'admin';
    return subject;
  }
  function feedback(message, kind) {
    state.feedback = message || '';
    state.feedbackKind = kind || 'error';
    const box = $('operationsFeedback');
    if (box) {
      box.textContent = state.feedback;
      box.hidden = !state.feedback;
      box.className = 'evac-ops-feedback' + (state.feedbackKind === 'success' ? ' is-success' : ' is-error');
    }
  }
  function shell() {
    if (!mount || $('operationsSummary')) return;
    mount.innerHTML = '<div class="evac-ops-header"><div><span class="evac-ops-eyebrow">Shelter operations</span><h2>Evacuation Operations</h2><p>Close a completed evacuation while keeping its assignments, requests and history.</p></div>' +
      '<button type="button" class="btn out" id="operationsRefresh">Refresh</button></div>' +
      '<div id="operationsFeedback" class="evac-ops-feedback" role="status" aria-live="polite" hidden></div>' +
      '<div id="operationsLoadError" class="evac-ops-feedback is-error" role="alert" hidden></div>' +
      '<div id="operationsSummary" aria-live="polite"><p class="evac-ops-empty">Loading the current evacuation...</p></div>' +
      '<div class="evac-ops-layout"><section class="evac-ops-panel" id="operationsActivePanel" hidden><h3>Current operation</h3><p id="operationsCurrentName" class="evac-ops-operation-name"></p><p id="operationsCurrentMeta" class="evac-ops-muted"></p>' +
      '<div class="evac-ops-actions"><button type="button" class="btn red" id="operationsPreviewClose">Review End Evacuation</button><button type="button" class="btn out" id="operationsReconcile">Recalculate Occupancy</button></div>' +
      '<p class="evac-ops-help">Ending an evacuation releases active stays and closes their assignments. Recalculating uses active assignments to correct the map count.</p><a class="evac-ops-link" href="needs-requests.html">Review unresolved needs requests &rarr;</a></section>' +
      '<form class="evac-ops-panel" id="operationsStartForm" hidden><h3>Start the next evacuation</h3><p class="evac-ops-muted">Create a new operation. Previous records stay in history.</p><label for="operationsStartName">Operation name</label><input id="operationsStartName" name="operation_name" maxlength="120" placeholder="e.g. October Flood Response" required autocomplete="off"><button type="submit" class="btn red" id="operationsStart">Start Evacuation</button></form>' +
      '<form class="evac-ops-panel" id="operationsReadmitForm" hidden><h3>Returning evacuees</h3><p class="evac-ops-muted">Readmit a released group into the current operation, then scan an approved barcode to assign an available space.</p><label for="operationsReadmitGroup">Released group</label><select id="operationsReadmitGroup" required><option value="">Select a released group</option></select><label for="operationsReadmitReason">Reason for readmission</label><textarea id="operationsReadmitReason" rows="2" maxlength="1000" required placeholder="Why is this group returning?"></textarea><button type="submit" class="btn out" id="operationsReadmit">Readmit Group</button><p id="operationsReadmitEmpty" class="evac-ops-help" hidden>No released groups are waiting for readmission.</p></form></div>' +
      '<section id="operationsCloseReview" class="evac-ops-close-review" aria-labelledby="operationsCloseHeading" tabindex="-1" hidden></section>' +
      '<section class="evac-ops-history"><h3>Operation history</h3><div id="operationsHistory"><p class="evac-ops-empty">Loading history...</p></div></section>';
    if (!boundMounts.has(mount)) {
      mount.addEventListener('click', onClick);
      mount.addEventListener('submit', onSubmit);
      mount.addEventListener('input', captureDraft);
      mount.addEventListener('change', captureDraft);
      boundMounts.add(mount);
    }
  }
  function captureDraft() {
    if (!state.ownerId || state.role !== 'admin') return;
    if ($('operationsStartName')) state.start.name = $('operationsStartName').value;
    if ($('operationsReadmitGroup')) state.readmit.groupId = $('operationsReadmitGroup').value;
    if ($('operationsReadmitReason')) state.readmit.reason = $('operationsReadmitReason').value;
    if ($('operationsCloseReason')) state.close.reason = $('operationsCloseReason').value;
    if ($('operationsConfirmDeparted')) state.close.departed = $('operationsConfirmDeparted').checked;
    if ($('operationsConfirmText')) state.close.text = $('operationsConfirmText').value;
    if ($('operationsCancelPending')) state.close.cancelPending = $('operationsCancelPending').checked;
    updateControls();
  }
  function mutationAllowed() { return state.loaded && !state.error && state.ownerId && state.role === 'admin'; }
  function canClose() {
    return mutationAllowed() && state.preview && !state.preview.stale && sameId(state.preview.operation_id, currentId()) &&
      state.close.departed && state.close.text === 'CLOSE' && state.close.reason.trim().length > 0 && state.close.reason.length <= 1000 &&
      (count(state.preview.summary.pending_requests) === 0 || state.close.cancelPending);
  }
  function updateControls() {
    const busy = state.busy.size > 0;
    const ready = mutationAllowed() && !busy;
    const operations = {
      operationsStart: ready && !currentId() && state.start.name.trim().length > 0,
      operationsPreviewClose: ready && !!currentId(),
      operationsRefreshPreview: ready && !!currentId(),
      operationsReconcile: ready,
      operationsReadmit: ready && !!currentId() && !!state.readmit.groupId && state.readmit.reason.trim().length > 0,
      operationsConfirmClose: ready && canClose(),
      operationsCancelClose: !busy,
      operationsRefresh: !busy && state.ownerId && state.role === 'admin'
    };
    Object.entries(operations).forEach(([id, enabled]) => { const button = $(id); if (button) button.disabled = !enabled; });
    const labels = { operationsStart: ['start', 'Starting...', 'Start Evacuation'], operationsPreviewClose: ['preview', 'Loading review...', 'Review End Evacuation'], operationsReconcile: ['reconcile', 'Recalculating...', 'Recalculate Occupancy'], operationsReadmit: ['readmit', 'Readmitting...', 'Readmit Group'], operationsConfirmClose: ['close', 'Ending evacuation...', 'Confirm End Evacuation'] };
    Object.entries(labels).forEach(([id, values]) => { if ($(id)) $(id).textContent = state.busy.has(values[0]) ? values[1] : values[2]; });
    if (mount) mount.setAttribute('aria-busy', String(busy || !!refreshPromise));
  }
  function summaryMarkup(summary) {
    const metrics = [['groups', 'Assigned groups'], ['people', 'Assigned people'], ['occupied', 'Map occupancy'], ['pending_requests', 'Unresolved requests']];
    return '<div class="evac-ops-stats">' + metrics.map(([key, label]) => '<div class="evac-ops-stat"><span>' + label + '</span><strong>' + displayCount(summary[key]) + '</strong></div>').join('') + '</div>' +
      '<p class="evac-ops-capacity">' + displayCount(summary.spaces) + ' spaces &middot; ' + displayCount(summary.capacity) + ' total capacity' +
      (count(summary.discrepancies) ? ' <span class="evac-ops-discrepancy">' + displayCount(summary.discrepancies) + ' space counts need reconciliation</span>' : '') + '</p>';
  }
  function invalidatePreview(message) {
    if (!state.preview) return;
    captureDraft();
    state.preview.stale = true;
    state.preview.staleMessage = message || 'The operation changed. Refresh this review and confirm its updated details.';
    state.close.departed = false;
    state.close.text = '';
    state.close.cancelPending = false;
    renderPreview();
  }
  function archivedStays(record) {
    const stays = Array.isArray(record.stays) ? record.stays : [];
    if (!stays.length) return '<p class="evac-ops-muted">No recorded stays.</p>';
    return '<h4 class="evac-ops-archive-heading">Archived stays</h4><div class="evac-ops-archive">' + stays.map(stay => {
      const assignments = Array.isArray(stay.assignments) ? stay.assignments : [];
      const requests = Array.isArray(stay.requests) ? stay.requests : [];
      return '<article class="evac-ops-stay"><strong>' + esc(stay.full_name || ('Group ' + stay.group_id)) + '</strong><span class="evac-ops-stay-count">' + displayCount(stay.group_size) + ' people &middot; ' + esc(stay.status || 'Released') + '</span>' +
        '<p>Admitted: ' + esc(date(stay.admitted_at)) + '<br>Released: ' + esc(date(stay.released_at)) + '</p>' +
        (assignments.length ? '<ul>' + assignments.map(assignment => '<li><strong>' + esc(assignment.space_name || assignment.space_code || 'Accommodation space') + '</strong> &middot; ' + esc(assignment.assignment_status || 'Closed') + '<br>' + esc(date(assignment.assigned_at)) + ' &rarr; ' + esc(date(assignment.completed_at)) + '</li>').join('') + '</ul>' : '<p class="evac-ops-muted">No recorded accommodation assignments.</p>') +
        (requests.length ? '<p>Needs requests: ' + requests.map(request => '#' + esc(request.request_id) + ' (' + esc(String(request.status || 'Unknown').replace(/_/g, ' ')) + ')').join(', ') + '</p>' : '<p class="evac-ops-muted">No recorded needs requests.</p>') + '</article>';
    }).join('') + '</div>';
  }
  function renderData() {
    if (!mount || !state.data) return;
    captureDraft();
    const operation = state.data.current_operation;
    $('operationsSummary').innerHTML = summaryMarkup(state.data.summary);
    $('operationsActivePanel').hidden = !operation;
    $('operationsStartForm').hidden = !!operation;
    $('operationsReadmitForm').hidden = !operation;
    $('operationsStartName').value = state.start.name;
    $('operationsReadmitReason').value = state.readmit.reason;
    if (operation) {
      $('operationsCurrentName').textContent = operation.name;
      $('operationsCurrentMeta').textContent = 'Active since ' + date(operation.opened_at);
    }
    const groups = state.data.readmission_groups;
    $('operationsReadmitGroup').innerHTML = '<option value="">Select a released group</option>' + groups.map(group => '<option value="' + esc(group.group_id) + '">' + esc(group.full_name || group.group_name || ('Group ' + group.group_id)) + ' · ' + displayCount(group.group_size) + ' people' + (group.last_operation_name ? ' · ' + esc(group.last_operation_name) : '') + '</option>').join('');
    if (!groups.some(group => String(group.group_id) === state.readmit.groupId)) state.readmit.groupId = '';
    $('operationsReadmitGroup').value = state.readmit.groupId;
    $('operationsReadmitGroup').disabled = !groups.length;
    $('operationsReadmitEmpty').hidden = groups.length > 0;
    $('operationsHistory').innerHTML = state.data.history.length ? '<div class="evac-ops-table-wrap"><table class="evac-ops-table"><thead><tr><th scope="col">Operation</th><th scope="col">Closed</th><th scope="col">Released</th><th scope="col">Details</th></tr></thead><tbody>' + state.data.history.map(record => '<tr><td><strong>' + esc(record.name) + '</strong><span class="evac-ops-status">Closed</span></td><td>' + esc(date(record.closed_at)) + '</td><td>' + displayCount(record.summary?.groups) + ' groups<br>' + displayCount(record.summary?.people) + ' people</td><td><details><summary>View closure summary and stays</summary><p>' + esc(record.close_reason || 'No reason recorded') + '</p><p>' + displayCount(record.summary?.evacuees) + ' evacuee records released; ' + displayCount(record.summary?.cancelled_requests) + ' requests cancelled.</p>' + archivedStays(record) + '</details></td></tr>').join('') + '</tbody></table></div>' : '<p class="evac-ops-empty">No closed operations yet. Completed evacuations will appear here.</p>';
    if (state.preview && (!sameId(state.preview.operation_id, operation?.operation_id) || summarySignature(state.preview.summary) !== summarySignature(state.data.summary))) {
      invalidatePreview('The current assignment or request counts changed. Load a fresh review before confirming.');
    }
    updateControls();
  }
  function renderPreview() {
    const region = $('operationsCloseReview');
    if (!region) return;
    region.hidden = !state.preview;
    if (!state.preview) { region.innerHTML = ''; return; }
    const preview = state.preview;
    region.innerHTML = '<div class="evac-ops-review-heading"><div><span class="evac-ops-eyebrow">Review before ending</span><h3 id="operationsCloseHeading">End ' + esc(preview.name) + '?</h3></div><button type="button" class="btn out" id="operationsCancelClose">Cancel</button></div>' +
      (preview.stale ? '<div class="evac-ops-feedback is-error" role="alert">' + esc(preview.staleMessage) + '<button type="button" class="btn out" id="operationsRefreshPreview">Load Fresh Review</button></div>' : '') +
      summaryMarkup(preview.summary) + '<p class="evac-ops-help">All active assignments will close and the related evacuee stays will be marked Released. The map will be recalculated. Accounts, barcodes, spaces and operation history remain available.</p>' +
      '<form id="operationsCloseForm"><label for="operationsCloseReason">Closure reason</label><textarea id="operationsCloseReason" rows="3" maxlength="1000" required placeholder="Record why this evacuation is ending">' + esc(state.close.reason) + '</textarea>' +
      (count(preview.summary.pending_requests) > 0 ? '<div class="evac-ops-pending"><strong>' + displayCount(preview.summary.pending_requests) + ' unresolved needs requests</strong><p>Resolve them in <a href="needs-requests.html">Needs Requests</a>, or explicitly cancel them as part of this closure.</p><label class="evac-ops-check"><input id="operationsCancelPending" type="checkbox"' + (state.close.cancelPending ? ' checked' : '') + '><span>Cancel these unresolved requests using the closure reason above. They will remain in request history.</span></label></div>' : '') +
      '<label class="evac-ops-check"><input id="operationsConfirmDeparted" type="checkbox"' + (state.close.departed ? ' checked' : '') + ' required><span>I confirm all assigned people have departed and their shelter stays can be released.</span></label>' +
      '<label for="operationsConfirmText">Type <strong>CLOSE</strong> to confirm</label><input id="operationsConfirmText" maxlength="5" autocomplete="off" spellcheck="false" value="' + esc(state.close.text) + '" required>' +
      '<div class="evac-ops-actions"><button type="submit" class="btn red" id="operationsConfirmClose">Confirm End Evacuation</button></div></form>';
    updateControls();
  }
  async function rpc(name, args) {
    const sb = client();
    if (!sb || typeof sb.rpc !== 'function') throw new Error('The live database connection is unavailable. Refresh after signing in.');
    const result = await sb.rpc(name, args || {});
    if (result?.error) throw result.error;
    if (!result || result.data == null) throw new Error('The server returned no confirmation. Refresh to check the current operation.');
    return result.data;
  }
  function validateData(data) {
    if (!data || String(data.owner_id) !== state.ownerId || data.mode !== 'admin') throw new Error('The operation response does not match your signed-in administrator account. Sign in again.');
    if (!validSummary(data.summary) || !Array.isArray(data.history) || !Array.isArray(data.readmission_groups) || (data.current_operation != null && !validOperation(data.current_operation, 'active'))) throw new Error('The server returned incomplete operation details. Refresh before making changes.');
    return data;
  }
  async function refresh() {
    mount = $('evacuationOperationsApp');
    if (!mount) return;
    const subject = synchronize();
    if (!subject.ownerId || subject.role !== 'admin') return;
    shell();
    if (refreshPromise) return refreshPromise;
    const revision = generation;
    const key = keyOf(subject);
    const request = ++requestNumber;
    const run = (async () => {
      try {
        const data = await rpc('get_scansafe_operations');
        if (!isCurrent(revision, key) || request !== requestNumber) return;
        state.data = validateData(data);
        state.loaded = true;
        state.error = '';
        $('operationsLoadError').hidden = true;
        renderData();
      } catch (error) {
        if (!isCurrent(revision, key) || request !== requestNumber) return;
        state.error = readableError(error);
        $('operationsLoadError').textContent = state.error;
        $('operationsLoadError').hidden = false;
      } finally {
        if (isCurrent(revision, key) && request === requestNumber) {
          refreshPromise = null;
          nextRefresh = Date.now() + 30000;
          updateControls();
        }
      }
    })();
    refreshPromise = run;
    updateControls();
    return run;
  }
  function retryToken() {
    if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
    if (typeof window.crypto?.getRandomValues !== 'function') throw new Error('This browser cannot create a secure request token. Use a current browser with HTTPS.');
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }
  async function refreshRelated() {
    await refresh();
    if (typeof options.refresh === 'function') {
      try { await options.refresh(); } catch (_) { /* Successful server changes stay confirmed; each live view reports its own refresh errors. */ }
    }
  }
  async function action(name, callback) {
    synchronize();
    if (!mutationAllowed() || state.busy.size) return;
    captureDraft();
    const revision = generation;
    const key = keyOf(state);
    // A read started before a mutation must not replace its confirmed result or
    // be mistaken for the fresh read after it. Its own finally is also scoped by
    // requestNumber, so it cannot clear a newer refresh promise.
    if (name !== 'preview') {
      requestNumber += 1;
      refreshPromise = null;
    }
    state.busy.add(name);
    feedback('', 'error');
    updateControls();
    try {
      await callback(() => isCurrent(revision, key));
    } catch (error) {
      if (isCurrent(revision, key)) feedback(readableError(error), 'error');
    } finally {
      if (isCurrent(revision, key)) { state.busy.delete(name); updateControls(); }
    }
  }
  function previewClose() {
    return action('preview', async current => {
      const operationId = currentId();
      if (!operationId) throw new Error('There is no active evacuation to end.');
      const preview = await rpc('preview_close_scansafe_operation', { p_operation_id: operationId });
      if (!current()) return;
      if (!sameId(preview.operation_id, operationId) || typeof preview.name !== 'string' || !preview.name.trim() || preview.revision == null || !validSummary(preview.summary)) throw new Error('The server returned an incomplete close review. Refresh before confirming.');
      state.preview = { ...preview, stale: false };
      state.close.departed = false;
      state.close.text = '';
      state.close.cancelPending = false;
      renderPreview();
      $('operationsCloseReview').focus();
      $('operationsCloseReview').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
  }
  function startOperation() {
    return action('start', async current => {
      if (currentId()) throw new Error('An evacuation is already active. Refresh before starting another.');
      const name = state.start.name.trim();
      if (!name || name.length > 120) throw new Error('Enter an operation name between 1 and 120 characters.');
      if (!state.start.token || state.start.fingerprint !== name) {
        state.start.token = retryToken();
        state.start.fingerprint = name;
      }
      const result = await rpc('start_scansafe_operation', { p_name: name, p_client_token: state.start.token });
      if (!current()) return;
      if (!validOperation(result, 'active') || result.name !== name) throw new Error('The server did not confirm the requested evacuation. Refresh to check before retrying.');
      state.start = { name: '', token: null, fingerprint: null };
      $('operationsStartName').value = '';
      feedback('Evacuation started. Readmit returning groups or scan new approved registrations to assign accommodation.', 'success');
      await refreshRelated();
    });
  }
  function closeOperation() {
    return action('close', async current => {
      if (!canClose()) throw new Error('Review the latest operation, enter a reason, confirm everyone has departed and type CLOSE. Explicitly cancel unresolved requests if any remain.');
      const preview = state.preview;
      try {
        const result = await rpc('close_scansafe_operation', {
          p_operation_id: preview.operation_id, p_expected_revision: preview.revision,
          p_confirm_text: state.close.text, p_reason: state.close.reason.trim(),
          p_cancel_pending: count(preview.summary.pending_requests) > 0 && state.close.cancelPending
        });
        if (!current()) return;
        if (!validOperation(result, 'closed') || !sameId(result.operation_id, preview.operation_id) || !result.summary || !Number.isFinite(Number(result.summary.groups)) || !Number.isFinite(Number(result.summary.people))) throw new Error('The server did not confirm evacuation closure. Refresh to check the current operation.');
        state.preview = null;
        state.close = { reason: '', departed: false, text: '', cancelPending: false };
        renderPreview();
        feedback('Evacuation ended. Active stays were released, assignments closed and map occupancy recalculated. The records remain in operation history.', 'success');
        await refreshRelated();
      } catch (error) {
        if (!current()) return;
        invalidatePreview(String(error?.code) === '40001' ? 'The server detected changes since this review. Load a fresh review and confirm the updated details.' : 'Closure has not been confirmed. Refresh the operation and load a fresh review before trying again.');
        await refresh();
        throw error;
      }
    });
  }
  function reconcile() {
    return action('reconcile', async current => {
      const result = await rpc('reconcile_scansafe_occupancy');
      if (!current()) return;
      if (!result || result.reconciled !== true) throw new Error('The server did not confirm occupancy recalculation. Refresh to check the current counts.');
      if (state.preview) invalidatePreview('Occupancy was recalculated. Load a fresh close review before confirming.');
      feedback('Map occupancy was recalculated from active assignments.', 'success');
      await refreshRelated();
    });
  }
  function readmit() {
    return action('readmit', async current => {
      const group = state.data.readmission_groups.find(item => String(item.group_id) === state.readmit.groupId);
      const reason = state.readmit.reason.trim();
      if (!currentId() || !group || !reason || reason.length > 1000) throw new Error('Select a released group and enter a readmission reason.');
      const operationId = currentId();
      const result = await rpc('readmit_scansafe_group', { p_group_id: group.group_id, p_reason: reason });
      if (!current()) return;
      if (result.readmitted !== true || !sameId(result.group_id, group.group_id) || !sameId(result.operation_id, operationId)) throw new Error('The server did not confirm this group\'s readmission. Refresh before trying again.');
      state.readmit = { groupId: '', reason: '' };
      $('operationsReadmitGroup').value = '';
      $('operationsReadmitReason').value = '';
      feedback('Group readmitted. Scan an approved barcode in Barcode Scanner to assign an available space. Readmission alone does not reserve accommodation.', 'success');
      await refreshRelated();
    });
  }
  function onClick(event) {
    const button = event.target?.closest?.('button');
    if (!button || button.disabled) return;
    if (button.id === 'operationsRefresh') { refresh(); return; }
    if (button.id === 'operationsPreviewClose' || button.id === 'operationsRefreshPreview') { previewClose(); return; }
    if (button.id === 'operationsReconcile') { reconcile(); return; }
    if (button.id === 'operationsCancelClose' && !state.busy.size) {
      captureDraft();
      state.preview = null;
      state.close.departed = false;
      state.close.text = '';
      state.close.cancelPending = false;
      renderPreview();
      $('operationsPreviewClose')?.focus();
    }
  }
  function onSubmit(event) {
    const id = event.target?.id;
    if (!['operationsStartForm', 'operationsReadmitForm', 'operationsCloseForm'].includes(id)) return;
    event.preventDefault();
    if (id === 'operationsStartForm') startOperation();
    if (id === 'operationsReadmitForm') readmit();
    if (id === 'operationsCloseForm') closeOperation();
  }
  function reset() {
    if (timer) window.clearInterval(timer);
    timer = null;
    clearSession();
    options = {};
  }
  function init(configuration) {
    reset();
    options = configuration || {};
    mount = $('evacuationOperationsApp');
    if (!mount) return Promise.resolve();
    timer = window.setInterval(() => {
      const subject = synchronize();
      if (subject.ownerId && subject.role === 'admin' && !document.hidden && !state.busy.size && Date.now() >= nextRefresh) refresh();
    }, 1000);
    return refresh();
  }
  window.ScanSafeOperations = {
    init, refresh, reset,
    inspect: () => ({ ownerId: state.ownerId, role: state.role, loaded: state.loaded, busy: Array.from(state.busy), operationId: currentId(), preview: state.preview ? { operationId: state.preview.operation_id, revision: state.preview.revision, stale: !!state.preview.stale } : null, error: state.error })
  };
})();
