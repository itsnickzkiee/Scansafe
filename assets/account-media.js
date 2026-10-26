(function () {
  'use strict';
  const BUCKET = 'scansafe-account-media';
  const MAX_BYTES = 2 * 1024 * 1024;
  const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  let options = {}, generation = 0, currentOwner = null, refreshing = null, mounted = null;
  let avatarUrl = '', avatarPath = '', avatarExpires = 0, reviewSequence = 0;
  const uploads = new Set();
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function context() { try { return options.getContext ? options.getContext() || {} : {}; } catch (_) { return {}; } }
  function owner() { const c = context(); return c.userId || c.ownerId || c.user?.id || null; }
  function client() { const sb = options.getClient?.(); if (!sb) throw new Error('The ScanSafe connection is unavailable. Try again.'); return sb; }
  function message(error) {
    const text = String(error?.message || error || 'Please try again.');
    if (/PGRST202|could not find.*function|does not exist|bucket not found/i.test((error?.code || '') + ' ' + text))
      return 'Image upload is not configured yet. The administrator must run SUPABASE_ACCOUNT_MEDIA.sql.';
    return text;
  }
  async function rpc(sb, name, args) { const { data, error } = await sb.rpc(name, args); if (error) throw error; return data; }
  function validUrl(value) { try { const u = new URL(value); return /^(https?:)$/.test(u.protocol) ? u.href : ''; } catch (_) { return ''; } }
  async function signedUrl(sb, path) {
    if (!path) return '';
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 300);
    if (error) throw error;
    const url = validUrl(data?.signedUrl);
    if (!url) throw new Error('The image preview could not be opened. Refresh and try again.');
    return url;
  }
  function clearAvatars() {
    document.querySelectorAll('img[data-account-avatar]').forEach(img => {
      const el = img.parentElement;
      img.remove();
      if (el) { el.classList.remove('account-has-photo'); el.textContent = String(context().profile?.full_name || 'E').trim().charAt(0).toUpperCase(); }
    });
    avatarUrl = ''; avatarPath = ''; avatarExpires = 0;
  }
  function paintAvatars(url, uid) {
    if (!url || owner() !== uid) return;
    document.querySelectorAll('.user-top .avatar,.mobile-avatar,.profile-avatar,.avatar-circle,.identity-avatar,.profile-layout .person-round').forEach(el => {
      el.textContent = '';
      const img = document.createElement('img');
      img.src = url; img.alt = 'Your profile photo'; img.dataset.accountAvatar = uid;
      img.addEventListener('error', () => { if (img.isConnected) { img.remove(); el.classList.remove('account-has-photo'); el.textContent = String(context().profile?.full_name || 'E').trim().charAt(0).toUpperCase(); } });
      el.appendChild(img); el.classList.add('account-has-photo');
    });
  }
  function status(text, bad) {
    const el = mounted?.querySelector('[data-media-status]');
    if (el) { el.textContent = text; el.classList.toggle('account-media-error', !!bad); }
  }
  async function validateFile(file) {
    if (!file) throw new Error('Choose an image first.');
    if (!TYPES[file.type]) throw new Error('Choose a JPG, PNG or WebP image.');
    if (!(file.size > 0) || file.size > MAX_BYTES) throw new Error('The image must be 2 MB or smaller.');
    if (typeof file.arrayBuffer !== 'function') throw new Error('This browser could not read the image. Choose it again.');
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
    const webp = bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
    if (!(file.type === 'image/jpeg' ? jpeg : file.type === 'image/png' ? png : webp)) throw new Error('The file is not a valid JPG, PNG or WebP image.');
    return file;
  }
  async function sessionOwner(sb) {
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    const uid = data?.session?.user?.id;
    if (!uid) throw new Error('Sign in before uploading your account image.');
    return uid;
  }
  async function upload(kind, file, expectedOwner) {
    await validateFile(file);
    const sb = client(), uid = await sessionOwner(sb), started = generation;
    if (expectedOwner && uid !== expectedOwner) throw new Error('Your signed-in account changed. Sign in again before uploading.');
    const key = uid + ':' + kind;
    if (uploads.has(key)) throw new Error('An image is already uploading. Please wait.');
    if (!window.crypto?.randomUUID) throw new Error('Secure image upload is unavailable in this browser.');
    const path = uid + '/' + kind + '/' + window.crypto.randomUUID() + '.' + TYPES[file.type];
    uploads.add(key);
    let saved = false;
    try {
      const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type, cacheControl: '300', upsert: false });
      if (error) throw error;
      if (started !== generation || await sessionOwner(sb) !== uid) throw new Error('Your signed-in account changed. The image was not saved.');
      const result = await rpc(sb, 'save_scansafe_account_media', { p_kind: kind, p_path: path });
      const record = result?.[kind === 'profile' ? 'profile_photo' : 'valid_id'];
      if (result?.owner_id !== uid || record?.path !== path) throw new Error('The image was uploaded, but its account record could not be confirmed. Refresh before trying again.');
      saved = true;
      // Only unlinked, superseded objects are deletable under the Storage rule.
      if (result?.previous_path && result.previous_path !== path) {
        try { await sb.storage.from(BUCKET).remove([result.previous_path]); } catch (_) { /* Saved metadata is authoritative. */ }
      }
      if (started === generation && owner() === uid) { avatarExpires = 0; await refresh(); }
      return result;
    } catch (error) {
      if (!saved) { try { await sb.storage.from(BUCKET).remove([path]); } catch (_) { /* Never remove another account's object. */ } }
      throw new Error(message(error));
    } finally { uploads.delete(key); }
  }
  function mount() {
    const el = document.getElementById('profilePhotoUpload');
    if (!el || mounted === el) return;
    mounted = el;
    el.classList.add('account-media-controls');
    el.innerHTML = '<h3>Account images</h3><p class="muted">JPG, PNG or WebP, up to 2 MB each. Registration ID images are visible only to you and authorized shelter staff.</p>' +
      '<div class="account-media-upload-row"><label>Profile photo<input type="file" accept="image/jpeg,image/png,image/webp" data-media-file="profile"></label><button type="button" class="btn red" data-media-upload="profile">Upload profile photo</button></div>' +
      '<div class="account-media-upload-row"><label>Registration ID image<input type="file" accept="image/jpeg,image/png,image/webp" data-media-file="valid-id"></label><button type="button" class="btn out" data-media-upload="valid-id">Upload ID image</button></div>' +
      '<p data-media-id-state class="muted">Checking your uploaded ID...</p><p data-media-status role="status" aria-live="polite"></p>';
    el.querySelectorAll('[data-media-upload]').forEach(button => button.addEventListener('click', async () => {
      const uid = owner(), kind = button.dataset.mediaUpload;
      const input = el.querySelector('[data-media-file="' + kind + '"]');
      if (!uid) { status('Sign in before uploading your account image.', true); return; }
      button.disabled = true; status('Uploading image...', false);
      try {
        await upload(kind, input?.files?.[0], uid);
        if (owner() === uid) { input.value = ''; status(kind === 'profile' ? 'Profile photo saved.' : 'Registration ID image saved for staff review.', false); }
      } catch (error) { if (owner() === uid) status(message(error), true); }
      finally { if (button.isConnected) button.disabled = false; }
    }));
  }
  function refresh() {
    const uid = owner(), c = context();
    if (!uid || c.role !== 'evacuee') { if (currentOwner) clearAvatars(); currentOwner = null; return Promise.resolve(null); }
    if (currentOwner && currentOwner !== uid) { clearAvatars(); generation++; refreshing = null; }
    currentOwner = uid; mount();
    if (refreshing) return refreshing;
    const started = generation;
    const work = (async () => {
      try {
        const sb = client(), data = await rpc(sb, 'get_my_scansafe_media');
        if (started !== generation || owner() !== uid || data?.owner_id !== uid) return null;
        if (data.profile_photo?.path) {
          if (avatarPath !== data.profile_photo.path || Date.now() >= avatarExpires || !avatarUrl) {
            const url = await signedUrl(sb, data.profile_photo.path);
            if (started !== generation || owner() !== uid) return null;
            avatarPath = data.profile_photo.path; avatarUrl = url; avatarExpires = Date.now() + 240000;
          }
          paintAvatars(avatarUrl, uid);
        } else clearAvatars();
        const idState = mounted?.querySelector('[data-media-id-state]');
        if (idState) idState.textContent = data.valid_id ? 'Registration ID image uploaded.' : 'No registration ID image has been uploaded yet. You can add it here.';
        return data;
      } catch (error) { if (started === generation && owner() === uid) status(message(error), true); return null; }
    })();
    refreshing = work;
    return work.finally(() => { if (refreshing === work) refreshing = null; });
  }
  async function showRegistrationReview({ evacueeId, container } = {}) {
    const target = container || document.getElementById('registrationMediaReview') || document.getElementById('reviewDetails');
    if (!target) return null;
    const uid = owner(), started = generation, sequence = ++reviewSequence;
    const current = () => owner() === uid && generation === started && sequence === reviewSequence && target.isConnected;
    if (!uid || !['admin', 'staff'].includes(context().role)) { target.textContent = 'Staff access is required to review registration images.'; return null; }
    target.textContent = 'Loading complete registration and uploaded images...';
    try {
      const sb = client(), data = await rpc(sb, 'get_scansafe_registration_details', { p_evacuee_id: Number(evacueeId) });
      if (!current()) return null;
      const e = data?.evacuee || {};
      const details = [ ['Full name', e.full_name], ['Email', e.email], ['Age / Gender', [e.age, e.gender].filter(v => v !== null && v !== undefined && v !== '').join(' / ')],
        ['Contact number', e.contact_number || e.phone], ['Group size', data?.group?.group_size || e.group_size], ['Address', [e.address, e.barangay, e.city].filter(Boolean).join(', ')],
        ['Emergency contact', e.emergency_contact], ['Special / medical needs', e.needs_summary || 'None reported'],
        ['Accessibility required', e.accessibility_required ? 'Yes' : 'No'], ['Valid ID type', e.valid_id_type], ['Valid ID number', e.valid_id_number],
        ['Registration code', e.registration_code], ['Approval status', e.approval_status], ['Stay status', e.current_status],
        ['Submitted', e.registered_at ? new Date(e.registered_at).toLocaleString() : 'Not provided'] ];
      target.innerHTML = '<div class="account-media-review-fields">' + details.map(([name, value]) => '<div class="review-field"><b>' + esc(name) + '</b><span>' + esc(value == null || value === '' ? 'Not provided' : value) + '</span></div>').join('') + '</div>' +
        '<div class="account-media-review-images">' + ['profile_photo', 'valid_id'].map(kind => '<section data-review-image="' + kind + '"><h4>' + (kind === 'profile_photo' ? 'Profile photo' : 'Uploaded registration ID') + '</h4><p class="muted">' + (data[kind]?.path ? 'Loading secure image preview...' : kind === 'profile_photo' ? 'No profile photo uploaded.' : 'No registration ID image uploaded. Earlier registrations may have selected a file without saving it.') + '</p></section>').join('') + '</div>';
      await Promise.all(['profile_photo', 'valid_id'].map(async kind => {
        if (!data[kind]?.path) return;
        try {
          const url = await signedUrl(sb, data[kind].path);
          if (!current()) return;
          const section = target.querySelector('[data-review-image="' + kind + '"]');
          if (!section) return;
          const img = document.createElement('img'); img.src = url;
          img.alt = kind === 'profile_photo' ? 'Evacuee profile photo' : 'Registration identification image';
          img.loading = 'lazy';
          img.addEventListener('error', () => { if (current()) { img.remove(); section.querySelector('p').textContent = 'The image preview expired or could not load. Reopen this review to retry.'; } });
          section.querySelector('p').textContent = 'Private preview; expires after 5 minutes.';
          const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'account-media-image-link';
          link.setAttribute('aria-label', 'Open ' + img.alt.toLowerCase()); link.appendChild(img); section.appendChild(link);
        } catch (error) { if (current()) target.querySelector('[data-review-image="' + kind + '"] p').textContent = message(error); }
      }));
      return current() ? data : null;
    } catch (error) { if (current()) target.textContent = message(error); return null; }
  }
  function reset() {
    generation++; reviewSequence++; refreshing = null; clearAvatars(); currentOwner = null;
    if (mounted) { mounted.textContent = ''; mounted = null; }
    document.querySelectorAll('.account-media-review-images').forEach(el => el.remove());
  }
  function init(config) { reset(); options = config || {}; return refresh(); }
  window.ScanSafeMedia = {
    init, reset, refresh, validateFile, showRegistrationReview,
    uploadRegistrationId: ({ file, ownerId } = {}) => upload('valid-id', file, ownerId),
    uploadProfilePhoto: ({ file, ownerId } = {}) => upload('profile', file, ownerId)
  };
})();
