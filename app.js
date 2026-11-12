/**
 * NUSUK SHARE - Frontend Application Controller
 * Connect API_URL to your deployed Google Apps Script Web App URL.
 */
const API_URL = 'https://script.google.com/macros/s/AKfycbzv_uPyPlR7KoMx4e_FOoTj10u2H_DA-XkfOc31RpYypBttCDrSdqa1_g2Dlp4kBkLb/exec';

const state = {
  lang: localStorage.getItem('nsk_lang') || 'ar',
  theme: localStorage.getItem('nsk_theme') || 'light',
  token: localStorage.getItem('nsk_token') || '',
  user: JSON.parse(localStorage.getItem('nsk_user') || 'null'),
  codes: [],
  leaderboard: [],
  stats: {},
  seenIds: JSON.parse(localStorage.getItem('nsk_seen_codes') || '[]'),
  history: JSON.parse(localStorage.getItem('nsk_history') || '[]'),
  currentSpotlight: null,
  currentModalCode: null,
  adminData: null,
  charts: {}
};

// Generate or retrieve anonymous browser fingerprint for rate limiting & fair distribution
function getFingerprint() {
  let fp = localStorage.getItem('nsk_fp');
  if (!fp) {
    fp = 'FP-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    localStorage.setItem('nsk_fp', fp);
  }
  return fp;
}

// API Helper (supports both standalone hosting via fetch and GAS HtmlService via google.script.run)
async function apiCall(action, payload = {}, isPost = false) {
  const fullPayload = { ...payload, action, token: state.token, fingerprint: getFingerprint() };

  if (typeof google !== 'undefined' && google.script && google.script.run) {
    return new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(err => reject(new Error(err.message)))
        .handleApiRequest(action, fullPayload, fullPayload);
    });
  }

  if (!API_URL || API_URL.includes('REPLACE_WITH')) {
    throw new Error('يرجى ضبط رابط API_URL الخاص بـ Google Apps Script في ملف app.js');
  }

  if (!isPost) {
    const url = new URL(API_URL);
    url.searchParams.set('api', action);
    Object.keys(fullPayload).forEach(k => {
      if (fullPayload[k] !== undefined && fullPayload[k] !== null) {
        url.searchParams.set(k, fullPayload[k]);
      }
    });
    const res = await fetch(url.toString());
    return res.json();
  } else {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(fullPayload)
    });
    return res.json();
  }
}

/* ============================================================================
 * INITIALIZATION & DEEP LINKING
 * ========================================================================== */

document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(state.theme);
  applyLang(state.lang);
  updateAuthUI();
  registerPWA();

  await refreshPublicData();

  // Handle direct code URL (?code=NSK-XXXX)
  const params = new URLSearchParams(window.location.search);
  const sharedCodeId = params.get('code');
  if (sharedCodeId) {
    const match = state.codes.find(c => c.code_id === sharedCodeId);
    if (match) {
      state.currentSpotlight = match;
      renderSpotlight(match);
    }
  }
});

async function refreshPublicData() {
  try {
    const data = await apiCall('getPublicData');
    if (!data.ok) return showToast(data.error || 'تعذر تحميل البيانات');

    state.codes = data.codes || [];
    state.leaderboard = data.leaderboard || [];
    state.stats = data.stats || {};

    document.getElementById('statApproved').textContent = state.stats.approved_codes || 0;
    document.getElementById('statCopies').textContent = state.stats.total_copies || 0;
    document.getElementById('statSuccess').textContent = state.stats.community_success_reports || 0;
    document.getElementById('statContributors').textContent = state.stats.active_contributors || 0;

    if (!state.currentSpotlight) {
      getSmartCode(false);
    }
    renderHomeLists();
    renderBrowseList();
    renderLeaderboard();
    renderHistory();
  } catch (err) {
    document.getElementById('spotlightBody').innerHTML = `<p class="muted-text">${escapeHtml(err.message)}</p>`;
  }
}

/* ============================================================================
 * SMART FAIR DISTRIBUTION ALGORITHM
 * ========================================================================== */

function computeSmartScore(code) {
  const now = Date.now();
  const approvedTime = new Date(code.approved_at || code.created_at).getTime() || now;
  const ageHours = Math.max(1, (now - approvedTime) / 3600000);

  // Recency boost (higher for newer codes, decays smoothly)
  const recencyScore = 100 / Math.log2(ageHours + 2);

  // Community trust boost (worked reports minus problem reports)
  const communityScore = (code.success_reports * 8) - (code.problem_reports * 12);

  // Fairness penalty if already seen in this browser session/storage
  const alreadySeen = state.seenIds.includes(code.code_id);
  const noveltyBonus = alreadySeen ? -60 : 40;

  // Small controlled jitter so concurrent visitors don't always get identical order
  const jitter = Math.random() * 12;

  return recencyScore + communityScore + noveltyBonus + jitter;
}

