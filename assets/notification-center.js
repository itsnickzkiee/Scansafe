(function () {
  'use strict';

  const bellSelector = '.admin-top .notif, .user-top .notif';
  let options = {}, ownerId = null, role = null, epoch = 0, sequence = 0;
  let items = [], unread = 0, total = 0, loaded = false, loadError = '', hasMore = false;
  let panel = null, opened = false, selectedId = null, selectedItem = null, markError = '', markingId = null;
  let poll = null, channel = null, channelClient = null, trigger = null, refreshTask = null;
  let pageFilter = 'all', pageSelectedId = null, pageBound = false;
  let dashboardObserver = null, dashboardPainting = false;
  const bindings = new Map();

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function button(text, action, id) {
    const element = node('button', 'notification-center-tool', text);
    element.type = 'button';
    element.dataset.notificationAction = action;
    if (id) element.id = id;
    return element;
  }
  function dashboardAnnouncement() {
    if (role !== 'evacuee' || !loaded) return null;
    return items.find(function (item) {
      return item && (item.audience === 'evacuees' || item.audience === 'all')
        && ['announcement','emergency','system','accommodation'].includes(item.category);
    }) || null;
  }
  function paintDashboardLatest() {
    const card = document.getElementById('userLatestCard');
    const item = dashboardAnnouncement();
    if (!card || !item || dashboardPainting) return;
    const id = String(item.notification_id);
    if (card.querySelector('[data-dashboard-notification-id="' + id + '"]')) return;
    dashboardPainting = true;
    const urgent = item.notification_level === 'urgent' || item.category === 'emergency';
    const warning = item.notification_level === 'warning';
    const safe = function(v){ return String(v||'').replace(/[<>&]/g,''); };
    card.innerHTML =
      '<div data-dashboard-notification-id="' + safe(id) + '" class="notification-dashboard-update">' +
        '<div class="app-status-icon">' + (urgent ? '!' : '●') + '</div>' +
        '<div class="notification-dashboard-copy">' +
          '<div class="notification-dashboard-kicker">Latest Update' + (!item.is_read ? ' • New' : '') + '</div>' +
          '<div class="app-value">' + safe(item.title || 'Shelter Announcement') + '</div>' +
          '<p>' + safe(item.message || '') + '</p>' +
          '<small>' + safe(dateText(item.created_at)) + '</small>' +
        '</div>' +
      '</div>';
    card.classList.toggle('is-urgent-update', urgent);
    card.classList.toggle('is-warning-update', warning && !urgent);
    card.setAttribute('role','button');
    card.setAttribute('tabindex','0');
    card.onclick = function () { location.href='user-notifications.html'; };
    card.onkeydown = function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); location.href='user-notifications.html';
      }
    };
    dashboardPainting = false;
    if (!dashboardObserver) {
      dashboardObserver = new MutationObserver(function () {
        if (dashboardPainting) return;
        const current = document.getElementById('userLatestCard');
        if (current && !current.querySelector('[data-dashboard-notification-id="' + id + '"]')) {
          setTimeout(paintDashboardLatest,0);
        }
      });
      dashboardObserver.observe(card,{childList:true,subtree:true});
    }
  }

  function context() {
    const value = options.getContext ? options.getContext() : null;
    const userId = value && value.userId;
    const currentRole = value && value.role;
    if (!userId || !['admin', 'staff', 'evacuee'].includes(currentRole)) return null;
    if (value.profile && value.profile.id && String(value.profile.id) !== String(userId)) return null;
    return { userId: String(userId), role: currentRole };
  }
  function current(stamp) {
    const value = context();
    return epoch === stamp && value && value.userId === ownerId && value.role === role;
  }
  function stopRealtime() {
    if (channel && channelClient && channelClient.removeChannel) {
      try { Promise.resolve(channelClient.removeChannel(channel)).catch(function () {}); } catch (_) {}
    }
    channel = null; channelClient = null;
  }
  function clearAccount() {
    epoch++; sequence++; refreshTask = null;
    stopRealtime();
    close(false);
    ownerId = null; role = null; items = []; unread = 0; total = 0;
    loaded = false; loadError = ''; hasMore = false; selectedId = null; selectedItem = null; markError = ''; markingId = null;
    pageFilter = 'all'; pageSelectedId = null;
    if (panel) panel.replaceChildren();
    if (dashboardObserver) { dashboardObserver.disconnect(); dashboardObserver = null; }
    dashboardPainting = false;
    paintBells();
  }
  function syncAccount() {
    const value = context();
    if (!value) { if (ownerId) clearAccount(); paintBells(); return false; }
    if (value.userId !== ownerId || value.role !== role) {
      clearAccount(); ownerId = value.userId; role = value.role;
    }
    attachBells(); paintBells();
    return true;
  }
  function paintBells() {
    document.querySelectorAll(bellSelector).forEach(function (bell) {
      bell.removeAttribute('data-unread-count');
      if (ownerId && loaded && unread > 0) bell.setAttribute('data-unread-count', String(unread));
      bell.setAttribute('aria-label', ownerId && loaded ? 'Notifications, ' + unread + ' unread' : 'Notifications');
      bell.setAttribute('aria-expanded', String(opened && !!ownerId));
      bell.setAttribute('aria-disabled', String(!ownerId));
      bell.setAttribute('data-notification-status', loadError ? 'error' : loaded ? 'ready' : 'loading');
    });
    document.querySelectorAll('a[href="user-notifications.html"]').forEach(function (link) {
      let badge = link.querySelector('[data-notification-nav-count]');
      if (!badge) {
        badge = node('b', 'nav-badge');
        badge.setAttribute('data-notification-nav-count', '');
        link.appendChild(badge);
      }
      const count = ownerId && loaded ? unread : 0;
      badge.textContent = String(count);
      badge.hidden = !(count > 0);
      badge.setAttribute('aria-label', count + ' unread notifications');
    });
    paintDashboardLatest();
  }
  function attachBells() {
    document.querySelectorAll(bellSelector).forEach(function (bell) {
      if (bindings.has(bell)) return;
      bell.classList.add('scansafe-notification-bell');
      if (bell.tagName !== 'BUTTON') { bell.setAttribute('role', 'button'); bell.setAttribute('tabindex', '0'); }
      bell.setAttribute('aria-haspopup', 'dialog'); bell.setAttribute('aria-controls', 'scansafeNotificationCenter');
      const click = function (event) {
        event.preventDefault();
        if (!syncAccount()) return;
        if (opened) close(); else open(bell);
      };
      const key = function (event) {
        if (bell.tagName !== 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) click(event);
      };
      bell.addEventListener('click', click); bell.addEventListener('keydown', key);
      bindings.set(bell, { click: click, key: key });
    });
  }

  function pageMatches(item) {
    if (pageFilter === 'unread') return !item.is_read;
    if (pageFilter === 'emergency') return item.category === 'emergency' || item.notification_level === 'urgent';
    return true;
  }
  function setPageDetail(item) {
    const detail = document.getElementById('notifDetail');
    if (!detail) return;
    detail.replaceChildren();
    if (!item) {
      const empty = node('div', 'space-placeholder', 'Select an official notification to view its details.');
      detail.append(empty);
      return;
    }
    const heading = node('h3', 'section-h', item.title || 'Shelter update');
    const meta = node('div', 'notification-center-time', dateText(item.created_at));
    const message = node('p', 'notification-center-message', item.message || '');
    const state = node('p', 'notification-center-read-status', item.is_read ? 'Read' : 'Unread');
    detail.append(heading, meta, message, state);
  }
  function bindPageTabs() {
    if (pageBound) return;
    const tabs = Array.from(document.querySelectorAll('.notify-grid .tabs .tab'));
    if (!tabs.length) return;
    const filters = ['all', 'unread', 'emergency'];
    tabs.forEach(function (tab, index) {
      const filter = filters[index] || 'all';
      tab.dataset.notificationFilter = filter;
      tab.setAttribute('role', 'button');
      tab.setAttribute('tabindex', '0');
      const activate = function () {
        pageFilter = filter;
        pageSelectedId = null;
        renderPage();
      };
      tab.addEventListener('click', activate);
      tab.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
      });
    });
    pageBound = true;
  }
  function renderPage() {
    const detail = document.getElementById('notifDetail');
    const card = document.querySelector('.notify-grid > section.card');
    if (!detail || !card) return;
    bindPageTabs();

    const tabs = Array.from(card.querySelectorAll('.tabs .tab'));
    const emergencyCount = items.filter(function (item) {
      return item.category === 'emergency' || item.notification_level === 'urgent';
    }).length;
    const labels = ['All (' + total + ')', 'Unread (' + unread + ')', 'Emergency (' + emergencyCount + ')'];
    tabs.forEach(function (tab, index) {
      tab.textContent = labels[index] || tab.textContent;
      tab.classList.toggle('active', (tab.dataset.notificationFilter || 'all') === pageFilter);
    });

    let host = card.querySelector('[data-notification-page-list]');
    if (!host) {
      host = node('div', 'notification-page-list');
      host.setAttribute('data-notification-page-list', '');
      const placeholder = card.querySelector('.p78-empty-notif');
      if (placeholder) placeholder.replaceWith(host); else card.append(host);
    }
    host.replaceChildren();

    if (!loaded && !loadError) {
      host.append(node('div', 'notification-center-state', 'Loading notifications…'));
      setPageDetail(null);
      return;
    }
    if (loadError) host.append(node('div', 'notification-center-error', loadError));

    const visible = items.filter(pageMatches);
    if (!visible.length) {
      host.append(node('div', 'notification-center-state', loadError ? 'Use the notification bell Refresh button to try again.' : 'No notifications in this category.'));
    } else {
      visible.forEach(function (item) {
        const row = node('button', 'notification-center-row' + (item.is_read ? '' : ' is-unread'));
        row.type = 'button';
        row.dataset.notificationPageId = String(item.notification_id);
        const dot = node('span', 'notification-center-dot'); dot.setAttribute('aria-hidden', 'true');
        const copy = node('span');
        copy.append(
          node('span', 'notification-center-title', item.title || 'Shelter update'),
          node('span', 'notification-center-preview', item.message || ''),
          node('span', 'notification-center-time', dateText(item.created_at))
        );
        row.append(dot, copy);
        row.addEventListener('click', function () {
          pageSelectedId = String(item.notification_id);
          setPageDetail(item);
          markRead(item.notification_id);
        });
        host.append(row);
      });
    }

    const selected = items.find(function (item) { return String(item.notification_id) === String(pageSelectedId); }) || null;
    setPageDetail(selected);

    const announcementHost = document.querySelector('.announcement-grid');
    if (announcementHost) {
      announcementHost.replaceChildren();
      const announcements = items.filter(function (item) {
        return item.category === 'announcement' || item.category === 'emergency';
      }).slice(0, 4);
      if (!announcements.length) {
        const card = node('div', 'download-card');
        card.append(node('p', 'muted', 'Official announcements will appear here.'));
        announcementHost.append(card);
      } else {
        announcements.forEach(function (item) {
          const card = node('button', 'download-card');
          card.type = 'button';
          card.style.textAlign = 'left';
          card.append(
            node('b', '', item.title || 'Announcement'),
            node('p', 'muted', item.message || ''),
            node('small', 'notification-center-time', dateText(item.created_at))
          );
          card.addEventListener('click', function () {
            pageSelectedId = String(item.notification_id);
            setPageDetail(item);
            markRead(item.notification_id);
            detail.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
          announcementHost.append(card);
        });
      }
    }
  }

  function ensurePanel() {
    if (panel) return;
    panel = node('aside'); panel.id = 'scansafeNotificationCenter'; panel.hidden = true;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'scansafeNotificationHeading');
    panel.addEventListener('click', function (event) {
      // Rendering the detail replaces the clicked row. Keep its original click
      // inside the panel even after that row has left the document.
      event.stopPropagation();
      const target = event.target.closest('[data-notification-action]');
      if (!target || !panel.contains(target)) return;
      const action = target.dataset.notificationAction;
      if (action === 'close') close();
      else if (action === 'refresh') refresh();
      else if (action === 'back') { selectedId = null; selectedItem = null; markError = ''; render(); document.getElementById('scansafeNotificationRefresh')?.focus(); }
      else if (action === 'read') select(target.dataset.notificationId);
      else if (action === 'retry-read') markRead(selectedId);
    });
    document.body.appendChild(panel);
  }
  function dateText(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function render() {
    if (!panel || !opened) return;
    const focusId = panel.contains(document.activeElement) ? document.activeElement.id : '';
    panel.replaceChildren();
    const header = node('div', 'notification-center-header');
    const heading = node('div', 'notification-center-heading');
    const title = node('h2', '', 'Notifications'); title.id = 'scansafeNotificationHeading';
    heading.append(title, node('p', 'notification-center-subtitle', loaded ? unread + ' unread · ' + total + ' total' : 'Your shelter updates and announcements'));
    header.append(heading, button('Refresh', 'refresh', 'scansafeNotificationRefresh'), button('Close', 'close', 'scansafeNotificationClose'));
    panel.append(header);
    const body = node('div', 'notification-center-body');
    if (loadError) {
      const message = node('div', 'notification-center-error', loadError);
      message.setAttribute('role', 'status'); body.append(message);
    }
    const selected = items.find(function (item) { return String(item.notification_id) === selectedId; }) || selectedItem;
    if (selected) {
      const detail = node('div', 'notification-center-detail');
      detail.append(button('← All notifications', 'back', 'scansafeNotificationBack'));
      const title = node('h3', '', selected.title || 'Shelter update'); title.id = 'scansafeNotificationDetailTitle'; title.tabIndex = -1;
      detail.append(title, node('div', 'notification-center-time', dateText(selected.created_at)), node('p', 'notification-center-message', selected.message || ''));
      const status = node('p', 'notification-center-read-status', markingId === selectedId ? 'Marking as read…' : selected.is_read ? 'Read' : 'Unread');
      status.setAttribute('role', 'status'); detail.append(status);
      if (markError) {
        const error = node('p', 'notification-center-error', markError); error.setAttribute('role', 'alert');
        detail.append(error, button('Retry marking as read', 'retry-read', 'scansafeNotificationRetryRead'));
      }
      body.append(detail);
    } else if (!loaded && !loadError) {
      const state = node('div', 'notification-center-state', 'Loading your notifications…'); state.setAttribute('role', 'status'); body.append(state);
    } else if (!items.length) {
      body.append(node('div', 'notification-center-state', loadError ? 'Use Refresh to try again.' : 'You’re all caught up. New notifications will appear here.'));
    } else {
      items.forEach(function (item) {
        const row = node('button', 'notification-center-row' + (item.is_read ? '' : ' is-unread'));
        row.type = 'button'; row.id = 'scansafeNotificationItem-' + item.notification_id;
        row.dataset.notificationAction = 'read'; row.dataset.notificationId = String(item.notification_id);
        row.setAttribute('aria-label', (item.title || 'Shelter update') + (item.is_read ? ', read' : ', unread'));
        const dot = node('span', 'notification-center-dot'); dot.setAttribute('aria-hidden', 'true');
        const copy = node('span');
        copy.append(node('span', 'notification-center-title', item.title || 'Shelter update'), node('span', 'notification-center-preview', item.message || ''), node('span', 'notification-center-time', dateText(item.created_at)));
        row.append(dot, copy); body.append(row);
      });
      if (hasMore) body.append(node('div', 'notification-center-state', 'Unread notifications appear first. Open them to see more updates.'));
    }
    panel.append(body);
    if (role === 'evacuee') {
      const footer = node('div', 'notification-center-footer');
      const link = node('a', 'notification-center-link', 'View all notifications'); link.href = 'user-notifications.html';
      footer.append(link); panel.append(footer);
    }
    if (focusId) document.getElementById(focusId)?.focus();
    renderPage();
  }
  function connectRealtime(client, stamp) {
    if (channel || !client || !client.channel) return;
    try {
      const next = client.channel('scansafe-notification-center-' + ownerId);
      const onChange = function () { if (current(stamp)) refresh(); };
      channelClient = client;
      channel = next.on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notification_reads', filter: 'user_id=eq.' + ownerId }, onChange).subscribe();
    } catch (_) { stopRealtime(); }
  }
  async function refresh() {
    if (!syncAccount()) return false;
    if (refreshTask) return refreshTask;
    const stamp = epoch, request = ++sequence;
    const client = options.getClient ? options.getClient() : null;
    if (!client || !client.rpc) { loadError = 'Notifications are unavailable. Please try again.'; paintBells(); render(); return false; }
    const task = (async function () {
      try {
        const result = await client.rpc('get_scansafe_notification_center');
        if (!current(stamp) || request !== sequence) return false;
        if (result.error) throw result.error;
        const data = result.data;
        if (!data || String(data.owner_id) !== ownerId || !Array.isArray(data.items)) throw new Error('Notification account could not be verified');
        const count = Number(data.unread_count), all = Number(data.total_count);
        if (!Number.isSafeInteger(count) || !Number.isSafeInteger(all) || count < 0 || all < count) throw new Error('Notification count could not be read');
        items = data.items.filter(function (item) { return item && /^\d+$/.test(String(item.notification_id)); });
        if (selectedId) selectedItem = items.find(function (item) { return String(item.notification_id) === selectedId; }) || selectedItem;
        unread = count; total = all; hasMore = !!data.has_more; loaded = true; loadError = '';
        paintBells(); render(); paintDashboardLatest(); connectRealtime(client, stamp);
        return true;
      } catch (error) {
        if (!current(stamp) || request !== sequence) return false;
        loadError = /PGRST202|42883/.test(String(error.code || '')) ? 'Notifications need a system update. Please try again after the update.' : 'Could not refresh your notifications. Please try again.';
        paintBells(); render(); return false;
      } finally { if (request === sequence) refreshTask = null; }
    })();
    refreshTask = task;
    return task;
  }
  async function markRead(id) {
    if (!syncAccount()) return false;
    const item = items.find(function (value) { return String(value.notification_id) === String(id); })
      || (selectedItem && String(selectedItem.notification_id) === String(id) ? selectedItem : null);
    if (!item || item.is_read || markingId) return false;
    const stamp = epoch, client = options.getClient ? options.getClient() : null;
    if (!client || !client.rpc) return false;
    markingId = String(id); markError = ''; render();
    try {
      const result = await client.rpc('mark_scansafe_center_notification_read', { p_notification_id: item.notification_id });
      if (!current(stamp)) return false;
      if (result.error) throw result.error;
      // The count changes only after the server has accepted this user's read.
      const displayed = items.find(function (value) { return String(value.notification_id) === String(id); })
        || (selectedItem && String(selectedItem.notification_id) === String(id) ? selectedItem : null);
      if (displayed && !displayed.is_read) { displayed.is_read = true; unread = Math.max(0, unread - 1); }
      // A refresh started before this acknowledgement may contain an older
      // unread count. Discard it and ask for a fresh server snapshot.
      sequence++; refreshTask = null;
      markingId = null; markError = ''; paintBells(); render();
      if (typeof window.CustomEvent === 'function') document.dispatchEvent(new CustomEvent('scansafe:notification-read', { detail: { notificationId: item.notification_id } }));
      refresh();
      if (selectedId !== String(id)) markRead(selectedId);
      return true;
    } catch (_) {
      if (!current(stamp)) return false;
      markingId = null; markError = 'This notification could not be marked as read. Please try again.'; render(); return false;
    }
  }
  function select(id) {
    if (!syncAccount()) return;
    selectedId = String(id); selectedItem = items.find(function (item) { return String(item.notification_id) === selectedId; }) || null;
    markError = ''; render();
    document.getElementById('scansafeNotificationDetailTitle')?.focus();
    return markRead(selectedId);
  }
  function open(bell) {
    if (!syncAccount()) return false;
    ensurePanel(); opened = true; selectedId = null; selectedItem = null; markError = '';
    trigger = bell || document.querySelector(bellSelector); panel.hidden = false;
    paintBells(); render(); document.getElementById('scansafeNotificationClose')?.focus(); refresh(); return true;
  }
  function close(restoreFocus) {
    const wasOpen = opened; opened = false;
    if (panel) panel.hidden = true;
    paintBells();
    if (wasOpen && restoreFocus !== false && trigger && document.contains(trigger)) trigger.focus();
  }
  function onOutside(event) {
    if (!opened || panel?.contains(event.target)) return;
    if (event.target.closest && event.target.closest(bellSelector)) return;
    close(false);
  }
  function onKey(event) { if (opened && event.key === 'Escape') { event.preventDefault(); close(); } }
  function onFocus() { if (!document.hidden) refresh(); }
  function reset() {
    clearAccount();
    if (poll) clearInterval(poll); poll = null;
    document.removeEventListener('click', onOutside); document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onFocus); window.removeEventListener('focus', onFocus);
    options = {};
  }
  async function init(configuration) {
    reset(); options = configuration || {}; attachBells();
    document.addEventListener('click', onOutside); document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onFocus); window.addEventListener('focus', onFocus);
    poll = setInterval(function () { if (!document.hidden) refresh(); }, 30000);
    return refresh();
  }
  window.ScanSafeNotifications = { init: init, refresh: refresh, reset: reset, open: open, close: close,
    inspect: function () { return { ownerId: ownerId, unread: unread, total: total, loaded: loaded, opened: opened, selectedId: selectedId, pageFilter: pageFilter, items: items.map(function(item){ return Object.assign({}, item); }) }; } };
})();
