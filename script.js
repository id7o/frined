const menuButton = document.querySelector('.menu-toggle');
const navLinks = document.querySelector('.nav-links');
const joinDialog = document.querySelector('.join-dialog');
const adminDialog = document.querySelector('.admin-dialog');
const adminLoginView = document.querySelector('.admin-login-view');
const adminPanelView = document.querySelector('.admin-panel-view');
const toast = document.querySelector('.toast');
let isAdmin = false;
let toastTimer;

menuButton.addEventListener('click', () => {
  const isOpen = navLinks.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(isOpen));
});

navLinks.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
  });
});

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}

function slotElement(slot) {
  return document.querySelector(`[data-slot="${slot}"]`);
}

function renderSlot(slot, clip) {
  const holder = slotElement(slot);
  if (!holder) return;
  const video = holder.querySelector('video');
  if (clip?.url) {
    if (video.getAttribute('src') !== clip.url) video.src = clip.url;
    holder.classList.add('has-video');
  } else {
    video.removeAttribute('src');
    video.load();
    holder.classList.remove('has-video');
  }
}

async function loadClips() {
  try {
    const { clips } = await api('/api/clips');
    ['clip1', 'clip2', 'clip3', 'featured'].forEach((slot) => renderSlot(slot, clips[slot]));
  } catch {
    showToast('Start the Friend server to load saved videos.');
  }
}

function setAdminMode(enabled) {
  isAdmin = enabled;
  document.body.classList.toggle('admin-mode', enabled);
  adminLoginView.hidden = enabled;
  adminPanelView.hidden = !enabled;
}

async function checkSession() {
  try {
    const session = await api('/api/session');
    setAdminMode(session.authenticated);
  } catch {
    setAdminMode(false);
  }
}

document.querySelectorAll('.clip-card .play').forEach((play) => {
  play.addEventListener('click', () => {
    const holder = play.closest('.clip-card');
    if (holder.classList.contains('has-video')) holder.querySelector('video').play();
  });
});

document.querySelectorAll('.replace-video').forEach((button) => {
  button.addEventListener('click', () => {
    if (!isAdmin) return;
    button.closest('[data-slot]').querySelector('input[type="file"]').click();
  });
});

document.querySelectorAll('[data-slot] input[type="file"]').forEach((input) => {
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file || !isAdmin) return;
    const holder = input.closest('[data-slot]');
    const slot = holder.dataset.slot;
    holder.classList.add('uploading');
    try {
      const result = await api(`/api/upload/${slot}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
        body: file
      });
      renderSlot(slot, result.clip);
      showToast('Video saved for every visitor.');
    } catch (error) {
      showToast(error.message);
      if (/sign in/i.test(error.message)) setAdminMode(false);
    } finally {
      holder.classList.remove('uploading');
      input.value = '';
    }
  });
});

document.querySelectorAll('.remove-video').forEach((button) => {
  button.addEventListener('click', async () => {
    if (!isAdmin) return;
    const holder = button.closest('[data-slot]');
    const slot = holder.dataset.slot;
    if (!window.confirm('Remove this video for all visitors?')) return;
    try {
      await api(`/api/clips/${slot}`, { method: 'DELETE' });
      renderSlot(slot, null);
      showToast('Video removed.');
    } catch (error) {
      showToast(error.message);
    }
  });
});

document.querySelectorAll('.js-open-join').forEach((button) => button.addEventListener('click', () => joinDialog.showModal()));
document.querySelector('.join-dialog .dialog-close').addEventListener('click', () => joinDialog.close());
joinDialog.addEventListener('click', (event) => { if (event.target === joinDialog) joinDialog.close(); });

document.querySelectorAll('.js-open-admin').forEach((button) => {
  button.addEventListener('click', async () => {
    await checkSession();
    adminDialog.showModal();
  });
});

document.querySelector('.admin-close').addEventListener('click', () => adminDialog.close());
document.querySelector('.admin-done').addEventListener('click', () => adminDialog.close());
adminDialog.addEventListener('click', (event) => { if (event.target === adminDialog) adminDialog.close(); });

document.querySelector('.admin-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  setAdminMode(false);
  adminDialog.close();
  showToast('Admin signed out.');
});

loadClips();
checkSession();

const authResult = new URLSearchParams(location.search).get('admin');
if (authResult) {
  const authReason = new URLSearchParams(location.search).get('reason');
  const messages = {
    ok: 'Discord verified. Admin mode unlocked.',
    denied: 'This Discord account is not authorized.',
    error: 'Discord sign-in could not be completed.',
    setup: 'Discord sign-in needs to be configured on the server.'
  };
  const reasonMessages = {
    state: 'Discord session expired. Please try signing in again.',
    token: 'Discord rejected the Client ID or Client Secret.',
    user: 'Discord could not read this account.',
    unknown: 'Discord sign-in failed unexpectedly.'
  };
  showToast(authResult === 'error' ? (reasonMessages[authReason] || messages.error) : (messages[authResult] || messages.error));
  history.replaceState({}, '', `${location.pathname}${location.hash}`);
}
