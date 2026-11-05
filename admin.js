(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const BN = '০১২৩৪৫৬৭৮৯';
  const bn = (n) => String(n).replace(/\d/g, (d) => BN[d]);
  const toLatin = (s) => String(s).replace(/[০-৯]/g, (d) => BN.indexOf(d));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const taka = (n) => '৳' + bn(Number(n).toLocaleString('en-US'));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
  };
  const TABS = ['orders', 'menu', 'qr', 'settings'];
  const NEXT = { new: ['preparing', 'রান্না শুরু', 'btn-info'], preparing: ['ready', 'প্রস্তুত', 'btn-ok'], ready: ['served', 'পরিবেশন হয়েছে', 'btn-brand'] };

  let settings = null;
  let menu = null;
  let orders = [];
  let seen = null;
  let fresh = new Set();
  let tab = 'orders';
  let col = 'new';
  let sound = store.get('rg_sound', false);
  let es = null;
  let editingCat = null;
  let editingItem = null; // null = নতুন
  let dlgImage = '';
  let armed = '';
  let armedTimer = 0;
  let pendingMenuRender = false;
  let started = false;

  /* ---------- সহায়ক ---------- */
  let toastTimer = 0;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
  }
  async function api(method, url, body, raw) {
    const opt = { method, headers: { 'X-RG': '1' } };
    if (raw) { opt.body = raw; opt.headers['Content-Type'] = raw.type || 'application/octet-stream'; }
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(url, opt);
    let d = null;
    try { d = await r.json(); } catch (_) { /* ignore */ }
    if (r.status === 401 && url !== '/api/admin/login') { showLogin(); throw new Error('আবার লগইন করুন'); }
    if (!r.ok) throw new Error((d && d.error) || 'কিছু একটা ভুল হয়েছে');
    return d;
  }
  // দুইবার চাপলে কাজ হবে (ভুল করে মোছা ঠেকাতে)
  function twice(key, fn) {
    if (armed === key) { armed = ''; clearTimeout(armedTimer); fn(); return; }
    armed = key; clearTimeout(armedTimer);
    armedTimer = setTimeout(() => { armed = ''; rerender(); }, 3000);
    rerender();
  }
  const isArmed = (key) => armed === key;
  function rerender() { renderOrders(); if (tab === 'menu') renderMenuTab(); }

  const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  function clock(ms) {
    const d = new Date(ms);
    return bn(String(d.getHours() % 12 || 12)) + ':' + bn(String(d.getMinutes()).padStart(2, '0'));
  }
  function ago(ms) {
    const m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return 'এইমাত্র';
    if (m < 60) return bn(m) + ' মিনিট আগে';
    return bn(Math.floor(m / 60)) + ' ঘণ্টা আগে';
  }
  function hue(name) { let h = 0; for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360; return h; }
  const thumb = (it) => it.image
    ? `<img src="${esc(it.image)}" alt="" loading="lazy" width="52" height="52">`
    : `<div class="ph" style="--h:${hue(it.name)}">${esc([...it.name][0] || '?')}</div>`;

  /* ---------- সাউন্ড ---------- */
  let ac = null;
  function beep() {
    if (!sound) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const t = ac.currentTime;
      [880, 1175, 880, 1175].forEach((f, i) => {
        const o = ac.createOscillator(); const g = ac.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const s = t + i * 0.2;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.4, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.17);
        o.connect(g); g.connect(ac.destination);
        o.start(s); o.stop(s + 0.18);
      });
    } catch (_) { /* ignore */ }
  }
  function renderSound() { $('#soundBtn').textContent = sound ? 'সাউন্ড চালু' : 'সাউন্ড বন্ধ'; }

  /* ---------- লগইন ---------- */
  function showLogin() {
    $('#login').hidden = false; $('#app').hidden = true;
    if (es) { es.close(); es = null; }
    started = false;
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#loginErr');
    err.hidden = true;
    try {
      await api('POST', '/api/admin/login', { password: $('#pw').value });
      $('#pw').value = '';
      boot();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  });
  $('#logout').addEventListener('click', async () => {
    try { await api('POST', '/api/admin/logout', {}); } catch (_) { /* ignore */ }
    showLogin();
  });

  /* ---------- ডেটা আনা ---------- */
  async function loadOrders() {
    try {
      const d = await api('GET', '/api/admin/orders');
      const ids = new Set(d.orders.map((o) => o.id));
      if (seen) {
        const added = d.orders.filter((o) => !seen.has(o.id) && o.status === 'new');
        if (added.length) {
          beep();
          added.forEach((o) => fresh.add(o.id));
          setTimeout(() => { added.forEach((o) => fresh.delete(o.id)); renderOrders(); }, 20000);
          toast(`নতুন অর্ডার: টেবিল ${bn(added[0].table)}${added.length > 1 ? ` ও আরও ${bn(added.length - 1)}টি` : ''}`);
        }
      }
      seen = ids;
      orders = d.orders;
      renderOrders();
    } catch (_) { /* পরের বার আবার চেষ্টা হবে */ }
  }
  async function loadMenu() {
    try {
      menu = await (await fetch('/api/menu')).json();
      settings = await api('GET', '/api/admin/settings');
      $('#shopName').textContent = settings.name;
      document.title = settings.name + ' · অ্যাডমিন';
      if (tab === 'menu') {
        if (document.activeElement && document.activeElement.matches('#tab-menu input')) pendingMenuRender = true;
        else renderMenuTab();
      }
      if (tab === 'qr') renderQr();
      if (tab === 'settings') renderSettings();
    } catch (_) { /* ignore */ }
  }
  document.addEventListener('focusout', () => {
    if (pendingMenuRender) setTimeout(() => { if (!document.activeElement || !document.activeElement.matches('#tab-menu input')) { pendingMenuRender = false; renderMenuTab(); } }, 50);
  });

  function connect() {
    if (es) es.close();
    let first = true;
    es = new EventSource('/api/admin/stream');
    es.addEventListener('change', (e) => { if (e.data === 'orders') loadOrders(); else loadMenu(); });
    es.onopen = () => { setLive(true); if (!first) { loadOrders(); loadMenu(); } first = false; };
    es.onerror = () => setLive(false);
  }
  function setLive(on) {
    $('#live').classList.toggle('off', !on);
    $('#liveText').textContent = on ? 'লাইভ' : 'সংযোগ নেই';
  }

  /* ---------- ট্যাব ---------- */
  function setTab(t, push) {
    tab = TABS.includes(t) ? t : 'orders';
    TABS.forEach((n) => { $('#tab-' + n).hidden = n !== tab; });
    document.querySelectorAll('#tabs button').forEach((b) => {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (push) history.replaceState(null, '', '#' + tab);
    if (tab === 'orders') renderOrders();
    if (tab === 'menu') renderMenuTab();
    if (tab === 'qr') renderQr();
    if (tab === 'settings') renderSettings();
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab, true); });
  window.addEventListener('hashchange', () => { if (started) setTab(location.hash.slice(1)); });

  /* ---------- অর্ডার বোর্ড ---------- */
  function ticket(o) {
    const next = NEXT[o.status];
    const live = !!next;
    const late = o.status === 'new' && Date.now() - o.createdAt > 5 * 60000;
    return `<article class="ticket${fresh.has(o.id) ? ' fresh' : ''}">
      <div class="t-head">
        <div class="t-table"><small>টেবিল</small><b>${esc(bn(o.table))}</b></div>
        <div class="t-meta"><span>#${bn(o.code)} · ${clock(o.createdAt)}</span><span>${ago(o.createdAt)}</span>
          ${late ? '<span class="pill late">৫ মিনিটের বেশি</span>' : ''}
          ${o.status === 'cancelled' ? '<span class="pill cancelled">বাতিল</span>' : ''}${o.status === 'served' ? '<span class="pill served">পরিবেশিত</span>' : ''}</div>
      </div>
      <ul class="t-items">${o.items.map((i) => `<li><b>${bn(i.qty)}×</b><span>${esc(i.name)}</span></li>`).join('')}</ul>
      ${o.note ? `<div class="t-note">${esc(o.note)}</div>` : ''}
      <div class="t-foot"><strong>${taka(o.total)}</strong>
        <div class="t-acts">
          ${live ? `<button type="button" class="btn btn-sm main ${next[2]}" data-act="adv" data-id="${o.id}" data-to="${next[0]}">${next[1]}</button>
          <button type="button" class="btn btn-sm btn-ghost" data-act="cancel" data-id="${o.id}">${isArmed('cancel' + o.id) ? 'নিশ্চিত?' : 'বাতিল'}</button>`
    : `<button type="button" class="btn btn-sm btn-ghost" data-act="del" data-id="${o.id}">${isArmed('del' + o.id) ? 'নিশ্চিত?' : 'মুছুন'}</button>`}
        </div></div>
    </article>`;
  }
  function renderOrders() {
    if (!started) return;
    const start = dayStart();
    const today = orders.filter((o) => o.createdAt >= start);
    const cols = {
      new: orders.filter((o) => o.status === 'new').reverse(),
      preparing: orders.filter((o) => o.status === 'preparing').reverse(),
      ready: orders.filter((o) => o.status === 'ready').reverse(),
      done: today.filter((o) => o.status === 'served' || o.status === 'cancelled'),
    };
    const sales = today.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0);
    const pending = cols.new.length + cols.preparing.length + cols.ready.length;
    $('#stats').innerHTML = `
      <div class="stat${cols.new.length ? ' hot' : ''}"><small>নতুন অর্ডার</small><b>${bn(cols.new.length)}</b></div>
      <div class="stat"><small>চলমান (মোট)</small><b>${bn(pending)}</b></div>
      <div class="stat"><small>আজকের অর্ডার</small><b>${bn(today.filter((o) => o.status !== 'cancelled').length)}</b></div>
      <div class="stat"><small>আজকের বিক্রি</small><b>${taka(sales)}</b></div>`;
    const defs = [['new', 'নতুন'], ['preparing', 'রান্না হচ্ছে'], ['ready', 'প্রস্তুত'], ['done', 'আজ শেষ হয়েছে']];
    $('#colChips').innerHTML = defs.map(([k, n]) => `<button type="button" data-col="${k}" aria-pressed="${col === k}">${n} (${bn(cols[k].length)})</button>`).join('');
    $('#board').innerHTML = defs.map(([k, n]) => `
      <div class="col${col === k ? ' on' : ''}"><div class="col-h"><span class="dot ${k}"></span>${n}<span class="n">${bn(cols[k].length)}</span></div>
        ${cols[k].length ? cols[k].map(ticket).join('') : '<div class="col-empty">কোনো অর্ডার নেই</div>'}</div>`).join('');
    const nb = $('#newBadge');
    nb.hidden = !cols.new.length;
    nb.textContent = bn(cols.new.length);
    const name = settings ? settings.name : 'অ্যাডমিন';
    document.title = (cols.new.length ? `(${bn(cols.new.length)}) নতুন অর্ডার · ` : '') + name + ' · অ্যাডমিন';
  }
  $('#colChips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { col = b.dataset.col; renderOrders(); } });
  $('#board').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    try {
      if (b.dataset.act === 'adv') { b.disabled = true; await api('PATCH', '/api/admin/orders/' + id, { status: b.dataset.to }); await loadOrders(); }
      if (b.dataset.act === 'cancel') twice('cancel' + id, async () => { try { await api('PATCH', '/api/admin/orders/' + id, { status: 'cancelled' }); await loadOrders(); } catch (x) { toast(x.message, true); } });
      if (b.dataset.act === 'del') twice('del' + id, async () => { try { await api('DELETE', '/api/admin/orders/' + id); await loadOrders(); } catch (x) { toast(x.message, true); } });
    } catch (x) { toast(x.message, true); b.disabled = false; }
  });

  /* ---------- মেনু ও দাম ---------- */
  function renderMenuTab() {
    if (!menu) return;
    const cats = menu.categories;
    $('#tab-menu').innerHTML = `
      <div class="mtools">
        <button type="button" class="btn btn-brand" data-act="item-new" ${cats.length ? '' : 'disabled'}>+ নতুন খাবার যোগ করুন</button>
        <form id="catForm"><input id="catName" maxlength="40" placeholder="নতুন ক্যাটাগরির নাম" aria-label="নতুন ক্যাটাগরির নাম" autocomplete="off"><button class="btn" type="submit">ক্যাটাগরি যোগ করুন</button></form>
      </div>
      ${cats.length ? '' : '<p class="hint">আগে একটি ক্যাটাগরি যোগ করুন (যেমন: ভাত, পানীয়)।</p>'}
      ${cats.map((c, ci) => {
    const items = menu.items.filter((i) => i.categoryId === c.id);
    return `<section class="mcat">
        <div class="mcat-h">
          ${editingCat === c.id
    ? `<form class="rename" data-cat="${c.id}"><input id="renameIn" value="${esc(c.name)}" maxlength="40" aria-label="ক্যাটাগরির নাম"><button class="btn btn-sm btn-brand" type="submit">সংরক্ষণ</button><button class="btn btn-sm" type="button" data-act="cat-rename-cancel">বাতিল</button></form>`
    : `<h2>${esc(c.name)}</h2><span class="count">${bn(items.length)}টি খাবার</span>
          <div class="mcat-acts">
            <button type="button" class="btn btn-sm btn-ghost" data-act="cat-up" data-id="${c.id}" ${ci === 0 ? 'disabled' : ''} aria-label="উপরে নিন">↑</button>
            <button type="button" class="btn btn-sm btn-ghost" data-act="cat-down" data-id="${c.id}" ${ci === cats.length - 1 ? 'disabled' : ''} aria-label="নিচে নিন">↓</button>
            <button type="button" class="btn btn-sm btn-ghost" data-act="cat-rename" data-id="${c.id}">নাম বদলান</button>
            <button type="button" class="btn btn-sm btn-ghost" data-act="cat-del" data-id="${c.id}">${isArmed('catdel' + c.id) ? 'নিশ্চিত?' : 'মুছুন'}</button>
          </div>`}
        </div>
        ${items.length ? items.map((it) => `
        <div class="mrow${it.available ? '' : ' off'}">
          <div class="thumb">${thumb(it)}</div>
          <div class="minfo"><b>${esc(it.name)}</b>${it.desc ? `<span class="desc">${esc(it.desc)}</span>` : ''}</div>
          <label class="price-edit"><span aria-hidden="true">৳</span><input class="price-in" data-id="${it.id}" data-orig="${it.price}" inputmode="numeric" value="${it.price}" aria-label="${esc(it.name)} এর দাম"></label>
          <label class="sw"><input type="checkbox" class="av-in" data-id="${it.id}" ${it.available ? 'checked' : ''}><span class="knob"></span><span>${it.available ? 'আছে' : 'নেই'}</span></label>
          <div class="macts"><button type="button" class="btn btn-sm" data-act="item-edit" data-id="${it.id}">সম্পাদনা</button><button type="button" class="btn btn-sm btn-ghost" data-act="item-del" data-id="${it.id}">${isArmed('itemdel' + it.id) ? 'নিশ্চিত?' : 'মুছুন'}</button></div>
        </div>`).join('') : '<div class="mrow"><span></span><span class="hint">এই ক্যাটাগরিতে এখনো কোনো খাবার নেই।</span></div>'}
      </section>`;
  }).join('')}`;
    if (editingCat) { const i = $('#renameIn'); if (i) { i.focus(); i.select(); } }
  }

  $('#tab-menu').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (e.target.id === 'catForm') {
        const v = $('#catName').value.trim();
        if (!v) return;
        await api('POST', '/api/admin/categories', { name: v });
        toast('ক্যাটাগরি যোগ হয়েছে');
        await loadMenu();
      } else if (e.target.classList.contains('rename')) {
        await api('PATCH', '/api/admin/categories/' + e.target.dataset.cat, { name: $('#renameIn').value });
        editingCat = null;
        await loadMenu();
      }
    } catch (x) { toast(x.message, true); }
  });
  $('#tab-menu').addEventListener('change', async (e) => {
    const t = e.target;
    try {
      if (t.classList.contains('price-in')) {
        const v = toLatin(t.value.trim());
        if (!/^\d{1,7}$/.test(v)) { toast('দাম শুধু সংখ্যায় দিন', true); t.value = t.dataset.orig; return; }
        if (v === t.dataset.orig) { t.value = v; return; }
        await api('PATCH', '/api/admin/items/' + t.dataset.id, { price: Number(v) });
        t.dataset.orig = v; t.value = v;
        t.closest('.price-edit').classList.add('saved');
        toast('দাম বদলানো হয়েছে: ' + taka(v));
        const it = menu.items.find((i) => i.id === t.dataset.id); if (it) it.price = Number(v);
      } else if (t.classList.contains('av-in')) {
        await api('PATCH', '/api/admin/items/' + t.dataset.id, { available: t.checked });
        const it = menu.items.find((i) => i.id === t.dataset.id); if (it) it.available = t.checked;
        toast(t.checked ? 'খাবারটি চালু করা হয়েছে' : 'খাবারটি "নেই" করা হয়েছে');
        renderMenuTab();
      }
    } catch (x) { toast(x.message, true); loadMenu(); }
  });
  $('#tab-menu').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    const act = b.dataset.act;
    try {
      if (act === 'item-new') openItemDialog(null);
      if (act === 'item-edit') openItemDialog(menu.items.find((i) => i.id === id));
      if (act === 'item-del') twice('itemdel' + id, async () => { try { await api('DELETE', '/api/admin/items/' + id); toast('খাবারটি মোছা হয়েছে'); await loadMenu(); } catch (x) { toast(x.message, true); } });
      if (act === 'cat-del') twice('catdel' + id, async () => { try { await api('DELETE', '/api/admin/categories/' + id); toast('ক্যাটাগরি মোছা হয়েছে'); await loadMenu(); } catch (x) { toast(x.message, true); } });
      if (act === 'cat-rename') { editingCat = id; renderMenuTab(); }
      if (act === 'cat-rename-cancel') { editingCat = null; renderMenuTab(); }
      if (act === 'cat-up' || act === 'cat-down') {
        const ids = menu.categories.map((c) => c.id);
        const i = ids.indexOf(id); const j = act === 'cat-up' ? i - 1 : i + 1;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await api('PUT', '/api/admin/categories/order', { ids });
        await loadMenu();
      }
    } catch (x) { toast(x.message, true); }
  });

  /* ---------- খাবার যোগ/সম্পাদনার ডায়ালগ ---------- */
  const dlg = $('#itemDlg');
  function previewHtml() {
    const name = $('#fName').value.trim() || '?';
    return dlgImage ? `<img src="${esc(dlgImage)}" alt="">` : `<div class="ph" style="--h:${hue(name)}">${esc([...name][0])}</div>`;
  }
  function openItemDialog(it) {
    editingItem = it;
    $('#itemDlgTitle').textContent = it ? 'খাবার সম্পাদনা' : 'নতুন খাবার';
    $('#fName').value = it ? it.name : '';
    $('#fDesc').value = it ? it.desc : '';
    $('#fPrice').value = it ? it.price : '';
    $('#fCat').innerHTML = menu.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('#fCat').value = it ? it.categoryId : menu.categories[0].id;
    $('#fAvail').checked = it ? it.available : true;
    dlgImage = it ? it.image : '';
    $('#fPreview').innerHTML = previewHtml();
    $('#fErr').hidden = true;
    $('#fSave').disabled = false;
    dlg.showModal();
    $('#fName').focus();
  }
  $('#fName').addEventListener('input', () => { if (!dlgImage) $('#fPreview').innerHTML = previewHtml(); });
  $('#fCancel').addEventListener('click', () => dlg.close());
  $('#fPick').addEventListener('click', () => $('#fFile').click());
  $('#fClear').addEventListener('click', () => { dlgImage = ''; $('#fPreview').innerHTML = previewHtml(); });

  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('শুধু JPG, PNG বা WEBP ছবি দিন');
    try {
      const bmp = await createImageBitmap(file);
      const sc = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * sc)); const h = Math.max(1, Math.round(bmp.height * sc));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.84));
      if (blob) return blob;
    } catch (_) { /* মূল ফাইল পাঠানো হবে */ }
    if (file.size > 3 * 1024 * 1024) throw new Error('ছবি ৩ এমবির কম হতে হবে');
    return file;
  }
  $('#fFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const err = $('#fErr');
    err.hidden = true;
    $('#fPick').disabled = true; $('#fPick').textContent = 'আপলোড হচ্ছে…';
    try {
      const blob = await shrink(f);
      const r = await api('POST', '/api/admin/upload', undefined, blob);
      dlgImage = r.url;
      $('#fPreview').innerHTML = previewHtml();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
    $('#fPick').disabled = false; $('#fPick').textContent = 'ছবি বেছে নিন';
  });
  $('#itemForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#fErr');
    const name = $('#fName').value.trim();
    const price = toLatin($('#fPrice').value.trim());
    if (!name) { err.textContent = 'খাবারের নাম লিখুন'; err.hidden = false; return; }
    if (!/^\d{1,7}$/.test(price)) { err.textContent = 'দাম শুধু সংখ্যায় দিন (যেমন ২৫০)'; err.hidden = false; return; }
    const body = { name, desc: $('#fDesc').value.trim(), price: Number(price), categoryId: $('#fCat').value, available: $('#fAvail').checked, image: dlgImage };
    $('#fSave').disabled = true;
    try {
      if (editingItem) await api('PATCH', '/api/admin/items/' + editingItem.id, body);
      else await api('POST', '/api/admin/items', body);
      dlg.close();
      toast(editingItem ? 'পরিবর্তন সংরক্ষণ হয়েছে' : 'নতুন খাবার যোগ হয়েছে');
      await loadMenu();
    } catch (x) { err.textContent = x.message; err.hidden = false; $('#fSave').disabled = false; }
  });

  /* ---------- QR কোড ---------- */
  const baseUrl = () => ((settings && settings.baseUrl) || location.origin).replace(/\/+$/, '');
  const qrSrc = (link) => '/api/qr?text=' + encodeURIComponent(link);
  function qrCard(label, link, sub) {
    return `<div class="qr-card"><div class="shop">${esc(settings.name)}</div><div class="scan">স্ক্যান করে অর্ডার করুন</div>
      <img src="${qrSrc(link)}" alt="QR কোড: ${esc(label)}" width="190" height="190"><div class="tno">${esc(label)}</div>
      ${sub ? `<div class="scan">${esc(sub)}</div>` : ''}<div class="url">${esc(link)}</div>
      <a href="${qrSrc(link)}" download="qr-${esc(label.replace(/\s+/g, '-'))}.svg">SVG ডাউনলোড</a></div>`;
  }
  function renderQr() {
    if (!settings) return;
    const base = baseUrl();
    const local = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(base);
    const n = settings.tableCount;
    let cards = qrCard('সব টেবিল', base + '/', 'টেবিল নম্বর কাস্টমার নিজে দেবে');
    for (let i = 1; i <= n; i++) cards += qrCard('টেবিল ' + bn(i), base + '/?table=' + i, '');
    $('#tab-qr').innerHTML = `
      <div class="qr-controls no-print">
        <h2 class="sec">QR কোড ও প্রিন্ট</h2>
        <p class="hint">প্রতিটি টেবিলের জন্য আলাদা QR। স্ক্যান করলেই সরাসরি মেনু খুলবে, আর টেবিল নম্বর আগে থেকেই বসানো থাকবে।</p>
        ${local ? '<div class="note">এই ঠিকানা (' + esc(base) + ') শুধু আপনার নিজের কম্পিউটার বা নেটওয়ার্কে চলে। কাস্টমারের ফোনে খুলবে না। সাইট ইন্টারনেটে তুলে তার আসল ঠিকানা নিচে দিন।</div>' : ''}
        <form class="row" id="qrForm">
          <div class="f"><label for="qrBase">সাইটের ঠিকানা</label><input id="qrBase" value="${esc(settings.baseUrl)}" placeholder="${esc(location.origin)}" autocomplete="off"></div>
          <div class="f small"><label for="qrCount">টেবিলের সংখ্যা</label><input id="qrCount" inputmode="numeric" value="${n}" autocomplete="off"></div>
          <button class="btn btn-brand" type="submit">আপডেট করুন</button>
          <button class="btn" type="button" id="printQr">প্রিন্ট করুন</button>
        </form>
      </div>
      <div class="qr-grid">${cards}</div>`;
  }
  $('#tab-qr').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await saveSettings({ baseUrl: $('#qrBase').value.trim(), tableCount: $('#qrCount').value });
      toast('QR কোড হালনাগাদ হয়েছে');
      renderQr();
    } catch (x) { toast(x.message, true); }
  });
  $('#tab-qr').addEventListener('click', (e) => { if (e.target.id === 'printQr') window.print(); });

  /* ---------- সেটিংস ---------- */
  async function saveSettings(patch) {
    settings = await api('PUT', '/api/admin/settings', { ...settings, ...patch });
    $('#shopName').textContent = settings.name;
    return settings;
  }
  function renderSettings() {
    if (!settings) return;
    $('#tab-settings').innerHTML = `
      <h2 class="sec" style="margin-bottom:12px">সেটিংস</h2>
      <form class="sform" id="sForm">
        <div class="f"><label for="sName">রেস্টুরেন্টের নাম</label><input id="sName" maxlength="60" value="${esc(settings.name)}" autocomplete="off"></div>
        <div class="f"><label for="sTag">ছোট বর্ণনা (মেনুর ওপরে দেখাবে)</label><input id="sTag" maxlength="140" value="${esc(settings.tagline)}" autocomplete="off"></div>
        <div class="f"><label for="sCount">টেবিলের সংখ্যা</label><input id="sCount" inputmode="numeric" value="${settings.tableCount}" autocomplete="off"></div>
        <div class="f"><label for="sBase">সাইটের আসল ঠিকানা (QR কোডের জন্য)</label><input id="sBase" value="${esc(settings.baseUrl)}" placeholder="https://apnar-restaurant.com" autocomplete="off"></div>
        <label class="sw"><input type="checkbox" id="sOpen" ${settings.acceptingOrders ? 'checked' : ''}><span class="knob"></span><span>এখন অর্ডার নেওয়া হচ্ছে</span></label>
        <p class="err" id="sErr" role="alert" hidden></p>
        <button class="btn btn-brand" type="submit" style="align-self:flex-start">সংরক্ষণ করুন</button>
        <div class="help">পাসওয়ার্ড বদলাতে চাইলে সার্ভার চালানোর সময় <b>ADMIN_PASSWORD</b> সেট করে আবার চালু করুন। বিস্তারিত README ফাইলে আছে।</div>
      </form>`;
  }
  $('#tab-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#sErr');
    err.hidden = true;
    try {
      await saveSettings({
        name: $('#sName').value.trim(), tagline: $('#sTag').value.trim(), tableCount: $('#sCount').value,
        baseUrl: $('#sBase').value.trim(), acceptingOrders: $('#sOpen').checked,
      });
      toast('সেটিংস সংরক্ষণ হয়েছে');
      renderSettings();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  });

  /* ---------- সাউন্ড বোতাম ও চালু ---------- */
  $('#soundBtn').addEventListener('click', () => {
    sound = !sound; store.set('rg_sound', sound); renderSound();
    if (sound) { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume(); } catch (_) { /* ignore */ } beep(); }
  });

  async function boot() {
    try {
      await api('GET', '/api/admin/me');
      $('#login').hidden = true; $('#app').hidden = false;
      started = true;
      renderSound();
      await Promise.all([loadMenu(), loadOrders()]);
      setTab(location.hash.slice(1) || 'orders');
      connect();
    } catch (_) { showLogin(); }
  }
  setInterval(() => { if (started && !document.hidden) { loadOrders(); } }, 20000);
  boot();
})();