function getSmartCode(notify = true) {
  if (!state.codes.length) {
    document.getElementById('spotlightBody').innerHTML = '<p class="muted-text">لا توجد أكواد معتمدة حالياً. كن أول من يضيف كوداً!</p>';
    return;
  }

  // Filter out codes with heavy unresolved problem reports unless no others exist
  let candidates = state.codes.filter(c => c.problem_reports < 3);
  if (!candidates.length) candidates = [...state.codes];

  // Reset seen history if user has cycled through all available codes
  const unseen = candidates.filter(c => !state.seenIds.includes(c.code_id));
  if (!unseen.length) {
    state.seenIds = [];
    localStorage.setItem('nsk_seen_codes', '[]');
  }

  candidates.sort((a, b) => computeSmartScore(b) - computeSmartScore(a));
  const picked = candidates[0];

  if (!state.seenIds.includes(picked.code_id)) {
    state.seenIds.push(picked.code_id);
    localStorage.setItem('nsk_seen_codes', JSON.stringify(state.seenIds.slice(-100)));
  }

  state.currentSpotlight = picked;
  renderSpotlight(picked);
  if (notify) showToast('تم ترشيح كود جديد لك بنجاح');
}

function renderSpotlight(code) {
  if (!code) return;
  const statusBadge = getCommunityBadgeHtml(code);
  document.getElementById('spotlightBody').innerHTML = `
    <div class="code-value-big">${escapeHtml(code.code_value)}</div>
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
      <strong>${escapeHtml(code.title || 'كود مشارك من المجتمع')}</strong>
      ${statusBadge}
    </div>
    <div class="code-meta">
      <span>👤 ${escapeHtml(code.contributor_name)}</span>
      <span>📋 ${code.copies_count} نسخ</span>
      <span>✅ ${code.success_reports} نجاح</span>
      <span>📅 ${formatDate(code.approved_at || code.created_at)}</span>
    </div>
    <div class="code-actions">
      <button class="btn btn-gold" style="flex:1;" onclick="copyCode('${code.code_id}', 'spotlight')">📋 نسخ الكود</button>
      <button class="btn btn-outline" onclick="openQrModal('${code.code_id}')">QR / مشاركة</button>
      <button class="btn btn-outline" onclick="openReportModal('${code.code_id}')">تقييم / بلاغ</button>
    </div>
  `;
}

/* ============================================================================
 * CODE CARDS RENDERING, SEARCH, FILTER & SORT
 * ========================================================================== */

function getCommunityBadgeHtml(code) {
  if (code.problem_reports >= 2) {
    return `<span class="pill pill-problem">⚠️ بلاغات مشاكل (${code.problem_reports})</span>`;
  }
  if (code.success_reports > 0) {
    return `<span class="pill pill-worked">✅ أفاد المستخدمون بنجاحه (${code.success_reports})</span>`;
  }
  return `<span class="pill pill-approved">معتمد للنشر</span>`;
}

function buildCodeCardHtml(code) {
  return `
    <article class="code-card">
      <div class="code-card-top">
        <span class="code-token">${escapeHtml(code.code_value)}</span>
        ${getCommunityBadgeHtml(code)}
      </div>
      ${code.title ? `<div style="font-weight:700; margin-bottom:4px;">${escapeHtml(code.title)}</div>` : ''}
      ${code.notes ? `<p class="muted-text" style="font-size:0.86rem;">${escapeHtml(code.notes)}</p>` : ''}
      <div class="code-meta">
        <span>👤 ${escapeHtml(code.contributor_name)}</span>
        <span>📋 ${code.copies_count}</span>
        <span>✅ ${code.success_reports}</span>
        <span>⚠️ ${code.problem_reports}</span>
        <span>📅 ${formatDate(code.approved_at || code.created_at)}</span>
      </div>
      <div class="code-actions">
        <button class="btn btn-primary btn-sm" onclick="copyCode('${code.code_id}', 'list')">📋 نسخ</button>
        <button class="btn btn-outline btn-sm" onclick="openQrModal('${code.code_id}')">QR / مشاركة</button>
        <button class="btn btn-outline btn-sm" onclick="openReportModal('${code.code_id}')">تقييم</button>
      </div>
    </article>
  `;
}

