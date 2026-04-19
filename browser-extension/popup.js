const viewMain     = document.getElementById('view-main');
const viewSettings = document.getElementById('view-settings');
const signedOut    = document.getElementById('signed-out');
const signedIn     = document.getElementById('signed-in');
const userEmail    = document.getElementById('user-email');
const errorMsg     = document.getElementById('error-msg');

// ── Auth ──
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
  if (res?.signedIn) showSignedIn(res.email);
  else showSignedOut();
});

document.getElementById('btn-signin').addEventListener('click', () => {
  errorMsg.textContent = 'Signing in…';
  chrome.runtime.sendMessage({ type: 'SIGN_IN' }, (res) => {
    if (res?.ok) showSignedIn(res.email);
    else errorMsg.textContent = res?.error || 'Sign in failed. Try again.';
  });
});

document.getElementById('btn-signout').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SIGN_OUT' }, () => showSignedOut());
});

function showSignedIn(email) {
  signedOut.style.display = 'none';
  signedIn.style.display  = 'block';
  userEmail.textContent   = email || '';
}

function showSignedOut() {
  signedIn.style.display  = 'none';
  signedOut.style.display = 'block';
  errorMsg.textContent    = '';
}

// ── Settings ──
document.getElementById('btn-open-settings').addEventListener('click', () => {
  viewMain.style.display     = 'none';
  viewSettings.style.display = 'block';
  renderSiteList();
});

document.getElementById('btn-back').addEventListener('click', () => {
  viewSettings.style.display = 'none';
  viewMain.style.display     = 'block';
});

document.getElementById('btn-add-site').addEventListener('click', addSite);
document.getElementById('input-label').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addSite();
});

async function getSites() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_SITES' }, (res) => resolve(res?.sites || {}));
  });
}

async function renderSiteList() {
  const sites = await getSites();
  const list  = document.getElementById('site-list');
  list.innerHTML = '';

  const entries = Object.entries(sites).sort((a, b) => a[1].label.localeCompare(b[1].label));
  if (!entries.length) {
    list.innerHTML = '<div style="font-size:11px;color:#4b5563;padding:8px">No sites tracked yet.</div>';
    return;
  }

  for (const [domain, info] of entries) {
    const row = document.createElement('div');
    row.className = 'site-row';
    row.innerHTML = `
      <span class="site-label">${info.label}${info.custom ? '<span class="custom-badge">custom</span>' : ''}</span>
      <span class="site-domain">${domain}</span>
      <button class="btn-remove" data-domain="${domain}" title="Remove">✕</button>
    `;
    list.appendChild(row);
  }

  list.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'REMOVE_SITE', domain: btn.dataset.domain });
      renderSiteList();
    });
  });
}

async function addSite() {
  const domainInput = document.getElementById('input-domain');
  const labelInput  = document.getElementById('input-label');
  const addError    = document.getElementById('add-error');

  let domain = domainInput.value.trim().toLowerCase().replace(/^www\./, '').replace(/^https?:\/\//, '').split('/')[0];
  const label  = labelInput.value.trim();

  addError.textContent = '';
  if (!domain) { addError.textContent = 'Enter a domain'; return; }
  if (!label)  { addError.textContent = 'Enter a label'; return; }

  await chrome.runtime.sendMessage({ type: 'ADD_SITE', domain, label });
  domainInput.value = '';
  labelInput.value  = '';
  renderSiteList();
}
