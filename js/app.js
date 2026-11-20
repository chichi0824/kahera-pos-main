/**
 * Kahera POS — app.js
 * UI controller. Reads money math from KaheraMoney, persistence from
 * KaheraStore and starter data from KAHERA_SAMPLE. One IIFE, no globals.
 *
 * Flow: tap tile → cart line → (optional Senior/PWD) → Charge → payment →
 * Complete sale → order saved + slip shown → next order number.
 */
(function () {
  'use strict';

  var M = window.KaheraMoney;
  var store = window.KaheraStore;
  var cloud = window.KaheraCloud;
  var SAMPLE = window.KAHERA_SAMPLE;
  var root = document.getElementById('kahera');
  if (!root || !M || !store || !SAMPLE) return;

  // ---------- helpers ----------
  function $(k) { return root.querySelector('[data-k="' + k + '"]'); }
  function byId(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function pad(n) { return String(n).padStart(4, '0'); }
  function timeOf(ts) { return new Date(ts).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }); }
  var CAT_COLORS = ['#c2410c', '#136a48', '#7c3aed', '#0369a1', '#a16207', '#be185d'];
  var METHOD_LABEL = { cash: 'Cash', ewallet: 'E-wallet', card: 'Card' };

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  // ---------- state ----------
  var S = {};
  function blankCart() {
    return { type: 'dine', table: '', lines: [] };
  }
  function load() {
    // Only the active cart and display preferences stay on this device.
    // Legacy browser orders are left untouched as a local backup; the POS now reads shared orders from D1.
    store.remove('menu'); store.remove('settings');
    S.settings = clone(SAMPLE.settings);
    S.categories = clone(SAMPLE.categories);
    S.menu = clone(SAMPLE.menu);
    S.isAdmin = false;
    S.orders = [];
    S.seq = 0;
    S.nextNo = 'K-0001';
    S.shift = null;
    S.pendingOrder = null;
    S.cart = store.get('cart', null) || blankCart();
    if (!Array.isArray(S.cart.lines)) S.cart.lines = [];
    S.cart.lines.forEach(function (line) {
      line.portion = line.portion === 'half' ? 'half' : 'full';
      line.fullPrice = line.fullPrice || (line.portion === 'full' ? line.price : line.price * 2);
      line.halfPrice = line.halfPrice || null;
    });
    S.view = store.get('view', 'register');
    S.cat = 'all'; S.q = ''; S.paying = false; S.method = 'cash';
  }
  function saveCart() { store.set('cart', S.cart); }
  function totals() {
    return M.computeTotals(S.cart.lines, { vatRegistered: S.settings.vatRegistered });
  }
  function nextNo() { return S.nextNo || 'K-0001'; }

  // ---------- views ----------
  function setView(v) {
    if (v === 'menu' && !S.isAdmin) { v = 'register'; toast('Administrator login is required to manage the menu.'); }
    S.view = v; store.set('view', v);
    root.querySelectorAll('[data-view]').forEach(function (b) {
      var on = b.getAttribute('data-view') === v;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    root.querySelectorAll('.view').forEach(function (sec) { sec.hidden = sec.id !== 'view-' + v; });
    if (v === 'orders') renderOrders();
    if (v === 'shift') renderShift();
    if (v === 'menu') renderMenuAdmin();
    renderMobileBar();
  }

  function catColor(catId) {
    var i = S.categories.map(function (c) { return c.id; }).indexOf(catId);
    return CAT_COLORS[(i < 0 ? 0 : i) % CAT_COLORS.length];
  }

  function renderCats() {
    var html = '<button type="button" class="chip" data-cat="all" aria-pressed="' + (S.cat === 'all') + '">All</button>';
    S.categories.forEach(function (c) {
      html += '<button type="button" class="chip" data-cat="' + esc(c.id) + '" aria-pressed="' + (S.cat === c.id) + '">' + esc(c.name) + '</button>';
    });
    $('cats').innerHTML = html;
  }

  function qtyInCart(id) {
    var l = S.cart.lines.filter(function (x) { return x.id === id; })[0];
    return l ? l.qty : 0;
  }

  function renderGrid(bumpId) {
    var q = S.q.trim().toLowerCase();
    var items = S.menu.filter(function (m) {
      return (S.cat === 'all' || m.cat === S.cat) && (!q || m.name.toLowerCase().indexOf(q) !== -1);
    });
    if (!items.length) {
      $('grid').innerHTML = '<p class="empty">No menu items match “' + esc(S.q) + '”. Add one in the Menu tab.</p>';
      return;
    }
    $('grid').innerHTML = items.map(function (m) {
      var n = qtyInCart(m.id);
      return '<button type="button" class="tile' + (m.id === bumpId ? ' bump' : '') + '" data-add="' + esc(m.id) + '"' +
        (m.available ? '' : ' aria-disabled="true"') + ' style="--c:' + catColor(m.cat) + '"' +
        ' aria-label="Add ' + esc(m.name) + ', ' + M.peso(m.price) + (n ? ', ' + n + ' in order' : '') + (m.available ? '' : ', sold out') + '">' +
        '<span class="t-cat" aria-hidden="true"></span>' +
        '<span class="t-name">' + esc(m.name) + '</span>' +
        '<span class="t-price">' + M.peso(m.price) + '</span>' +
        (n ? '<span class="t-qty" aria-hidden="true">' + n + '</span>' : '') +
        '</button>';
    }).join('');
  }

  function renderCart() {
    var c = S.cart;
    $('orderNo').textContent = nextNo();
    $('otype').querySelectorAll('[data-v]').forEach(function (b) { b.setAttribute('aria-checked', String(b.getAttribute('data-v') === c.type)); });
    $('tableWrap').hidden = c.type !== 'dine';
    if (document.activeElement !== byId('k-table')) byId('k-table').value = c.table;

    if (!c.lines.length) {
      $('lines').innerHTML = '<li class="empty">Tap a menu item to start an order.</li>';
    } else {
      $('lines').innerHTML = c.lines.map(function (l, i) {
        var portionControl = l.halfPrice
          ? '<label class="portion-wrap"><span class="sr-only">Portion</span><select class="portion-select" data-portion="' + i + '" aria-label="Portion for ' + esc(l.name) + '">' +
            '<option value="full"' + (l.portion === 'full' ? ' selected' : '') + '>Full</option>' +
            '<option value="half"' + (l.portion === 'half' ? ' selected' : '') + '>Half</option></select></label>'
          : '<span class="portion-label">Full</span>';
        return '<li class="line">' +
          '<span class="l-name">' + esc(l.name) + portionControl + '<span class="l-each">' + M.peso(l.price) + ' each</span></span>' +
          '<span class="stepper"><button type="button" data-line="' + i + '" data-d="-1" aria-label="Remove one ' + esc(l.name) + '">−</button>' +
          '<span aria-label="Quantity">' + l.qty + '</span>' +
          '<button type="button" data-line="' + i + '" data-d="1" aria-label="Add one ' + esc(l.name) + '">+</button></span>' +
          '<span class="l-amt">' + M.peso(l.price * l.qty, { symbol: false }) + '</span>' +
          '</li>';
      }).join('');
    }

    renderTotals();
    renderMobileBar();
  }

  function row(label, value, cls) {
    return '<dt class="' + (cls || '') + '">' + label + '</dt><dd class="' + (cls || '') + '">' + value + '</dd>';
  }

  function renderTotals() {
    var t = totals(), h = '';
    h += row('Subtotal · ' + t.items + (t.items === 1 ? ' item' : ' items'), M.peso(t.gross, { symbol: false }));
    if (t.discountKind !== 'none') {
      h += row(DISC_LABEL[t.discountKind] + ' share (' + t.idHolders + ' of ' + t.diners + ')', M.peso(t.share, { symbol: false }), 'small');
      if (t.vatRemoved) h += row('Less 12% VAT (exempt)', M.peso(-t.vatRemoved, { symbol: false }), 'less');
      h += row('Less 20% ' + DISC_LABEL[t.discountKind] + ' discount', M.peso(-t.discount, { symbol: false }), 'less');
    }
    if (t.vatRegistered) {
      h += row('VATable sales', M.peso(t.vatable, { symbol: false }), 'small');
      h += row('VAT 12%', M.peso(t.vat, { symbol: false }), 'small');
      if (t.vatExemptSales) h += row('VAT-exempt sales', M.peso(t.vatExemptSales, { symbol: false }), 'small');
    } else {
      h += row('Non-VAT seller', '—', 'small');
    }
    h += row('Total due', M.peso(t.total), 'due');
    $('totals').innerHTML = h;
    var charge = $('charge');
    charge.textContent = 'Charge ' + M.peso(t.total);
    charge.disabled = !S.cart.lines.length;
    if (S.paying) renderPay();
  }

  function renderMobileBar() {
    var bar = $('mbar');
    var t = totals();
    bar.hidden = !(S.view === 'register' && S.cart.lines.length);
    $('mItems').textContent = 'Order ' + nextNo() + ' · ' + t.items + (t.items === 1 ? ' item' : ' items');
    $('mTotal').textContent = M.peso(t.total);
  }

  // ---------- payment ----------
  function openPay(open) {
    S.paying = open;
    $('pay').hidden = !open;
    $('cartActions').hidden = open;
    if (open) {
      byId('k-tendered').value = '';
      byId('k-ref').value = '';
      $('payErr').textContent = '';
      renderPay();
      setTimeout(function () { (S.method === 'cash' ? byId('k-tendered') : byId('k-ref')).focus(); }, 30);
    }
  }

  function renderPay() {
    var t = totals();
    $('method').querySelectorAll('[data-v]').forEach(function (b) { b.setAttribute('aria-checked', String(b.getAttribute('data-v') === S.method)); });
    $('cashBox').hidden = S.method !== 'cash';
    $('refBox').hidden = S.method === 'cash';
    $('quick').innerHTML = M.quickCash(t.total).map(function (v, i) {
      return '<button type="button" data-cash="' + v + '">' + (i === 0 ? 'Exact ' : '') + M.peso(v) + '</button>';
    }).join('');
    var tendered = M.toCentavos(byId('k-tendered').value);
    var ch = M.change(t.total, isNaN(tendered) ? 0 : tendered);
    var box = $('change');
    box.classList.toggle('short', !ch.ok);
    box.innerHTML = ch.ok ? '<span>Change</span><b>' + M.peso(ch.change) + '</b>'
                          : '<span>Still needed</span><b>' + M.peso(ch.short) + '</b>';
    $('complete').textContent = 'Complete sale · ' + M.peso(t.total);
  }

  function completeSale() {
    var t = totals(), err = $('payErr');
    if (!S.cart.lines.length || S.savingSale) return;
    var tendered = t.total, ref = '';
    if (S.method === 'cash') {
      tendered = M.toCentavos(byId('k-tendered').value);
      if (isNaN(tendered)) { err.textContent = 'Enter the cash received, for example 500 or 1,000.00.'; byId('k-tendered').focus(); return; }
      if (tendered < t.total) { err.textContent = 'Cash received is ' + M.peso(t.total - tendered) + ' short of the total.'; byId('k-tendered').focus(); return; }
    } else {
      ref = byId('k-ref').value.trim();
      if (ref.length < 4) { err.textContent = 'Type the reference number from the customer\'s payment confirmation.'; byId('k-ref').focus(); return; }
    }
    var orderSnapshot = {
      type: S.cart.type, table: S.cart.type === 'dine' ? S.cart.table : '',
      lines: clone(S.cart.lines), totals: t, method: S.method, tendered: tendered, ref: ref
    };
    var fingerprint = JSON.stringify(orderSnapshot);
    if (!S.pendingOrder || S.pendingOrder.fingerprint !== fingerprint) {
      S.pendingOrder = Object.assign({ id: cloud.newId(), fingerprint: fingerprint }, orderSnapshot);
    }
    S.savingSale = true;
    $('complete').disabled = true;
    err.textContent = 'Saving sale…';
    cloud.createOrder(S.pendingOrder).then(function (order) {
      S.orders.push(order);
      S.nextNo = 'K-' + pad((parseInt(String(order.no).replace('K-', ''), 10) || 0) + 1);
      S.pendingOrder = null;
      S.cart = blankCart(); saveCart();
      openPay(false); S.method = 'cash';
      renderAll(); showSlip(order);
      refreshSharedData();
    }).catch(function (error) {
      err.textContent = 'Sale was not saved. Your cart is safe. ' + error.message;
    }).finally(function () {
      S.savingSale = false;
      $('complete').disabled = false;
    });
  }

  function showSlip(o) {
    var t = o.totals, h = '';
    h += '<h3>' + esc(S.settings.bizName) + '</h3>';
    h += '<p class="center">' + esc(S.settings.bizNote) + '</p>';
    h += '<p class="stamp">Order slip · not an official receipt</p>';
    h += '<div class="row"><span>' + esc(o.no) + '</span><span>' + new Date(o.ts).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</span></div>';
    h += '<div class="row"><span>' + (o.type === 'dine' ? 'Dine-in' + (o.table ? ' · Table ' + esc(o.table) : '') : 'Take-out') + '</span><span>' + METHOD_LABEL[o.method] + '</span></div><hr>';
    o.lines.forEach(function (l) {
      h += '<div class="row"><span>' + l.qty + ' × ' + (l.portion === 'half' ? 'Half ' : '') + esc(l.name) + '</span><span>' + M.peso(l.price * l.qty, { symbol: false }) + '</span></div>';
    });
    h += '<hr><div class="row"><span>Subtotal</span><span>' + M.peso(t.gross, { symbol: false }) + '</span></div>';
    if (t.discountKind !== 'none') {
      if (t.vatRemoved) h += '<div class="row"><span>Less VAT (' + DISC_LABEL[t.discountKind] + ')</span><span>' + M.peso(-t.vatRemoved, { symbol: false }) + '</span></div>';
      h += '<div class="row"><span>Less 20% ' + DISC_LABEL[t.discountKind] + '</span><span>' + M.peso(-t.discount, { symbol: false }) + '</span></div>';
    }
    h += '<div class="row big"><span>TOTAL</span><span>' + M.peso(t.total) + '</span></div>';
    if (o.method === 'cash') {
      h += '<div class="row"><span>Cash</span><span>' + M.peso(o.tendered, { symbol: false }) + '</span></div>';
      h += '<div class="row big"><span>Change</span><span>' + M.peso(o.change) + '</span></div>';
    } else {
      h += '<div class="row"><span>Ref.</span><span>' + esc(o.ref) + '</span></div>';
    }
    if (o.status === 'void') h += '<p class="stamp">Voided</p>';
    h += '<hr><p class="center">Salamat! Balik po kayo.</p>';
    $('slip').innerHTML = h;
    var dlg = $('slipDlg');
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else { dlg.setAttribute('open', ''); }
    $('slipClose').focus();
  }

  // ---------- orders ----------
  var pendingVoid = null;
  function renderOrders() {
    var list = S.orders.slice().reverse();
    var paid = list.filter(function (o) { return o.status !== 'void'; }).length;
    $('ordersNote').textContent = list.length ? paid + ' paid · ' + (list.length - paid) + ' voided' + (list.some(function (o) { return o.sample; }) ? ' · includes sample orders' : '') : '';
    if (!list.length) {
      $('ordersTable').innerHTML = '<tbody><tr><td class="empty">No orders yet this shift. Completed sales appear here.</td></tr></tbody>';
      return;
    }
    var h = '<thead><tr><th>Order</th><th>Time</th><th class="hide-sm">Type</th><th class="hide-sm">Items</th><th class="hide-sm">Paid by</th><th class="num">Total</th><th class="num"><span class="sr-only">Actions</span></th></tr></thead><tbody>';
    list.forEach(function (o) {
      var isVoid = o.status === 'void';
      h += '<tr class="' + (isVoid ? 'is-void' : '') + '">' +
        '<td class="mono">' + esc(o.no) + (isVoid ? ' <span class="pill void">Void</span>' : '') +
          '</td>' +
        '<td class="mono">' + timeOf(o.ts) + '</td>' +
        '<td class="hide-sm">' + (o.type === 'dine' ? 'Dine-in' + (o.table ? ' · T' + esc(o.table) : '') : 'Take-out') + '</td>' +
        '<td class="hide-sm">' + o.lines.map(function (l) { return l.qty + '× ' + (l.portion === 'half' ? 'Half ' : '') + esc(l.name); }).join(', ') + '</td>' +
        '<td class="hide-sm">' + METHOD_LABEL[o.method] + '</td>' +
        '<td class="num mono">' + M.peso(o.totals.total) + '</td>' +
        '<td class="num"><div class="row-actions">' +
          '<button type="button" class="btn small" data-slip="' + esc(o.no) + '">Slip</button>' +
          (isVoid ? '' : pendingVoid === o.no
            ? '<span class="confirm">Void ' + esc(o.no) + '? <button type="button" class="btn small danger" data-void-yes="' + esc(o.no) + '">Void</button><button type="button" class="btn small" data-void-no>Keep</button></span>'
            : '<button type="button" class="btn small danger" data-void="' + esc(o.no) + '">Void</button>') +
        '</div></td></tr>';
    });
    $('ordersTable').innerHTML = h + '</tbody>';
  }
  function findOrder(no) { return S.orders.filter(function (o) { return o.no === no; })[0]; }

  // ---------- shift ----------
  var pendingShift = false;
  function renderShift() {
    var s = M.summarize(S.orders);
    $('kpis').innerHTML = [
      ['Net sales', M.peso(s.net), s.count + ' paid orders'],
      ['Average ticket', M.peso(s.avgTicket), 'per paid order'],
      ['Items sold', String(s.topItems.reduce(function (n, item) { return n + item.qty; }, 0)), 'total quantity'],
      ['Voided', String(s.voided), s.voided === 1 ? 'order' : 'orders']
    ].map(function (k) {
      return '<div class="panel kpi"><span class="eyebrow">' + k[0] + '</span><b>' + k[1] + '</b><small>' + k[2] + '</small></div>';
    }).join('');

    // Hourly bars: from the first to the last hour with sales (at least 6 columns).
    var hours = Object.keys(s.byHour).map(Number);
    var lo = hours.length ? Math.min.apply(null, hours) : 7;
    var hi = hours.length ? Math.max.apply(null, hours) : 12;
    while (hi - lo < 5) { if (lo > 0) lo--; if (hi - lo < 5 && hi < 23) hi++; }
    var max = 0, h, bars = '', labels = '';
    for (h = lo; h <= hi; h++) max = Math.max(max, s.byHour[h] || 0);
    for (h = lo; h <= hi; h++) {
      var v = s.byHour[h] || 0, pct = max ? Math.round(v / max * 100) : 0;
      var lab = (h % 12 || 12) + (h < 12 ? 'a' : 'p');
      bars += '<div class="bar' + (v ? '' : ' zero') + '" style="height:' + Math.max(pct, 1) + '%" title="' + lab + ': ' + M.peso(v) + '">' +
        (v ? '<span>' + (v >= 100000 ? '₱' + (v / 100000).toFixed(1) + 'k' : '₱' + Math.round(v / 100)) + '</span>' : '') + '</div>';
      labels += '<span>' + lab + '</span>';
    }
    $('bars').innerHTML = bars;
    $('barLabels').innerHTML = labels;

    $('split').innerHTML = ['cash', 'ewallet', 'card'].map(function (m) {
      var v = s.byMethod[m] || 0, pct = s.net ? Math.round(v / s.net * 100) : 0;
      return '<div class="split-row"><span>' + METHOD_LABEL[m] + '</span><span class="split-track"><span class="split-fill" style="width:' + pct + '%;display:block"></span></span><b>' + M.peso(v) + ' · ' + pct + '%</b></div>';
    }).join('');

    var top = s.topItems.slice(0, 6);
    $('topItems').innerHTML = top.length
      ? '<thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Sales</th></tr></thead><tbody>' +
        top.map(function (i) { return '<tr><td>' + esc(i.name) + '</td><td class="num mono">' + i.qty + '</td><td class="num mono">' + M.peso(i.amount) + '</td></tr>'; }).join('') + '</tbody>'
      : '<tbody><tr><td class="empty">Sales will appear here after the first order.</td></tr></tbody>';

    var ns = $('newShift');
    var wrap = $('shiftActions');
    var old = wrap.querySelector('.confirm');
    if (old) old.remove();
    ns.hidden = pendingShift;
    if (pendingShift) {
      var c = document.createElement('span');
      c.className = 'confirm';
      c.innerHTML = 'Close this shared shift? Previous orders will remain saved. <button type="button" class="btn small danger" data-shift-yes>Close shift</button><button type="button" class="btn small" data-shift-no>Cancel</button>';
      wrap.appendChild(c);
    }
  }

  function copyText(text, okMsg) {
    var done = function () { toast(okMsg); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? okMsg : 'Copy is blocked here. Use Download CSV instead.');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    } catch (e) { fallback(); }
  }

  function downloadCsv() {
    var csv = M.toCSV(S.orders);
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    var d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = 'kahera-shift-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('CSV saved. If nothing downloaded, use Copy CSV.');
  }

  // ---------- menu admin ----------
  function renderMenuAdmin() {
    byId('k-biz').value = S.settings.bizName;
    byId('k-biznote').value = S.settings.bizNote;
    byId('k-vat').checked = !!S.settings.vatRegistered;
    var catOpts = function (sel) {
      return S.categories.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('');
    };
    $('newCat').innerHTML = catOpts(S.categories[0].id);
    var h = '<thead><tr><th>Item</th><th class="hide-sm">Category</th><th class="num">Full ₱</th><th class="num">Half ₱</th><th>On sale</th><th class="num"><span class="sr-only">Delete</span></th></tr></thead><tbody>';
    S.menu.forEach(function (m) {
      h += '<tr data-item="' + esc(m.id) + '">' +
        '<td><input aria-label="Name" data-f="name" value="' + esc(m.name) + '" maxlength="40"></td>' +
        '<td class="hide-sm"><select aria-label="Category" data-f="cat">' + catOpts(m.cat) + '</select></td>' +
        '<td class="num price"><input aria-label="Full order price in pesos" data-f="price" inputmode="decimal" value="' + (m.price / 100).toFixed(2) + '"></td>' +
        '<td class="num price"><input aria-label="Half order price in pesos" data-f="halfPrice" inputmode="decimal" placeholder="Optional" value="' + (m.halfPrice ? (m.halfPrice / 100).toFixed(2) : '') + '"></td>' +
        '<td><label class="check"><input type="checkbox" data-f="available"' + (m.available ? ' checked' : '') + '><span class="sr-only">Available</span></label></td>' +
        '<td class="num"><button type="button" class="btn small ghost" data-del="' + esc(m.id) + '" aria-label="Delete ' + esc(m.name) + '">✕</button></td>' +
        '</tr>';
    });
    $('menuTable').innerHTML = h + '</tbody>';
  }
  var menuSaveChain = Promise.resolve();
  function saveMenu() {
    var payload = { settings: clone(S.settings), categories: clone(S.categories), menu: clone(S.menu) };
    menuSaveChain = menuSaveChain.catch(function () {}).then(function () { return cloud.saveMenu(payload); });
    return menuSaveChain.then(function () {
      renderGrid();
      toast('Menu saved to the shared database. Cashiers will see it shortly.');
    }).catch(function (err) {
      toast('Menu was not saved: ' + err.message);
      renderMenuAdmin(); renderGrid();
    });
  }

  function renderBrand() {
    $('biz').textContent = S.settings.bizName + ' · ' + S.settings.bizNote;
    $('orderCount').textContent = S.orders.filter(function (o) { return o.status !== 'void'; }).length;
  }

  function renderAll() {
    renderBrand(); renderCats(); renderGrid(); renderCart();
    if (S.view === 'orders') renderOrders();
    if (S.view === 'shift') renderShift();
  }

  // ---------- cart mutations ----------
  function addItem(id) {
    var m = S.menu.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    if (!m.available) { toast(m.name + ' is marked sold out'); return; }
    var l = S.cart.lines.filter(function (x) { return x.id === id && x.portion === 'full'; })[0];
    if (l) l.qty = Math.min(99, l.qty + 1);
    else S.cart.lines.push({ id: m.id, name: m.name, price: m.price, fullPrice: m.price, halfPrice: m.halfPrice || null, portion: 'full', qty: 1 });
    saveCart(); renderCart(); renderGrid(id);
  }
  function stepLine(i, d) {
    var l = S.cart.lines[i];
    if (!l) return;
    l.qty += d;
    if (l.qty <= 0) S.cart.lines.splice(i, 1);
    saveCart(); renderCart(); renderGrid();
  }

  // ---------- events ----------
  function bind() {
    $('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-view]');
      if (b) setView(b.getAttribute('data-view'));
    });
    $('tabs').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var tabs = Array.prototype.slice.call($('tabs').querySelectorAll('[data-view]'));
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      n.focus(); setView(n.getAttribute('data-view'));
    });

    $('cats').addEventListener('click', function (e) {
      var b = e.target.closest('[data-cat]');
      if (!b) return;
      S.cat = b.getAttribute('data-cat'); renderCats(); renderGrid();
    });
    byId('k-search').addEventListener('input', function (e) { S.q = e.target.value; renderGrid(); });
    byId('k-search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var first = $('grid').querySelector('[data-add]:not([aria-disabled])');
        if (first) { addItem(first.getAttribute('data-add')); e.target.select(); }
      }
    });
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (e.key === '/' && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
        if (S.view !== 'register') setView('register');
        e.preventDefault(); byId('k-search').focus();
      }
    });
    $('grid').addEventListener('click', function (e) {
      var b = e.target.closest('[data-add]');
      if (b) addItem(b.getAttribute('data-add'));
    });

    $('otype').addEventListener('click', function (e) {
      var b = e.target.closest('[data-v]');
      if (!b) return;
      S.cart.type = b.getAttribute('data-v'); saveCart(); renderCart();
    });
    byId('k-table').addEventListener('input', function (e) {
      S.cart.table = e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 3); saveCart();
    });
    $('lines').addEventListener('click', function (e) {
      var b = e.target.closest('[data-line]');
      if (b) stepLine(+b.getAttribute('data-line'), +b.getAttribute('data-d'));
    });
    $('lines').addEventListener('change', function (e) {
      var sel = e.target.closest('[data-portion]');
      if (!sel) return;
      var line = S.cart.lines[+sel.getAttribute('data-portion')];
      if (!line || !line.halfPrice) return;
      line.portion = sel.value === 'half' ? 'half' : 'full';
      line.price = line.portion === 'half' ? line.halfPrice : line.fullPrice;
      saveCart(); renderCart();
    });

    $('clear').addEventListener('click', function () {
      if (!S.cart.lines.length) return;
      S.cart = blankCart(); saveCart(); renderCart(); renderGrid();
      toast('Order cleared');
    });
    $('charge').addEventListener('click', function () { if (S.cart.lines.length) openPay(true); });
    $('back').addEventListener('click', function () { openPay(false); $('charge').focus(); });
    $('method').addEventListener('click', function (e) {
      var b = e.target.closest('[data-v]');
      if (!b) return;
      S.method = b.getAttribute('data-v'); $('payErr').textContent = ''; renderPay();
    });
    $('quick').addEventListener('click', function (e) {
      var b = e.target.closest('[data-cash]');
      if (!b) return;
      byId('k-tendered').value = (+b.getAttribute('data-cash') / 100).toFixed(2);
      $('payErr').textContent = ''; renderPay();
    });
    byId('k-tendered').addEventListener('input', function () { $('payErr').textContent = ''; renderPay(); });
    byId('k-tendered').addEventListener('keydown', function (e) { if (e.key === 'Enter') completeSale(); });
    byId('k-ref').addEventListener('keydown', function (e) { if (e.key === 'Enter') completeSale(); });
    $('complete').addEventListener('click', completeSale);

    $('slipClose').addEventListener('click', function () {
      var dlg = $('slipDlg');
      if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
    });
    $('slipDlg').addEventListener('close', function () { if (S.view === 'register') byId('k-search').focus(); });

    $('mGo').addEventListener('click', function (e) {
      e.preventDefault();
      byId('k-order').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('ordersTable').addEventListener('click', function (e) {
      var t = e.target.closest('button');
      if (!t) return;
      if (t.hasAttribute('data-slip')) showSlip(findOrder(t.getAttribute('data-slip')));
      if (t.hasAttribute('data-void')) { pendingVoid = t.getAttribute('data-void'); renderOrders(); }
      if (t.hasAttribute('data-void-no')) { pendingVoid = null; renderOrders(); }
      if (t.hasAttribute('data-void-yes')) {
        var o = findOrder(t.getAttribute('data-void-yes'));
        if (o) { cloud.voidOrder(o.id).then(function (updated) { S.orders = S.orders.map(function (x) { return x.id === updated.id ? updated : x; }); renderOrders(); renderShift(); renderBrand(); toast(updated.no + ' voided'); }).catch(function (error) { toast('Could not void order: ' + error.message); }); }
        pendingVoid = null; renderOrders();
      }
    });

    $('copyCsv').addEventListener('click', function () { copyText(M.toCSV(S.orders), 'CSV copied. Paste it into a spreadsheet.'); });
    $('dlCsv').addEventListener('click', downloadCsv);
    $('newShift').addEventListener('click', function () { pendingShift = true; renderShift(); });
    $('shiftActions').addEventListener('click', function (e) {
      if (e.target.closest('[data-shift-no]')) { pendingShift = false; renderShift(); }
      if (e.target.closest('[data-shift-yes]')) {
        pendingShift = false;
        cloud.closeShift(S.shift && S.shift.id).then(function () { return cloud.startShift(cloud.getDeviceId()); }).then(function (shift) { S.shift = shift; return refreshSharedData(); }).then(function () { toast('New shared shift started. Previous orders remain in history.'); }).catch(function (error) { toast('Could not start a new shift: ' + error.message); });
      }
    });

    $('settingsForm').addEventListener('submit', function (e) { e.preventDefault(); });
    $('settingsForm').addEventListener('change', function () {
      S.settings.bizName = byId('k-biz').value.trim() || 'My Store';
      S.settings.bizNote = byId('k-biznote').value.trim();
      S.settings.vatRegistered = byId('k-vat').checked;
      renderBrand(); renderTotals(); saveMenu();
    });
    $('menuTable').addEventListener('change', function (e) {
      var f = e.target.getAttribute('data-f');
      var tr = e.target.closest('[data-item]');
      if (!f || !tr) return;
      var m = S.menu.filter(function (x) { return x.id === tr.getAttribute('data-item'); })[0];
      if (!m) return;
      if (f === 'name') { var n = e.target.value.trim(); if (n) m.name = n; else e.target.value = m.name; }
      if (f === 'cat') m.cat = e.target.value;
      if (f === 'available') m.available = e.target.checked;
      if (f === 'price') {
        var c = M.toCentavos(e.target.value);
        if (isNaN(c) || c <= 0) { toast('Enter a price like 65 or 65.50'); e.target.value = (m.price / 100).toFixed(2); return; }
        m.price = c; e.target.value = (c / 100).toFixed(2);
        if (m.halfPrice && m.halfPrice > m.price) { m.halfPrice = null; toast('Half-order price cleared because it cannot exceed the full price.'); }
      }
      if (f === 'halfPrice') {
        var hp = e.target.value.trim() === '' ? null : M.toCentavos(e.target.value);
        if (hp !== null && (isNaN(hp) || hp <= 0 || hp > m.price)) { toast('Half-order price must be greater than zero and no more than the full price.'); e.target.value = m.halfPrice ? (m.halfPrice / 100).toFixed(2) : ''; return; }
        m.halfPrice = hp;
        e.target.value = hp === null ? '' : (hp / 100).toFixed(2);
      }
      saveMenu();
    });
    $('menuTable').addEventListener('click', function (e) {
      var b = e.target.closest('[data-del]');
      if (!b) return;
      var id = b.getAttribute('data-del');
      var m = S.menu.filter(function (x) { return x.id === id; })[0];
      S.menu = S.menu.filter(function (x) { return x.id !== id; });
      saveMenu().then(function () { renderMenuAdmin(); if (m) toast('Removed ' + m.name); });
    });
    $('addForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = byId('k-newname').value.trim(), price = M.toCentavos(byId('k-newprice').value);
      var halfRaw = byId('k-newhalfprice').value.trim();
      var halfPrice = halfRaw ? M.toCentavos(halfRaw) : null;
      if (!name) { $('addErr').textContent = 'Give the item a name.'; return; }
      if (isNaN(price) || price <= 0) { $('addErr').textContent = 'Enter a full-order price in pesos, like 150 or 150.50.'; return; }
      if (halfRaw && (isNaN(halfPrice) || halfPrice <= 0 || halfPrice > price)) { $('addErr').textContent = 'Half-order price must be greater than zero and no more than the full price.'; return; }
      $('addErr').textContent = '';
      S.menu.push({ id: 'u' + Date.now().toString(36), cat: byId('k-newcat').value, name: name, price: price, halfPrice: halfPrice, available: true });
      saveMenu().then(function () { renderMenuAdmin(); });
      byId('k-newname').value = ''; byId('k-newprice').value = ''; byId('k-newhalfprice').value = '';
    });
    $('adminAccess').addEventListener('click', function () {
      if (S.isAdmin) {
        cloud.logout(); S.isAdmin = false;
        byId('tab-menu').hidden = true;
        $('adminAccess').textContent = 'Admin login';
        if (S.view === 'menu') setView('register');
        toast('Administrator logged out.');
      } else {
        byId('adminPassword').value = '';
        $('adminErr').textContent = '';
        byId('adminDlg').showModal();
        byId('adminPassword').focus();
      }
    });
    $('adminForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var button = $('adminSubmit');
      button.disabled = true; $('adminErr').textContent = 'Checking password…';
      cloud.login(byId('adminPassword').value).then(function () {
        S.isAdmin = true;
        byId('tab-menu').hidden = false;
        $('adminAccess').textContent = 'Admin logout';
        byId('adminDlg').close();
        renderMenuAdmin(); setView('menu');
        toast('Administrator access granted.');
      }).catch(function (err) {
        $('adminErr').textContent = err.message || 'Unable to sign in.';
      }).finally(function () { button.disabled = false; });
    });
    $('adminCancel').addEventListener('click', function () { byId('adminDlg').close(); });

    $('theme').addEventListener('click', function () {
      var de = document.documentElement;
      var cur = de.getAttribute('data-theme') || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = cur === 'dark' ? 'light' : 'dark';
      de.setAttribute('data-theme', next);
      store.set('theme', next);
    });
  }

  function tick() {
    $('clock').textContent = new Date().toLocaleString('en-PH', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  // ---------- boot ----------
  function startApp() {
    load();
    var savedTheme = store.get('theme', null);
    if (savedTheme === 'dark' || savedTheme === 'light') document.documentElement.setAttribute('data-theme', savedTheme);
    bind();
    byId('tab-menu').hidden = true;
    renderAll();
    setView(S.view);
    tick(); setInterval(tick, 30000);
    refreshSharedData().catch(function (error) { toast('Cloud sync unavailable: ' + error.message); });
    setInterval(function () { refreshSharedData().catch(function () {}); }, 7000);
  }

  var refreshInFlight = false;
  function refreshSharedData() {
    if (refreshInFlight) return Promise.resolve();
    refreshInFlight = true;
    return cloud.startShift(cloud.getDeviceId()).then(function (shift) {
      S.shift = shift;
      return Promise.all([cloud.getOrders(shift.id), cloud.getNextNo()]);
    }).then(function (results) {
      S.orders = results[0];
      S.nextNo = results[1];
      renderBrand();
      if (S.view === 'orders') renderOrders();
      if (S.view === 'shift') renderShift();
      renderCart();
    }).finally(function () { refreshInFlight = false; });
  }

  cloud.getMenu().then(function (remote) {
    if (!remote || !Array.isArray(remote.menu) || !Array.isArray(remote.categories) || !remote.settings) throw new Error('The shared menu response is incomplete.');
    SAMPLE.settings = remote.settings;
    SAMPLE.categories = remote.categories;
    SAMPLE.menu = remote.menu;
    startApp();
  }).catch(function (err) {
    startApp();
    toast('Using starter menu: ' + err.message);
  });
})();