function renderHomeLists() {
  const latest = [...state.codes]
    .sort((a, b) => new Date(b.approved_at || b.created_at) - new Date(a.approved_at || a.created_at))
    .slice(0, 4);

  const popular = [...state.codes]
    .sort((a, b) => b.copies_count - a.copies_count)
    .slice(0, 4);

  document.getElementById('latestCodesList').innerHTML = latest.length
    ? latest.map(buildCodeCardHtml).join('')
    : '<p class="muted-text">لا توجد أكواد منشورة بعد.</p>';

  document.getElementById('popularCodesList').innerHTML = popular.length
    ? popular.map(buildCodeCardHtml).join('')
    : '<p class="muted-text">لا توجد بيانات كافية بعد.</p>';
}

function renderBrowseList() {
  const query = (document.getElementById('browseSearch')?.value || '').toLowerCase().trim();
  const feedback = document.getElementById('browseFeedbackFilter')?.value || 'all';
  const sortBy = document.getElementById('browseSort')?.value || 'smart';

  let list = state.codes.filter(c => {
    const matchText = !query ||
      c.code_value.toLowerCase().includes(query) ||
      (c.title || '').toLowerCase().includes(query) ||
      (c.contributor_name || '').toLowerCase().includes(query);

    const matchFeedback = feedback === 'all' ||
      (feedback === 'worked' && c.success_reports > 0) ||
      (feedback === 'clean' && c.problem_reports === 0);

    return matchText && matchFeedback;
  });

  if (sortBy === 'newest') {
    list.sort((a, b) => new Date(b.approved_at || b.created_at) - new Date(a.approved_at || a.created_at));
  } else if (sortBy === 'oldest') {
    list.sort((a, b) => new Date(a.approved_at || a.created_at) - new Date(b.approved_at || b.created_at));
  } else if (sortBy === 'most_copied') {
    list.sort((a, b) => b.copies_count - a.copies_count);
  } else {
    list.sort((a, b) => computeSmartScore(b) - computeSmartScore(a));
  }

  document.getElementById('browseCodesGrid').innerHTML = list.length
    ? list.map(buildCodeCardHtml).join('')
    : '<p class="muted-text">لا توجد نتائج مطابقة لخيارات البحث.</p>';
}

function handleHomeSearch(val) {
  document.getElementById('browseSearch').value = val;
  if (val.trim().length >= 2) {
    showView('browse');
    renderBrowseList();
  }
}

/* ============================================================================
 * COPY, QR CODE GENERATION, SHARING & REPORTING
 * ========================================================================== */

async function copyCode(codeId, channel = 'web') {
  const code = state.codes.find(c => c.code_id === codeId);
  if (!code) return;

  try {
    await navigator.clipboard.writeText(code.code_value);
    showToast(`تم نسخ الكود: ${code.code_value}`);

    // Save to personal local history
    saveToLocalHistory(code);

    // Optimistic UI update + backend increment
    code.copies_count += 1;
    renderHomeLists();
    renderBrowseList();
    if (state.currentSpotlight && state.currentSpotlight.code_id === codeId) {
      renderSpotlight(code);
    }

    await apiCall('recordCopy', { code_id: codeId, channel }, true);
  } catch (err) {
    showToast('تعذر النسخ التلقائي، يرجى نسخ الكود يدوياً.');
  }
}

function openQrModal(codeId) {
  const code = state.codes.find(c => c.code_id === codeId);
  if (!code) return;
  state.currentModalCode = code;

  const shareUrl = `${window.location.origin}${window.location.pathname}?code=${encodeURIComponent(code.code_id)}`;
  document.getElementById('qrCodeValueText').innerHTML = `<div class="code-value-big">${escapeHtml(code.code_value)}</div>`;
  document.getElementById('qrShareUrlText').textContent = shareUrl;

  const qrBox = document.getElementById('qrcodeContainer');
  qrBox.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    new QRCode(qrBox, { text: shareUrl, width: 170, height: 170, colorDark: '#072A26', colorLight: '#ffffff' });
  }

  document.getElementById('qrModal').classList.remove('hidden');
}

function copyCurrentModalCode() {
  if (state.currentModalCode) copyCode(state.currentModalCode.code_id, 'qr_modal');
}

