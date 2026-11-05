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
  const STEPS = [['new', 'অর্ডার পেয়েছি'], ['preparing', 'রান্না হচ্ছে'], ['ready', 'প্রস্তুত, এখনই আসছে'], ['served', 'পরিবেশন হয়েছে']];

  let menu = null;
  let cart = store.get('rg_cart', {});
  let table = '';
  let query = '';
  let view = 'menu'; // menu | cart | track
  let activeOrder = store.get('rg_order', null); // { id, code, table }
  let tracked = null;
  let draftTable = '';
  let draftNote = '';
  let sending = false;
  let sendError = '';
  let toastTimer = 0;

  const qTable = new URLSearchParams(location.search).get('table');
  if (qTable && /^[0-9A-Za-zঀ-৿-]{1,10}$/.test(qTable)) { table = toLatin(qTable); store.set('rg_table', table); }
  else table = store.get('rg_table', '');
  draftTable = table;

  const byId = (id) => menu && menu.items.find((i) => i.id === id);

  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  async function getJson(url, opt) {
    const r = await fetch(url, opt);
    let d = null;
    try { d = await r.json(); } catch (_) { /* ignore */ }
    if (!r.ok) { const e = new Error((d && d.error) || 'কিছু একটা ভুল হয়েছে'); e.status = r.status; throw e; }
    return d;
  }

  /* ---------- কার্ট ---------- */
  const cartLines = () => Object.entries(cart)
    .map(([id, qty]) => ({ item: byId(id), qty }))
    .filter((l) => l.item && l.item.available && l.qty > 0);
  const cartCount = () => cartLines().reduce((s, l) => s + l.qty, 0);
  const cartTotal = () => cartLines().reduce((s, l) => s + l.qty * l.item.price, 0);
  function pruneCart() {
    for (const id of Object.keys(cart)) { const it = byId(id); if (!it || !it.available || !(cart[id] > 0)) delete cart[id]; }
    store.set('rg_cart', cart);
  }
  function change(id, delta) {
    const it = byId(id);
    if (!it || !it.available || !menu.settings.acceptingOrders) return;
    const q = Math.max(0, Math.min(50, (cart[id] || 0) + delta));
    if (q) cart[id] = q; else delete cart[id];
    store.set('rg_cart', cart);
    renderCtl(id);
    renderBar();
    if (view === 'cart') { readDrafts(); renderCart(); }
  }

  /* ---------- মেনু ---------- */
  function hue(name) { let h = 0; for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360; return h; }
  function pic(it) {
    if (it.image) return `<img src="${esc(it.image)}" alt="" loading="lazy" width="104" height="104">`;
    return `<div class="ph" style="--h:${hue(it.name)}">${esc([...it.name][0] || '?')}</div>`;
  }
  function ctlHtml(it) {
    if (!it.available) return '<span class="soldout">আজ নেই</span>';
    const off = !menu.settings.acceptingOrders;
    const q = cart[it.id] || 0;
    if (q > 0 && !off) {
      return `<div class="stepper"><button type="button" data-act="dec" data-id="${it.id}" aria-label="${esc(it.name)} কমান">−</button><span>${bn(q)}</span><button type="button" data-act="inc" data-id="${it.id}" aria-label="${esc(it.name)} বাড়ান">+</button></div>`;
    }
    return `<button type="button" class="add" data-act="inc" data-id="${it.id}" ${off ? 'disabled' : ''}>যোগ করুন</button>`;
  }
  function renderCtl(id) {
    const el = document.getElementById('ctl-' + id);
    const it = byId(id);
    if (el && it) el.innerHTML = ctlHtml(it);
  }

  function renderHead() {
    const s = menu.settings;
    $('#brand').textContent = s.name;
    $('#tagline').textContent = s.tagline;
    document.title = s.name + ' · মেনু ও অর্ডার';
    $('#closedBanner').hidden = s.acceptingOrders;
    const pill = $('#tablePill');
    pill.hidden = !table;
    pill.textContent = 'টেবিল ' + bn(table);
  }

  function renderMenu() {
    const q = query.trim().toLowerCase();
    const match = (it) => !q || it.name.toLowerCase().includes(q) || (it.desc || '').toLowerCase().includes(q);
    const groups = menu.categories
      .map((c) => ({ c, items: menu.items.filter((i) => i.categoryId === c.id && match(i)) }))
      .filter((g) => g.items.length);
    $('#chips').innerHTML = groups.map((g, i) => `<button type="button" class="chip${i === 0 ? ' on' : ''}" data-cat="${g.c.id}">${esc(g.c.name)}</button>`).join('');
    $('#chips').hidden = !groups.length;
    $('#menu').innerHTML = groups.length ? groups.map((g) => `
      <section class="cat" id="cat-${g.c.id}" data-cat="${g.c.id}">
        <h2>${esc(g.c.name)}</h2>
        <div class="list">${g.items.map((it) => `
          <article class="item${it.available ? '' : ' off'}">
            <div class="txt"><h3>${esc(it.name)}</h3>${it.desc ? `<p class="desc">${esc(it.desc)}</p>` : ''}<div class="price">${taka(it.price)}</div></div>
            <div class="pic">${pic(it)}<div class="ctl" id="ctl-${it.id}">${ctlHtml(it)}</div></div>
          </article>`).join('')}
        </div>
      </section>`).join('') : `<p class="state">${q ? 'এই নামে কিছু পাওয়া যায়নি।' : 'মেনু এখনো সাজানো হয়নি।'}</p>`;
    spy();
  }

  function spy() {
    const secs = [...document.querySelectorAll('.cat')];
    if (!secs.length) return;
    let cur = secs[0];
    for (const s of secs) if (s.getBoundingClientRect().top <= 150) cur = s;
    document.querySelectorAll('.chip').forEach((c) => {
      const on = c.dataset.cat === cur.dataset.cat;
      if (on && !c.classList.contains('on')) c.scrollIntoView({ inline: 'center', block: 'nearest' });
      c.classList.toggle('on', on);
    });
  }
  let spyTick = false;
  window.addEventListener('scroll', () => {
    if (spyTick || view !== 'menu') return;
    spyTick = true;
    requestAnimationFrame(() => { spyTick = false; spy(); });
  }, { passive: true });

  function renderBar() {
    const n = cartCount();
    const showCart = n > 0 && view === 'menu' && menu && menu.settings.acceptingOrders;
    $('#cartbar').hidden = !showCart;
    $('#openCart').innerHTML = `<span><span class="cnt">${bn(n)}</span>অর্ডার দেখুন</span><span>${taka(cartTotal())}</span>`;
    const b = $('#orderBanner');
    const live = activeOrder && tracked && !['served', 'cancelled'].includes(tracked.status);
    b.hidden = !(live && view === 'menu');
    b.classList.toggle('alone', !showCart);
    if (live) b.textContent = `অর্ডার #${bn(activeOrder.code)} · ${(STEPS.find((s) => s[0] === tracked.status) || [0, ''])[1]} · দেখুন`;
  }

  /* ---------- কার্ট শিট ও অর্ডার ---------- */
  function openSheet(v) {
    view = v;
    $('#sheet').hidden = false;
    document.body.classList.add('lock');
    $('#sheet').scrollTop = 0;
    renderBar();
  }
  function closeSheet() {
    readDrafts();
    view = 'menu';
    $('#sheet').hidden = true;
    document.body.classList.remove('lock');
    renderBar();
  }
  function readDrafts() {
    const t = $('#table'); const n = $('#note');
    if (t) draftTable = t.value;
    if (n) draftNote = n.value;
  }

  function renderCart() {
    const lines = cartLines();
    if (!lines.length) { $('#sheetBody').innerHTML = `<button type="button" class="back" data-act="close">← মেনুতে ফিরুন</button><h2 id="sheetTitle">কার্ট ফাঁকা</h2><p class="hint">মেনু থেকে খাবার যোগ করুন।</p>`; return; }
    $('#sheetBody').innerHTML = `
      <button type="button" class="back" data-act="close">← মেনুতে ফিরুন</button>
      <h2 id="sheetTitle">আপনার অর্ডার</h2>
      ${lines.map((l) => `
        <div class="line">
          <div class="nm">${esc(l.item.name)}<div class="each">${taka(l.item.price)} প্রতিটি</div></div>
          <div class="stepper"><button type="button" data-act="dec" data-id="${l.item.id}" aria-label="কমান">−</button><span>${bn(l.qty)}</span><button type="button" data-act="inc" data-id="${l.item.id}" aria-label="বাড়ান">+</button></div>
          <div class="amt">${taka(l.qty * l.item.price)}</div>
        </div>`).join('')}
      <div class="total"><span>মোট</span><span class="num">${taka(cartTotal())}</span></div>
      <div class="field">
        <label for="table">আপনার টেবিল নম্বর</label>
        <input id="table" class="table-input" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="৫" value="${esc(draftTable)}">
        <span class="hint">টেবিলের গায়ে লেখা নম্বরটি দিন।</span>
      </div>
      <div class="field">
        <label for="note">রান্নার নির্দেশ (ঐচ্ছিক)</label>
        <textarea id="note" rows="2" maxlength="200" placeholder="যেমন: ঝাল কম">${esc(draftNote)}</textarea>
      </div>
      ${sendError ? `<div class="err" role="alert">${esc(sendError)}</div>` : ''}
      <button type="button" class="btn btn-accent btn-block confirm" data-act="confirm" ${sending ? 'disabled' : ''}>${sending ? 'পাঠানো হচ্ছে…' : 'অর্ডার নিশ্চিত করুন'}</button>`;
  }

  async function confirmOrder() {
    readDrafts();
    const t = toLatin(draftTable.trim());
    if (!t) { sendError = 'টেবিল নম্বর লিখুন।'; renderCart(); $('#table').focus(); return; }
    if (!/^[0-9A-Za-zঀ-৿ -]{1,10}$/.test(t)) { sendError = 'টেবিল নম্বরে শুধু সংখ্যা বা অক্ষর দিন।'; renderCart(); return; }
    const items = cartLines().map((l) => ({ id: l.item.id, qty: l.qty }));
    if (!items.length) return;
    sending = true; sendError = ''; renderCart();
    try {
      const o = await getJson('/api/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: t, note: draftNote.trim(), items }),
      });
      table = t; store.set('rg_table', t);
      activeOrder = { id: o.id, code: o.code, table: t };
      store.set('rg_order', activeOrder);
      tracked = { status: o.status, items: items.map((i) => ({ name: byId(i.id).name, qty: i.qty, price: byId(i.id).price })), total: o.total, code: o.code, table: t };
      cart = {}; store.set('rg_cart', cart); draftNote = '';
      sending = false;
      renderHead(); renderMenu();
      renderTrack(); openSheet('track');
      schedulePoll();
    } catch (e) {
      sending = false;
      sendError = e.message || 'অর্ডার পাঠানো যায়নি। ইন্টারনেট দেখে আবার চেষ্টা করুন।';
      if (e.status === 409 || e.status === 400) await loadMenu(true);
      renderCart();
    }
  }

  /* ---------- অর্ডারের অবস্থা ---------- */
  function renderTrack() {
    const o = tracked;
    if (!o) return;
    const idx = STEPS.findIndex((s) => s[0] === o.status);
    $('#sheetBody').innerHTML = `
      <button type="button" class="back" data-act="close">← মেনুতে ফিরুন</button>
      <div class="track">
        <div class="sub">আপনার অর্ডার নম্বর</div>
        <div class="code">${bn(o.code)}</div>
        <h2 id="sheetTitle">টেবিল ${esc(bn(o.table))}</h2>
        ${o.status === 'cancelled'
          ? '<div class="cancelled">অর্ডারটি বাতিল হয়েছে। অনুগ্রহ করে স্টাফের সঙ্গে কথা বলুন।</div>'
          : `<ul class="steps">${STEPS.map((s, i) => `<li class="${i < idx || o.status === 'served' ? 'done' : i === idx ? 'now' : ''}">${s[1]}</li>`).join('')}</ul>`}
        <div class="summary"><ul>${o.items.map((i) => `<li><span>${bn(i.qty)} × ${esc(i.name)}</span><span class="num">${taka(i.qty * i.price)}</span></li>`).join('')}
          <li><strong>মোট</strong><strong class="num">${taka(o.total)}</strong></li></ul></div>
        <button type="button" class="btn btn-brand btn-block" data-act="close" style="max-width:340px;margin-top:10px">আরও অর্ডার করুন</button>
      </div>`;
  }

  let pollTimer = 0;
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!activeOrder || (tracked && ['served', 'cancelled'].includes(tracked.status))) return;
    pollTimer = setTimeout(pollOrder, view === 'track' ? 5000 : 15000);
  }
  async function pollOrder() {
    if (!activeOrder) return;
    try {
      tracked = await getJson('/api/orders/' + activeOrder.id);
      if (view === 'track') renderTrack();
      renderBar();
    } catch (e) {
      if (e.status === 404) { activeOrder = null; tracked = null; store.set('rg_order', null); renderBar(); return; }
    }
    schedulePoll();
  }

  /* ---------- মেনু আনা ---------- */
  async function loadMenu(quiet) {
    try {
      menu = await getJson('/api/menu');
      pruneCart();
      renderHead(); renderMenu(); renderBar();
      if (view === 'cart') { readDrafts(); renderCart(); }
    } catch (e) {
      if (!menu) $('#menu').innerHTML = '<p class="state">মেনু আনা যায়নি। ইন্টারনেট দেখে পাতাটি আবার খুলুন।</p>';
      else if (!quiet) toast('মেনু নতুন করে আনা যায়নি', true);
    }
  }

  /* ---------- ঘটনা ---------- */
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'inc') return change(b.dataset.id, 1);
    if (act === 'dec') return change(b.dataset.id, -1);
    if (act === 'close') return closeSheet();
    if (act === 'confirm') return confirmOrder();
    if (b.classList.contains('chip')) {
      const el = document.getElementById('cat-' + b.dataset.cat);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return undefined;
    }
    if (b.id === 'openCart') { renderCart(); openSheet('cart'); return undefined; }
    if (b.id === 'orderBanner') { renderTrack(); openSheet('track'); schedulePoll(); return undefined; }
    return undefined;
  });
  $('#search').addEventListener('input', (e) => { query = e.target.value; renderMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view !== 'menu') closeSheet(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadMenu(true); if (activeOrder) pollOrder(); } });
  setInterval(() => { if (!document.hidden && view === 'menu') loadMenu(true); }, 60000);

  loadMenu().then(() => { if (activeOrder) pollOrder(); });
})();