function shareExternal(platform) {
  if (!state.currentModalCode) return;
  const code = state.currentModalCode;
  const shareUrl = `${window.location.origin}${window.location.pathname}?code=${encodeURIComponent(code.code_id)}`;
  const msg = encodeURIComponent(`كود نسك مشارك عبر NUSUK SHARE:\n${code.code_value}\nالرابط: ${shareUrl}`);

  if (platform === 'whatsapp') {
    window.open(`https://wa.me/?text=${msg}`, '_blank');
  } else if (platform === 'telegram') {
    window.open(`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${msg}`, '_blank');
  }
}

async function shareNative() {
  if (!state.currentModalCode) return;
  const code = state.currentModalCode;
  const shareUrl = `${window.location.origin}${window.location.pathname}?code=${encodeURIComponent(code.code_id)}`;
  if (navigator.share) {
    await navigator.share({ title: 'NUSUK SHARE', text: `كود نسك: ${code.code_value}`, url: shareUrl });
  } else {
    await navigator.clipboard.writeText(shareUrl);
    showToast('تم نسخ رابط المشاركة');
  }
}

function openSubmitModal() {
  document.getElementById('submitModal').classList.remove('hidden');
}

async function handleCodeSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('submitCodeBtn');
  btn.disabled = true;

  try {
    const payload = {
      code_value: document.getElementById('inputCodeValue').value,
      title: document.getElementById('inputCodeTitle').value,
      contributor_name: document.getElementById('inputContributorName').value,
      notes: document.getElementById('inputCodeNotes').value
    };
    const res = await apiCall('submitCode', payload, true);
    if (!res.ok) {
      showToast(res.error);
    } else {
      showToast(res.message);
      saveToLocalHistory({
        code_id: res.code_id,
        code_value: payload.code_value.toUpperCase(),
        title: payload.title || 'مساهمتي (قيد المراجعة)',
        contributor_name: payload.contributor_name || 'أنا',
        copies_count: 0,
        success_reports: 0,
        problem_reports: 0,
        created_at: new Date().toISOString()
      });
      e.target.reset();
      closeModal('submitModal');
    }
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
}

function openReportModal(codeId) {
  document.getElementById('reportCodeId').value = codeId;
  document.getElementById('reportModal').classList.remove('hidden');
}

async function handleReportSubmit(e) {
  e.preventDefault();
  try {
    const res = await apiCall('submitReport', {
      code_id: document.getElementById('reportCodeId').value,
      report_type: document.getElementById('reportType').value,
      reason: document.getElementById('reportReason').value
    }, true);

    showToast(res.ok ? res.message : res.error);
    if (res.ok) {
      e.target.reset();
      closeModal('reportModal');
      refreshPublicData();
    }
  } catch (err) {
    showToast(err.message);
  }
}

/* ============================================================================
 * LEADERBOARD, HISTORY & NUSUK ASSISTANT
 * ========================================================================== */

function renderLeaderboard() {
  const el = document.getElementById('leaderboardContainer');
  if (!state.leaderboard.length) {
    el.innerHTML = '<p class="muted-text">لا يوجد مساهمون مسجلون في لوحة الشرف بعد.</p>';
    return;
  }
  el.innerHTML = state.leaderboard.map((u, idx) => `
    <div class="code-card" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
      <div>
        <strong>#${idx + 1} — ${escapeHtml(u.display_name)}</strong>
        <div class="muted-text" style="font-size:0.84rem;">أكواد معتمدة: ${u.approved_count} | مرسلة: ${u.submitted_count}</div>
      </div>
      <span class="badge-gold">${u.points} نقطة</span>
    </div>
  `).join('');
}

function saveToLocalHistory(code) {
  state.history = [code, ...state.history.filter(c => c.code_id !== code.code_id)].slice(0, 30);
  localStorage.setItem('nsk_history', JSON.stringify(state.history));
  renderHistory();
}

function renderHistory() {
  const el = document.getElementById('historyContainer');
  el.innerHTML = state.history.length
    ? state.history.map(buildCodeCardHtml).join('')
    : '<p class="muted-text">سجلك المحلي فارغ حالياً.</p>';
}

function clearLocalHistory() {
  state.history = [];
  localStorage.removeItem('nsk_history');
  renderHistory();
  showToast('تم مسح السجل المحلي.');
}

function askAssistant(topic) {
  const answers = {
    use: 'اضغط على زر "احصل على كود الآن" ليقوم نظام التوزيع الذكي باختيار كود معتمد لم يظهر لك سابقاً، ثم اضغط "نسخ" لاستخدامه.',
    submit: 'اضغط على "أضف كودك للمجتمع"، أدخل رمز الكود، وسيتم فحصه تلقائياً لمنع التكرار ثم عرضه على المشرفين لاعتماده.',
    statuses: '• معتمد للنشر: تمت مراجعته شكلياً.\n• أفاد المستخدمون بنجاحه: تقييمات إيجابية من الزوار (ليست ضماناً رسمياً).\n• بلاغات مشاكل: أبلغ زوار عن عدم عمله.',
    official: 'منصة NUSUK SHARE هي مبادرة مجتمعية مستقلة لتسهيل تبادل الأكواد بين الأفراد ولا تتصل بقاعدة بيانات تطبيق نسك الرسمي.'
  };
  document.getElementById('assistantAnswer').innerText = answers[topic] || '';
}

/* ============================================================================
 * ACCOUNTS & RBAC ADMIN DASHBOARD
 * ========================================================================== */

function openAccountModal() {
  document.getElementById('accountModal').classList.remove('hidden');
  if (state.user) renderLoggedInProfile();
}

function toggleAuthMode(mode, btn) {
  document.querySelectorAll('#loggedOutForms .tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('loginForm').classList.toggle('hidden', mode !== 'login');
  document.getElementById('registerForm').classList.toggle('hidden', mode !== 'register');
}

async function handleLogin(e) {
  e.preventDefault();
  try {
    const res = await apiCall('login', {
      username: document.getElementById('loginUsername').value,
      password: document.getElementById('loginPassword').value
    }, true);

    if (!res.ok) return showToast(res.error);

    state.token = res.token;
    state.user = res.user;
    localStorage.setItem('nsk_token', res.token);
    localStorage.setItem('nsk_user', JSON.stringify(res.user));
    updateAuthUI();
    closeModal('accountModal');
    showToast(`مرحباً ${res.user.display_name}`);

    if (['MODERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(res.user.role)) {
      showView('admin');
    }
  } catch (err) {
    showToast(err.message);
  }
}

async function handleRegister(e) {
  e.preventDefault();
  try {
    const res = await apiCall('registerContributor', {
      username: document.getElementById('regUsername').value,
      display_name: document.getElementById('regDisplayName').value,
      email: document.getElementById('regEmail').value,
      password: document.getElementById('regPassword').value
    }, true);

    if (!res.ok) return showToast(res.error);

    state.token = res.token;
    state.user = res.user;
    localStorage.setItem('nsk_token', res.token);
    localStorage.setItem('nsk_user', JSON.stringify(res.user));
    updateAuthUI();
    closeModal('accountModal');
    showToast('تم إنشاء حساب المساهم بنجاح!');
    refreshPublicData();
  } catch (err) {
    showToast(err.message);
  }
}

function updateAuthUI() {
  const isLoggedIn = Boolean(state.user && state.token);
  const isStaff = isLoggedIn && ['MODERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(state.user.role);

  document.getElementById('navAdminBtn').classList.toggle('hidden', !isStaff);
  document.getElementById('navProfileBtn').textContent = isLoggedIn ? `👤 ${state.user.display_name}` : 'حساب المساهم';
  document.getElementById('loggedOutForms').classList.toggle('hidden', isLoggedIn);
  document.getElementById('loggedInProfile').classList.toggle('hidden', !isLoggedIn);
}

async function renderLoggedInProfile() {
  const box = document.getElementById('loggedInProfile');
  box.innerHTML = '<p>جاري تحميل بيانات الحساب...</p>';
  try {
    const res = await apiCall('getProfile');
    if (!res.ok) {
      logoutUser();
      return;
    }
    const p = res.profile;
    box.innerHTML = `
      <p><strong>الاسم:</strong> ${escapeHtml(p.display_name)} (${escapeHtml(p.role)})</p>
      <p><strong>نقاط السمعة:</strong> ${p.points} | <strong>أكواد معتمدة:</strong> ${p.approved_count}</p>
      <div style="margin:10px 0;">
        ${(p.badges || []).map(b => `<span class="badge-gold">${escapeHtml(b.badge_title_ar)}</span>`).join(' ')}
      </div>
      <button class="btn btn-outline btn-block" onclick="logoutUser()">تسجيل الخروج</button>
    `;
  } catch (err) {
    box.innerHTML = `<button class="btn btn-outline btn-block" onclick="logoutUser()">تسجيل الخروج</button>`;
  }
}

function logoutUser() {
  state.token = '';
  state.user = null;
  localStorage.removeItem('nsk_token');
  localStorage.removeItem('nsk_user');
  updateAuthUI();
  closeModal('accountModal');
  showView('home');
  showToast('تم تسجيل الخروج');
}

async function loadAdminDashboard() {
  try {
    const res = await apiCall('adminDashboard');
    if (!res.ok) return showToast(res.error);

    state.adminData = res;
    document.getElementById('adminRoleBadge').textContent = `Role: ${res.role}`;

    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(res.role);
    const isSuper = res.role === 'SUPER_ADMIN';
    document.getElementById('tabUsersBtn').classList.toggle('hidden', !isAdmin);
    document.getElementById('tabLogsBtn').classList.toggle('hidden', !isAdmin);
    document.getElementById('tabSettingsBtn').classList.toggle('hidden', !isSuper);
    document.getElementById('btnDbBackup').classList.toggle('hidden', !isSuper);

    const s = res.summary;
    document.getElementById('adminKpis').innerHTML = `
      <div class="stat-card"><div class="stat-num">${s.total_codes}</div><div class="stat-label">إجمالي الأكواد</div></div>
      <div class="stat-card"><div class="stat-num">${s.approved_codes}</div><div class="stat-label">معتمد</div></div>
      <div class="stat-card"><div class="stat-num">${s.pending_codes}</div><div class="stat-label">قيد المراجعة</div></div>
      <div class="stat-card"><div class="stat-num">${s.rejected_codes}</div><div class="stat-label">مرفوض</div></div>
      <div class="stat-card"><div class="stat-num">${s.disabled_codes}</div><div class="stat-label">معطل</div></div>
      <div class="stat-card"><div class="stat-num">${s.total_copies}</div><div class="stat-label">إجمالي النسخ</div></div>
      <div class="stat-card"><div class="stat-num">${s.success_reports}</div><div class="stat-label">بلاغات نجاح</div></div>
      <div class="stat-card"><div class="stat-num">${s.problem_reports}</div><div class="stat-label">بلاغات مشاكل</div></div>
    `;

    renderAdminCharts(s, res.daily_trend);
    renderAdminCodesTable();
  } catch (err) {
    showToast(err.message);
  }
}

function renderAdminCharts(summary, dailyTrend) {
  if (typeof Chart === 'undefined') return;
  if (state.charts.pie) state.charts.pie.destroy();
  if (state.charts.line) state.charts.line.destroy();

  state.charts.pie = new Chart(document.getElementById('statusPieChart'), {
    type: 'doughnut',
    data: {
      labels: ['معتمد', 'قيد المراجعة', 'مرفوض', 'معطل'],
      datasets: [{
        data: [summary.approved_codes, summary.pending_codes, summary.rejected_codes, summary.disabled_codes],
        backgroundColor: ['#15803D', '#D4AF37', '#B91C1C', '#64748B']
      }]
    }
  });

  const days = Object.keys(dailyTrend).sort();
  state.charts.line = new Chart(document.getElementById('dailyTrendChart'), {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{
        label: 'الأكواد المرسلة يومياً',
        data: days.map(d => dailyTrend[d]),
        backgroundColor: '#0B3B36'
      }]
    }
  });
}

function switchAdminTab(tab, btn) {
  document.querySelectorAll('.admin-tabs .tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (tab === 'codes') renderAdminCodesTable();
  else if (tab === 'reports') renderAdminReportsTable();
  else if (tab === 'users') renderAdminUsersTable();
  else if (tab === 'logs') renderAdminLogsTable();
  else if (tab === 'settings') renderAdminSettingsTable();
}

function renderAdminCodesTable() {
  const codes = state.adminData?.codes || [];
  const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(state.adminData?.role);
  document.getElementById('adminTabContent').innerHTML = `
    <table>
      <thead>
        <tr>
          <th>الكود</th>
          <th>الحالة</th>
          <th>المساهم</th>
          <th>النسخ</th>
          <th>نجاح / مشاكل</th>
          <th>الإجراءات</th>
        </tr>
      </thead>
      <tbody>
        ${codes.map(c => `
          <tr>
            <td><strong>${escapeHtml(c.code_value)}</strong></td>
            <td>${escapeHtml(c.status)}</td>
            <td>${escapeHtml(c.contributor_name)}</td>
            <td>${c.copies_count}</td>
            <td>✅ ${c.success_reports} / ⚠️ ${c.problem_reports}</td>
            <td style="display:flex; gap:4px; flex-wrap:wrap;">
              <button class="btn btn-primary btn-sm" onclick="execCodeOp('${c.code_id}', 'approve')">اعتماد</button>
              <button class="btn btn-outline btn-sm" onclick="execCodeOp('${c.code_id}', 'reject')">رفض</button>
              ${isAdmin ? `<button class="btn btn-outline btn-sm" onclick="execCodeOp('${c.code_id}', 'disable')">تعطيل</button>` : ''}
              ${isAdmin ? `<button class="btn btn-outline btn-sm" onclick="execCodeOp('${c.code_id}', 'delete')">حذف</button>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function execCodeOp(codeId, op) {
  if (op === 'delete' && !confirm('هل أنت متأكد من حذف هذا الكود نهائياً؟')) return;
  const res = await apiCall('adminCodeAction', { code_id: codeId, op }, true);
  showToast(res.ok ? res.message : res.error);
  if (res.ok) {
    loadAdminDashboard();
    refreshPublicData();
  }
}

function renderAdminReportsTable() {
  const reports = state.adminData?.reports || [];
  document.getElementById('adminTabContent').innerHTML = `
    <table>
      <thead><tr><th>الكود</th><th>النوع</th><th>السبب</th><th>الحالة</th><th>إجراء</th></tr></thead>
      <tbody>
        ${reports.map(r => `
          <tr>
            <td>${escapeHtml(r.code_id)}</td>
            <td>${escapeHtml(r.report_type)}</td>
            <td>${escapeHtml(r.reason)}</td>
            <td>${escapeHtml(r.resolved_status)}</td>
            <td><button class="btn btn-primary btn-sm" onclick="resolveReport('${r.report_id}')">إغلاق البلاغ</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function resolveReport(reportId) {
  const res = await apiCall('adminResolveReport', { report_id: reportId }, true);
  if (res.ok) {
    showToast('تم إغلاق البلاغ');
    loadAdminDashboard();
  }
}

function renderAdminUsersTable() {
  const users = state.adminData?.contributors || [];
  document.getElementById('adminTabContent').innerHTML = `
    <table>
      <thead><tr><th>الاسم</th><th>المستخدم</th><th>الرتبة</th><th>النقاط</th><th>الحالة</th><th>إجراء</th></tr></thead>
      <tbody>
        ${users.map(u => `
          <tr>
            <td>${escapeHtml(u.display_name)}</td>
            <td>${escapeHtml(u.username)}</td>
            <td>${escapeHtml(u.role)}</td>
            <td>${u.points}</td>
            <td>${escapeHtml(u.status)}</td>
            <td>
              <button class="btn btn-outline btn-sm" onclick="execUserOp('${u.contributor_id}', '${u.status === 'active' ? 'suspend' : 'restore'}')">
                ${u.status === 'active' ? 'تعليق' : 'استعادة'}
              </button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function execUserOp(contributorId, op) {
  const res = await apiCall('adminUserAction', { contributor_id: contributorId, op }, true);
  showToast(res.ok ? res.message : res.error);
  if (res.ok) loadAdminDashboard();
}

function renderAdminLogsTable() {
  const logs = state.adminData?.logs || [];
  document.getElementById('adminTabContent').innerHTML = `
    <table>
      <thead><tr><th>الوقت</th><th>المنفذ</th><th>الرتبة</th><th>الإجراء</th><th>الهدف</th></tr></thead>
      <tbody>
        ${logs.map(l => `
          <tr>
            <td>${formatDate(l.created_at)}</td>
            <td>${escapeHtml(l.actor_id)}</td>
            <td>${escapeHtml(l.actor_role)}</td>
            <td>${escapeHtml(l.action)}</td>
            <td>${escapeHtml(l.target_id)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderAdminSettingsTable() {
  const settings = state.adminData?.settings || [];
  document.getElementById('adminTabContent').innerHTML = `
    <table>
      <thead><tr><th>الإعداد</th><th>القيمة</th><th>تحديث</th></tr></thead>
      <tbody>
        ${settings.map(s => `
          <tr>
            <td>${escapeHtml(s.setting_key)}</td>
            <td><input type="text" id="set_${s.setting_key}" value="${escapeHtml(s.setting_value)}" /></td>
            <td><button class="btn btn-primary btn-sm" onclick="saveSetting('${s.setting_key}')">حفظ</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function saveSetting(key) {
  const val = document.getElementById('set_' + key).value;
  const res = await apiCall('adminUpdateSettings', { setting_key: key, setting_value: val }, true);
  showToast(res.ok ? 'تم حفظ الإعداد' : res.error);
}

function exportCodesCsv() {
  const codes = state.adminData?.codes || state.codes;
  const headers = ['code_id', 'code_value', 'status', 'contributor_name', 'copies_count', 'success_reports', 'problem_reports', 'created_at'];
  const csvRows = [headers.join(',')];
  codes.forEach(c => {
    csvRows.push(headers.map(h => `"${String(c[h] ?? '').replace(/"/g, '""')}"`).join(','));
  });
  const blob = new Blob(['\uFEFF' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `nusuk-share-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

async function triggerBackup() {
  const res = await apiCall('backupDatabase', {}, true);
  showToast(res.ok ? `تم إنشاء نسخة: ${res.backup_name}` : res.error);
}

/* ============================================================================
 * NAVIGATION, THEME, I18N & PWA
 * ========================================================================== */

function showView(viewName, sortPreset) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + viewName)?.classList.add('active');
  document.querySelectorAll('.nav-links .nav-btn').forEach(b => b.classList.remove('active'));

  if (viewName === 'browse' && sortPreset) {
    document.getElementById('browseSort').value = sortPreset;
    renderBrowseList();
  }
  if (viewName === 'admin') {
    loadAdminDashboard();
  }
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('nsk_theme', state.theme);
  applyTheme(state.theme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeToggle').textContent = theme === 'light' ? '🌙' : '☀️';
}

function toggleLang() {
  state.lang = state.lang === 'ar' ? 'en' : 'ar';
  localStorage.setItem('nsk_lang', state.lang);
  applyLang(state.lang);
}

function applyLang(lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.getElementById('langToggle').textContent = lang === 'ar' ? 'EN' : 'عربي';

  const dict = {
    en: {
      brandSub: 'Community Code Sharing Platform',
      navHome: 'Home',
      navBrowse: 'Browse Codes',
      navLeaderboard: 'Leaderboard',
      navHistory: 'My History',
      navAccount: 'Contributor',
      navAdmin: 'Admin Panel',
      heroBadge: 'Open Community • No Login Required',
      heroTitle: 'Share & Get Nusuk Codes Fairly and Smartly',
      heroDesc: 'A community-driven platform with fair smart distribution, duplicate prevention, instant QR sharing, and real user feedback.',
      btnGetCode: '✨ Get a Code Now',
      btnAddCode: '➕ Add Your Code',
      heroDisclaimer: '* Disclaimer: Independent community initiative. Statuses reflect user reports, not official guarantees.',
      smartPickLabel: 'Smart Distribution Pick',
      btnAnotherCode: '🔄 Another Code',
      statApproved: 'Approved Codes',
      statCopies: 'Total Copies',
      statSuccess: 'Success Reports',
      statContributors: 'Active Contributors',
      btnBrowseAll: 'Browse All',
      latestTitle: 'Latest Shared Codes',
      popularTitle: 'Most Copied Codes',
      seeAll: 'See All →',
      howTitle: 'How NUSUK SHARE Works',
      step1Title: 'Get a Code in One Click',
      step1Desc: 'Our fair distribution algorithm prioritizes approved codes you haven’t seen yet.',
      step2Title: 'Copy or Share via QR',
      step2Desc: 'Instant one-tap copy, WhatsApp/Telegram share links, and generated QR codes.',
      step3Title: 'Report & Contribute',
      step3Desc: 'Let the community know if a code worked and share your own codes to earn reputation points.',
      assistantTitle: '🤖 NUSUK SHARE Assistant & FAQ',
      assistantSub: 'Select a question to learn how the platform works:',
      browseTitle: 'Approved Codes Directory',
      lbTitle: '🏆 Community Leaderboard',
      joinContributors: 'Join Contributors',
      lbSub: 'Points are awarded automatically when submitted codes are approved and verified by community feedback.',
      histTitle: '🕒 My Code History',
      clearHist: 'Clear Local History',
      histSub: 'Saved locally in your browser for visitors and synced with your contributor account.',
      footerAbout: 'Open community platform for fair and transparent Nusuk code sharing.',
      footerPolicyTitle: 'Privacy & Disclaimer',
      footerPolicyText: 'No registration is required for visitors. NUSUK SHARE is an independent community tool and is not affiliated with the official Nusuk app.'
    }
  };

  if (lang === 'en') {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      if (dict.en[k]) el.textContent = dict.en[k];
    });
  } else {
    // Reload default Arabic DOM strings cleanly if toggled back
    if (document.documentElement.dataset.loadedEn) location.reload();
  }
  if (lang === 'en') document.documentElement.dataset.loadedEn = '1';
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.add('hidden'), 3600);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(state.lang === 'ar' ? 'ar-EG' : 'en-US', { month: 'short', day: 'numeric' });
}

function registerPWA() {
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  let deferredPrompt;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById('installPwaBtn');
    btn.style.display = 'inline-block';
    btn.onclick = () => deferredPrompt.prompt();
  });
}