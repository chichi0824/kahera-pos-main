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
  // Kept only to display legacy historical orders created before this feature was removed.
  var DISC_LABEL = { none: '', senior: 'Senior', pwd: 'PWD' };

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
  function manilaToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
  function dateShift(dateText,days){var d=new Date(dateText+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
  function dateParts(dateText){return dateText.split('-').map(Number);}
  function dateMonth(dateText){return dateText.slice(0,7);}
  function monthBounds(monthText){var p=monthText.split('-').map(Number),last=new Date(Date.UTC(p[0],p[1],0)).getUTCDate();return{from:monthText+'-01',to:monthText+'-'+String(last).padStart(2,'0')};}
  function reportRange(){var d=S.reportDate,p=dateParts(d),from=d,to=d;if(S.reportMode==='week'){var weekday=new Date(d+'T00:00:00Z').getUTCDay(),monday=weekday===0?-6:1-weekday;from=dateShift(d,monday);to=dateShift(from,6);}else if(S.reportMode==='month'){var m=monthBounds(d.slice(0,7));from=m.from;to=m.to;}else if(S.reportMode==='year'){from=p[0]+'-01-01';to=p[0]+'-12-31';}else if(S.reportMode==='custom'){from=S.customFrom||d;to=S.customTo||d;if(from>to){var swap=from;from=to;to=swap;}}return{from:from,to:to};}
  function formatDate(dateText,opts){return new Date(dateText+'T00:00:00Z').toLocaleDateString('en-PH',Object.assign({timeZone:'UTC',month:'short',day:'numeric',year:'numeric'},opts||{}));}
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
    S.reportMode = 'day';
    S.reportDate = manilaToday();
    S.calendarMonth = S.reportDate.slice(0,7);
    S.customFrom = S.reportDate;
    S.customTo = S.reportDate;
    S.reportOrders = [];
    S.reportDays = [];
    S.pendingOrder = null;
    S.cart = store.get('cart', null) || blankCart();
    if (!Array.isArray(S.cart.lines)) S.cart.lines = [];
    S.cart.lines.forEach(function (line) {
      line.portion = line.portion === 'half' ? 'half' : 'full';
      line.fullPrice = line.fullPrice || (line.portion === 'full' ? line.price : line.price * 2);
      line.halfPrice = line.halfPrice || null;
    });
    S.view = store.get('view', 'register');
    S.cat = 'all'; S.q = ''; S.paying = false; S.method = 'cash'; S.menuAdminCat = 'all';
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
    if (v === 'shift') loadReportData();
    if (v === 'menu') renderMenuAdmin();
    renderMobileBar();
  }

  function catColor(catId) {
    var i = S.categories.map(function (c) { return c.id; }).indexOf(catId);
    return CAT_COLORS[(i < 0 ? 0 : i) % CAT_COLORS.length];
  }

  function categoryRank(c) {
    var n=String(c.name||'').toLowerCase();
    if(n==='ulam'||n==='meals')return 0;if(n==='merienda')return 1;if(n==='extra'||n==='extras')return 2;if(n==='drinks'||n==='drink')return 3;return 4;
  }
  function orderedCategories(){return S.categories.slice().sort(function(x,y){return categoryRank(x)-categoryRank(y)||x.name.localeCompare(y.name);});}
  function categoryLabel(c){return String(c.name).toLowerCase()==='extras'?'Extra':c.name;}
  function isDrinksCategory(catId){var c=S.categories.filter(function(x){return x.id===catId;})[0];return !!c&&(/^(drinks?|beverages?)$/i.test(String(c.name).trim())||/^(drinks?|beverages?)$/i.test(String(c.id).trim()));}
  function renderVariantRow(v){return '<div class="variant-edit-row" data-variant-row="'+esc(v.id)+'"><input data-vf="name" aria-label="Variant name" maxlength="30" value="'+esc(v.name||'')+'" placeholder="e.g. Bote"><input data-vf="price" aria-label="Variant price" inputmode="decimal" value="'+(v.price>0?(v.price/100).toFixed(2):'')+'" placeholder="Price"><label class="check"><input type="checkbox" data-vf="available"'+(v.available!==false?' checked':'')+'><span>Available</span></label><button type="button" class="btn small ghost" data-variant-remove="'+esc(v.id)+'" aria-label="Remove variant">✕</button></div>';}
  function renderVariantEditor(variants){return '<div class="variant-editor-list">'+(variants||[]).map(renderVariantRow).join('')+'</div><button type="button" class="btn small" data-variant-add>Add variant</button>';}
  function readVariantEditor(container){var rows=Array.prototype.slice.call(container.querySelectorAll('[data-variant-row]')),out=[],names={};for(var i=0;i<rows.length;i++){var row=rows[i],id=row.getAttribute('data-variant-row'),name=row.querySelector('[data-vf="name"]').value.trim(),price=M.toCentavos(row.querySelector('[data-vf="price"]').value),available=row.querySelector('[data-vf="available"]').checked;if(!name||name.length>30||isNaN(price)||price<1)return{incomplete:true};var key=name.toLowerCase();if(names[key])return{error:'Variant names must be unique.'};names[key]=true;out.push({id:id||'v'+Date.now().toString(36)+'-'+i,name:name,price:price,available:available});}return{variants:out};}
  function updateNewVariantControl(){var enabled=isDrinksCategory(byId('k-newcat').value),priceLabel=byId('k-newprice').closest('label'),halfLabel=byId('k-newhalfprice').closest('label'),variantBox=byId('k-newvariants'),list=variantBox.querySelector('.variant-editor-list');priceLabel.hidden=enabled;halfLabel.hidden=enabled;variantBox.hidden=!enabled;if(!enabled)list.innerHTML='';else if(!list.querySelector('[data-variant-row]'))list.innerHTML=renderVariantRow({id:'vnew-'+Date.now().toString(36),name:'',price:0,available:true});}
  function renderCats(){
    var html='<button type="button" class="chip" data-cat="all" aria-pressed="'+(S.cat==='all')+'">All</button>';
    orderedCategories().forEach(function(c){html+='<button type="button" class="chip" data-cat="'+esc(c.id)+'" aria-pressed="'+(S.cat===c.id)+'">'+esc(categoryLabel(c))+'</button>';});
    $('cats').innerHTML=html;
  }
  function renderTile(m,bumpId){
    var n=qtyInCart(m.id),photo=m.image?'<img class="tile-photo" src="'+esc(m.image)+'" alt="" loading="lazy">':'<span class="tile-photo placeholder" aria-hidden="true">🍽️</span>';
    var isDrink=isDrinksCategory(m.cat),hasOptions=isDrink&&Array.isArray(m.variants)&&m.variants.length;
    var availableVariants=hasOptions?m.variants.filter(function(v){return v.available!==false;}):[];
    var prices=hasOptions?availableVariants.map(function(v){return v.price;}):[m.price];
    var disabled=!!m.soldOut||(isDrink&&!availableVariants.length);
    var priceLabel=isDrink?(availableVariants.length?'From '+M.peso(Math.min.apply(null,prices)):'No sizes available'):M.peso(m.price);
    var statusLabel=m.soldOut?'Sold Out':(isDrink&&!availableVariants.length?'No sizes':'');
    return '<button type="button" class="tile'+(m.id===bumpId?' bump':'')+(m.image?' has-photo':'')+(disabled?' is-sold-out':'')+'" data-add="'+esc(m.id)+'"'+(disabled?' aria-disabled="true"':'')+' style="--c:'+catColor(m.cat)+'" aria-label="'+esc(m.name)+', '+priceLabel+(n?', '+n+' in order':'')+(statusLabel?', '+statusLabel.toLowerCase():'')+'">'+photo+'<span class="t-cat" aria-hidden="true"></span><span class="t-name">'+esc(m.name)+'</span><span class="t-price">'+priceLabel+'</span>'+(statusLabel?'<span class="sold-out-tag">'+statusLabel+'</span>':'')+(n?'<span class="t-qty" aria-hidden="true">'+n+'</span>':'')+'</button>';
  }

  function qtyInCart(id) {
    return S.cart.lines.filter(function (x) { return x.id === id; }).reduce(function (n, line) { return n + line.qty; }, 0);
  }

  function renderGrid(bumpId){
    var q=S.q.trim().toLowerCase(),visible=S.menu.filter(function(m){return m.available&&(S.cat==='all'||m.cat===S.cat)&&(!q||m.name.toLowerCase().indexOf(q)!==-1);});
    if(!visible.length){$('grid').innerHTML='<p class="empty">No menu items match “'+esc(S.q)+'”. Add one in the Menu tab.</p>';return;}
    if(S.cat!=='all'){$('grid').innerHTML=visible.map(function(m){return renderTile(m,bumpId);}).join('');return;}
    $('grid').innerHTML=orderedCategories().map(function(cat){
      var items=visible.filter(function(m){return m.cat===cat.id;});if(!items.length)return '';
      return '<section class="category-section"><header class="category-heading"><h3>'+esc(categoryLabel(cat))+'</h3><span>'+items.length+(items.length===1?' item':' items')+'</span></header><div class="grid category-grid">'+items.map(function(m){return renderTile(m,bumpId);}).join('')+'</div></section>';
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
        var portionControl = l.variantName ? '<span class="portion-label">' + esc(l.variantName) + '</span>' : (l.halfPrice
          ? '<label class="portion-wrap"><span class="sr-only">Portion</span><select class="portion-select" data-portion="' + i + '" aria-label="Portion for ' + esc(l.name) + '">' +
            '<option value="full"' + (l.portion === 'full' ? ' selected' : '') + '>Full</option>' +
            '<option value="half"' + (l.portion === 'half' ? ' selected' : '') + '>Half</option></select></label>'
          : '<span class="portion-label">Full</span>');
        return '<li class="line">' +
          '<span class="l-name">' + esc(l.name) + portionControl + '<label class="price-edit">Price <input type="number" min="0.01" step="0.01" inputmode="decimal" data-line-price="' + i + '" aria-label="Unit price for ' + esc(l.name) + '" value="' + (l.price / 100).toFixed(2) + '"></label></span>' +
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
    charge.disabled = !S.cart.lines.length || !S.shift || S.shift.status !== 'open';
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
    if (!S.shift || S.shift.status !== 'open') { err.textContent = 'No daily report is open. Sales are disabled.'; return; }
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
      h += '<div class="row"><span>' + l.qty + ' × ' + (l.variantName ? esc(l.name) + ' · ' + esc(l.variantName) : (l.portion === 'half' ? 'Half ' : '') + esc(l.name)) + '</span><span>' + M.peso(l.price * l.qty, { symbol: false }) + '</span></div>';
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
        '<td class="hide-sm">' + o.lines.map(function (l) { return l.qty + '× ' + (l.variantName ? esc(l.name) + ' · ' + esc(l.variantName) : (l.portion === 'half' ? 'Half ' : '') + esc(l.name)); }).join(', ') + '</td>' +
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

  // ---------- calendar-based reporting ----------
  var reportLoadSequence=0;
  function loadReportData(){
    var sequence=++reportLoadSequence,period=reportRange(),month=monthBounds(S.calendarMonth);
    var from=period.from<month.from?period.from:month.from,to=period.to>month.to?period.to:month.to;
    $('reportRangeLabel').textContent=formatDate(period.from)+(period.from===period.to?'':' – '+formatDate(period.to));
    $('reportCalendarTitle').textContent=new Date(S.calendarMonth+'-01T00:00:00Z').toLocaleDateString('en-PH',{timeZone:'UTC',month:'long',year:'numeric'});
    $('customRange').hidden=S.reportMode!=='custom';
    byId('reportFrom').value=S.customFrom;byId('reportTo').value=S.customTo;
    $('reportPeriodModes').querySelectorAll('[data-report-mode]').forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-report-mode')===S.reportMode));});
    $('reportLoading').hidden=false;
    return cloud.getReports(from,to).then(function(data){
      if(sequence!==reportLoadSequence)return;
      S.reportDays=data.days||[];S.reportOrders=data.orders||[];
      var current=reportRange();S.reportOrders=S.reportOrders.filter(function(o){return o.reportDate>=current.from&&o.reportDate<=current.to;});
      $('reportLoading').hidden=true;renderShift();
    }).catch(function(error){if(sequence!==reportLoadSequence)return;$('reportLoading').hidden=true;toast('Could not load reports: '+error.message);});
  }
  function renderReportCalendar(){
    var month=monthBounds(S.calendarMonth),first=new Date(month.from+'T00:00:00Z'),offset=(first.getUTCDay()+6)%7,days=Number(month.to.slice(8)),salesByDate={};
    S.reportOrders.forEach(function(o){var day=o.reportDate||'';if(!day)return;var s=salesByDate[day]||(salesByDate[day]={sales:0,count:0});if(o.status==='void')return;s.sales+=o.totals.total;s.count++;});
    var daysMeta={};S.reportDays.forEach(function(d){daysMeta[d.date]=d;});
    var html='<div class="calendar-weekdays">'+['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(function(x){return'<span>'+x+'</span>';}).join('')+'</div><div class="calendar-days">';
    for(var i=0;i<offset;i++)html+='<span class="calendar-blank"></span>';
    for(var n=1;n<=days;n++){var date=S.calendarMonth+'-'+String(n).padStart(2,'0'),summary=salesByDate[date],meta=daysMeta[date],selected=date===S.reportDate,hasSales=!!(summary&&summary.count);html+='<button type="button" class="calendar-day'+(selected?' selected':'')+(hasSales?' has-sales':'')+(meta?' has-report':'')+'" data-calendar-date="'+date+'" aria-label="'+formatDate(date)+', '+(summary?M.peso(summary.sales)+' sales':'no sales')+'"><span>'+n+'</span>'+(hasSales?'<small>'+M.peso(summary.sales,{symbol:false})+'</small>':(meta?'<i></i>':''))+'</button>';}
    html+='</div>';$('reportCalendar').innerHTML=html;
  }
  function renderShift(){
    var s=M.summarize(S.reportOrders),itemsSold=s.topItems.reduce(function(n,item){return n+item.qty;},0),range=reportRange();
    renderReportCalendar();
    $('reportKpis').innerHTML=[
      ['Net sales',M.peso(s.net),s.count+' paid orders'],
      ['Gross sales',M.peso(s.gross),'before discounts'],
      ['Paid orders',String(s.count),'completed transactions'],
      ['Average order',M.peso(s.avgTicket),'per paid order'],
      ['Items sold',String(itemsSold),'total quantity'],
      ['Voided orders',String(s.voided),'excluded from sales'],
      ['Discounts',M.peso(s.discounts),'Senior / PWD'],
      ['VAT removed',M.peso(s.vatRemoved),'discounted sales']
    ].map(function(k){return'<div class="panel kpi"><span class="eyebrow">'+k[0]+'</span><b>'+k[1]+'</b><small>'+k[2]+'</small></div>';}).join('');
    var hours=Object.keys(s.byHour).map(Number),lo=hours.length?Math.min.apply(null,hours):7,hi=hours.length?Math.max.apply(null,hours):12;
    while(hi-lo<5){if(lo>0)lo--;if(hi-lo<5&&hi<23)hi++;}
    var max=0,h,bars='',labels='';for(h=lo;h<=hi;h++)max=Math.max(max,s.byHour[h]||0);
    for(h=lo;h<=hi;h++){var v=s.byHour[h]||0,pct=max?Math.round(v/max*100):0,lab=(h%12||12)+(h<12?'a':'p');bars+='<div class="bar'+(v?'':' zero')+'" style="height:'+Math.max(pct,1)+'%" title="'+lab+': '+M.peso(v)+'">'+(v?'<span>'+(v>=100000?'₱'+(v/100000).toFixed(1)+'k':'₱'+Math.round(v/100))+'</span>':'')+'</div>';labels+='<span>'+lab+'</span>';}
    $('bars').innerHTML=bars;$('barLabels').innerHTML=labels;
    $('split').innerHTML=['cash','ewallet','card'].map(function(m){var v=s.byMethod[m]||0,pct=s.net?Math.round(v/s.net*100):0;return'<div class="split-row"><span>'+METHOD_LABEL[m]+'</span><span class="split-track"><span class="split-fill" style="width:'+pct+'%;display:block"></span></span><b>'+M.peso(v)+' · '+pct+'%</b></div>';}).join('');
    var top=s.topItems;
    $('topItems').innerHTML=top.length?'<thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Sales</th></tr></thead><tbody>'+top.map(function(i){return'<tr><td>'+esc(i.name)+'<small class="portion-breakdown">Full '+i.fullQty+' · Half '+i.halfQty+'</small></td><td class="num mono">'+i.qty+'</td><td class="num mono">'+M.peso(i.amount)+'</td></tr>';}).join('')+'</tbody>':'<tbody><tr><td class="empty">No item sales in this period.</td></tr></tbody>';
    var orders=S.reportOrders.slice().sort(function(x,y){return y.ts-x.ts;});
    $('reportOrdersTable').innerHTML=orders.length?'<thead><tr><th>Order</th><th>Date / Time</th><th>Payment</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>'+orders.map(function(o){return'<tr class="'+(o.status==='void'?'is-void':'')+'"><td class="mono">'+esc(o.no)+'</td><td>'+new Date(o.ts).toLocaleString('en-PH',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+'</td><td>'+METHOD_LABEL[o.method]+'</td><td>'+(o.status==='void'?'Voided':'Paid')+'</td><td class="num mono">'+M.peso(o.totals.total)+'</td></tr>';}).join('')+'</tbody>':'<tbody><tr><td class="empty">No transactions found for this period.</td></tr></tbody>';
    $('reportTransactionCount').textContent=orders.length+' transaction'+(orders.length===1?'':'s');
  }
  function changeReportPeriod(delta){
    if(S.reportMode==='day')S.reportDate=dateShift(S.reportDate,delta);
    else if(S.reportMode==='week')S.reportDate=dateShift(S.reportDate,delta*7);
    else if(S.reportMode==='month'){var p=dateParts(S.reportDate),d=new Date(Date.UTC(p[0],p[1]-1+delta,1));S.reportDate=d.toISOString().slice(0,10);}
    else if(S.reportMode==='year'){var y=dateParts(S.reportDate);S.reportDate=(y[0]+delta)+'-'+S.reportDate.slice(5);}
    else {S.reportDate=dateShift(S.reportDate,delta);}
    S.calendarMonth=dateMonth(S.reportDate);if(S.reportMode==='custom'){S.customFrom=S.reportDate;S.customTo=S.reportDate;}loadReportData();
  }
  function copyReportCsv(){copyText(M.toCSV(S.reportOrders),'Report CSV copied. Paste it into a spreadsheet.');}
  function downloadCsv(){
    var csv=M.toCSV(S.reportOrders),blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),a=document.createElement('a'),range=reportRange();
    a.href=URL.createObjectURL(blob);a.download='victorias-report-'+range.from+'-to-'+range.to+'.csv';document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){URL.revokeObjectURL(a.href);},1000);toast('Report CSV saved.');
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
  function compressMenuImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { resolve(''); return; }
      if (!/^image\//.test(file.type)) { reject(new Error('Choose an image file.')); return; }
      if (file.size > 8 * 1024 * 1024) { reject(new Error('Choose an image smaller than 8 MB.')); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, 480 / img.width, 360 / img.height);
        var canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          if (!blob || blob.size > 90000) { reject(new Error('Photo is too large after compression. Try a smaller image.')); return; }
          var reader = new FileReader(); reader.onload = function () { resolve(String(reader.result)); }; reader.onerror = function () { reject(new Error('Could not read this photo.')); }; reader.readAsDataURL(blob);
        }, 'image/jpeg', 0.68);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not open this image.')); }; img.src = url;
    });
  }
  function renderMenuAdmin() {
    byId('k-biz').value = S.settings.bizName;
    byId('k-biznote').value = S.settings.bizNote;
    byId('k-vat').checked = !!S.settings.vatRegistered;
    var catOpts = function (sel) {
      return S.categories.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(categoryLabel(c)) + '</option>'; }).join('');
    };
    var defaultCat = S.categories.filter(function (c) { return c.id === 'meals' || c.name.toLowerCase() === 'ulam'; })[0] || S.categories[0];
    $('newCat').innerHTML = catOpts(defaultCat.id);
    updateNewVariantControl();
    $('menuAdminFilters').innerHTML = '<button type="button" class="chip" data-admin-cat="all" aria-pressed="' + (S.menuAdminCat === 'all') + '">All</button>' + S.categories.map(function (c) { return '<button type="button" class="chip" data-admin-cat="' + esc(c.id) + '" aria-pressed="' + (S.menuAdminCat === c.id) + '">' + esc(categoryLabel(c)) + '</button>'; }).join('');
    var visibleMenu = S.menu.filter(function (m) { return S.menuAdminCat === 'all' || m.cat === S.menuAdminCat; });
    var h = '<thead><tr><th>Item</th><th>Photo</th><th class="hide-sm">Category</th><th class="num">Price / Drink variants</th><th class="num">Half ₱</th><th>Available today</th><th>Sold out</th><th class="num"><span class="sr-only">Delete</span></th></tr></thead><tbody>';
    visibleMenu.forEach(function (m) {
      h += '<tr data-item="' + esc(m.id) + '">' +
        '<td><input aria-label="Name" data-f="name" value="' + esc(m.name) + '" maxlength="40"></td>' +
        '<td class="menu-photo-cell">' + (m.image ? '<img class="menu-thumb" src="' + esc(m.image) + '" alt="">' : '<span class="menu-thumb placeholder">🍽️</span>') + '<input type="file" accept="image/*" data-f="image" aria-label="Photo for ' + esc(m.name) + '"></td>' +
        '<td class="hide-sm"><select aria-label="Category" data-f="cat">' + catOpts(m.cat) + '</select></td>' +
        (isDrinksCategory(m.cat)?'<td colspan="2" class="drink-variants-cell">'+renderVariantEditor(m.variants)+'</td>':'<td class="num price"><input aria-label="Full order price in pesos" data-f="price" inputmode="decimal" value="' + (m.price / 100).toFixed(2) + '"></td><td class="num price"><input aria-label="Half order price in pesos" data-f="halfPrice" inputmode="decimal" placeholder="Optional" value="' + (m.halfPrice ? (m.halfPrice / 100).toFixed(2) : '') + '"></td>') +
        '<td><label class="check"><input type="checkbox" data-f="available"' + (m.available ? ' checked' : '') + '><span>Available</span></label></td>' +
        '<td><label class="check"><input type="checkbox" data-f="soldOut"' + (m.soldOut ? ' checked' : '') + '><span>Sold out</span></label></td>' +
        '<td class="num"><button type="button" class="btn small ghost" data-del="' + esc(m.id) + '" aria-label="Delete ' + esc(m.name) + '">✕</button></td>' +
        '</tr>';
    });
    $('menuTable').innerHTML = visibleMenu.length ? h + '</tbody>' : '<tbody><tr><td colspan="8" class="empty">No items in this category yet.</td></tr></tbody>';
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
    var notice = $('reportNotice');
    if (notice) {
      notice.hidden = !!(S.shift && S.shift.status === 'open');
      if (!notice.hidden) notice.textContent = 'The register opens automatically when today’s business report starts at 7:00 AM, Monday to Friday.';
    }
  }

  function renderAll() {
    renderBrand(); renderCats(); renderGrid(); renderCart();
    if (S.view === 'orders') renderOrders();
    if (S.view === 'shift') renderShift();
  }

  // ---------- cart mutations ----------
  function addItem(id,variant){
    if(!S.shift||S.shift.status!=='open'){toast('No daily report is open. Sales are disabled.');return;}
    var m=S.menu.filter(function(x){return x.id===id;})[0];if(!m)return;if(m.soldOut){toast(m.name+' is sold out');return;}
    var isDrink=isDrinksCategory(m.cat),options=isDrink&&Array.isArray(m.variants)?m.variants.filter(function(v){return v.available!==false;}):[];
    if(isDrink&&!options.length){toast(m.name+' has no available sizes today');return;}
    if(options.length&&!variant){showVariantPicker(Object.assign({},m,{variants:options}));return;}
    var chosen=variant||null,price=chosen?chosen.price:m.price,key=chosen?chosen.id:'default';
    var l=S.cart.lines.filter(function(x){return x.id===id&&(x.variantId||'default')===key&&x.price===price;})[0];
    if(l)l.qty=Math.min(99,l.qty+1);else S.cart.lines.push({id:m.id,name:m.name,price:price,fullPrice:price,halfPrice:null,portion:'full',variantId:chosen?chosen.id:null,variantName:chosen?chosen.name:'',optionPrice:chosen?chosen.price:null,qty:1});
    saveCart();renderCart();renderGrid(id);
  }
  var choosingItemId=null;
  function showVariantPicker(m){
    choosingItemId=m.id;var dlg=$('variantDlg');
    if(!dlg){dlg=document.createElement('dialog');dlg.className='variant-dlg';dlg.setAttribute('data-k','variantDlg');root.appendChild(dlg);}
    dlg.innerHTML='<form method="dialog" class="variant-card"><div class="variant-head"><div><p class="eyebrow">Choose an option</p><h2>'+esc(m.name)+'</h2></div><button type="submit" class="btn ghost" aria-label="Close">✕</button></div><div class="variant-options">'+m.variants.filter(function(v){return v.available!==false;}).map(function(v){return '<button type="button" class="variant-option" data-variant-id="'+esc(v.id)+'"><span>'+esc(v.name)+'</span><b>'+M.peso(v.price)+'</b></button>';}).join('')+'</div></form>';
    if(dlg.showModal)dlg.showModal();else dlg.setAttribute('open','');
  }
  function parseVariantText(value,existing){
    var rows=String(value||'').split(/\r?\n/).map(function(x){return x.trim();}).filter(Boolean);if(rows.length>20)return{error:'Use no more than 20 options per item.'};
    var out=[],names={};for(var i=0;i<rows.length;i++){var parts=rows[i].split('|'),name=(parts.shift()||'').trim(),priceText=parts.join('|').trim(),cents=M.toCentavos(priceText);
      if(!name||name.length>30||!priceText||isNaN(cents)||cents<1||cents>100000000)return{error:'Use one option per line in this format: Bote | 20'};
      var normalized=name.toLowerCase();if(names[normalized])return{error:'Option names must be unique.'};names[normalized]=true;
      var old=(existing||[]).filter(function(v){return v.name.toLowerCase()===normalized;})[0];out.push({id:old?old.id:'v'+normalized.replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)+'-'+i,name:name,price:cents});
    }return{variants:out};
  }
  function variantsText(variants){return(variants||[]).map(function(v){return v.name+' | '+(v.price/100).toFixed(2);}).join('\n');}
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
    root.addEventListener('click',function(e){
      var option=e.target.closest('[data-variant-id]');if(!option)return;
      var item=S.menu.filter(function(m){return m.id===choosingItemId;})[0],selected=item&&item.variants?item.variants.filter(function(v){return v.id===option.getAttribute('data-variant-id')&&v.available!==false;})[0]:null;
      var dlg=$('variantDlg');if(dlg&&dlg.close)dlg.close();if(selected)addItem(item.id,selected);choosingItemId=null;
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
      var priceInput = e.target.closest('[data-line-price]');
      if (priceInput) {
        var priceLine = S.cart.lines[+priceInput.getAttribute('data-line-price')];
        var adjusted = M.toCentavos(priceInput.value);
        if (!priceLine) return;
        if (isNaN(adjusted) || adjusted < 1 || adjusted > 100000000) {
          toast('Enter a valid price greater than ₱0.');
          renderCart();
          return;
        }
        priceLine.price = adjusted;
        saveCart(); renderCart(); renderGrid();
        return;
      }
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

    $('copyCsv').addEventListener('click',copyReportCsv);
    $('dlCsv').addEventListener('click',downloadCsv);
    $('reportPeriodModes').addEventListener('click',function(e){var b=e.target.closest('[data-report-mode]');if(!b)return;S.reportMode=b.getAttribute('data-report-mode');if(S.reportMode==='custom'){S.customFrom=S.reportDate;S.customTo=S.reportDate;}loadReportData();});
    $('reportCalendar').addEventListener('click',function(e){var b=e.target.closest('[data-calendar-date]');if(!b)return;S.reportDate=b.getAttribute('data-calendar-date');S.reportMode='day';S.calendarMonth=dateMonth(S.reportDate);loadReportData();});
    $('calendarPrev').addEventListener('click',function(){var p=S.calendarMonth.split('-').map(Number),d=new Date(Date.UTC(p[0],p[1]-2,1));S.calendarMonth=d.toISOString().slice(0,7);loadReportData();});
    $('calendarNext').addEventListener('click',function(){var p=S.calendarMonth.split('-').map(Number),d=new Date(Date.UTC(p[0],p[1],1));S.calendarMonth=d.toISOString().slice(0,7);loadReportData();});
    $('reportPrev').addEventListener('click',function(){changeReportPeriod(-1);});
    $('reportNext').addEventListener('click',function(){changeReportPeriod(1);});
    $('reportToday').addEventListener('click',function(){S.reportDate=manilaToday();S.calendarMonth=dateMonth(S.reportDate);S.reportMode='day';loadReportData();});
    $('applyCustomRange').addEventListener('click',function(){var from=byId('reportFrom').value,to=byId('reportTo').value;if(!from||!to){toast('Choose both start and end dates.');return;}if(from>to){toast('Start date must be before end date.');return;}S.customFrom=from;S.customTo=to;S.reportDate=from;S.calendarMonth=dateMonth(from);S.reportMode='custom';loadReportData();});

    $('settingsForm').addEventListener('submit', function (e) { e.preventDefault(); });
    $('settingsForm').addEventListener('change', function () {
      S.settings.bizName = byId('k-biz').value.trim() || 'My Store';
      S.settings.bizNote = byId('k-biznote').value.trim();
      S.settings.vatRegistered = byId('k-vat').checked;
      renderBrand(); renderTotals(); saveMenu();
    });
    $('newCat').addEventListener('change', updateNewVariantControl);
    $('menuAdminFilters').addEventListener('click', function (e) {
      var b = e.target.closest('[data-admin-cat]'); if (!b) return;
      S.menuAdminCat = b.getAttribute('data-admin-cat'); renderMenuAdmin();
    });
    $('menuTable').addEventListener('click',function(e){var add=e.target.closest('[data-variant-add]'),remove=e.target.closest('[data-variant-remove]'),tr=e.target.closest('[data-item]');if(!tr)return;var m=S.menu.filter(function(x){return x.id===tr.getAttribute('data-item');})[0];if(!m)return;if(add){var list=tr.querySelector('.variant-editor-list');if(list.querySelectorAll('[data-variant-row]').length>=20){toast('Maximum 20 variants per drink.');return;}list.insertAdjacentHTML('beforeend',renderVariantRow({id:'v'+Date.now().toString(36),name:'',price:0,available:true}));return;}if(remove){if(tr.querySelectorAll('[data-variant-row]').length<=1){toast('A drink needs at least one variant.');return;}var row=remove.closest('[data-variant-row]');row.remove();var result=readVariantEditor(tr.querySelector('.drink-variants-cell'));if(!result.incomplete&&!result.error){m.variants=result.variants;m.price=m.variants.length?m.variants[0].price:100;m.halfPrice=null;saveMenu();}}});
    $('menuTable').addEventListener('change', function (e) {
      var variantField=e.target.getAttribute('data-vf'),variantRow=e.target.closest('[data-variant-row]');
      if(variantField&&variantRow){var variantResult=readVariantEditor(e.target.closest('.drink-variants-cell'));if(variantResult.error){toast(variantResult.error);return;}if(variantResult.incomplete)return;var targetTr=e.target.closest('[data-item]'),targetItem=S.menu.filter(function(x){return x.id===targetTr.getAttribute('data-item');})[0];targetItem.variants=variantResult.variants;targetItem.price=variantResult.variants.length?variantResult.variants[0].price:100;targetItem.halfPrice=null;saveMenu().then(renderMenuAdmin);return;}
      var f = e.target.getAttribute('data-f');
      var tr = e.target.closest('[data-item]');
      if (!f || !tr) return;
      var m = S.menu.filter(function (x) { return x.id === tr.getAttribute('data-item'); })[0];
      if (!m) return;
      if (f === 'image') {
        var photoInput = e.target; photoInput.disabled = true;
        compressMenuImage(photoInput.files && photoInput.files[0]).then(function (image) { m.image = image; return saveMenu(); }).then(function () { renderMenuAdmin(); toast('Item photo saved.'); }).catch(function (error) { toast(error.message); photoInput.disabled = false; photoInput.value = ''; });
        return;
      }
      if (f === 'name') { var n = e.target.value.trim(); if (n) m.name = n; else e.target.value = m.name; }
      if (f === 'cat') {m.cat = e.target.value;if(!isDrinksCategory(m.cat))m.variants=[];else{m.halfPrice=null;if(!m.variants||!m.variants.length)m.variants=[{id:'vregular-'+Date.now().toString(36),name:'Regular',price:m.price,available:true}];m.price=m.variants[0].price;}}
      if (f === 'available') m.available = e.target.checked;
      if (f === 'soldOut') m.soldOut = e.target.checked;
      if (f === 'cat' && !isDrinksCategory(m.cat)) m.variants = [];
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
      
      if(f==='cat'){saveMenu().then(renderMenuAdmin);return;}
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
    $('addForm').addEventListener('click',function(e){var add=e.target.closest('[data-variant-add]'),remove=e.target.closest('[data-variant-remove]');if(!add&&!remove)return;var box=byId('k-newvariants'),list=box.querySelector('.variant-editor-list');if(add){if(list.querySelectorAll('[data-variant-row]').length>=20){toast('Maximum 20 variants per drink.');return;}list.insertAdjacentHTML('beforeend',renderVariantRow({id:'v'+Date.now().toString(36),name:'',price:0,available:true}));return;}remove.closest('[data-variant-row]').remove();});
    $('addForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var name=byId('k-newname').value.trim(),photoFile=byId('k-newimage').files&&byId('k-newimage').files[0],newCat=byId('k-newcat').value,hasDrinkOptions=isDrinksCategory(newCat),priceRaw=byId('k-newprice').value.trim(),price=priceRaw?M.toCentavos(priceRaw):NaN,halfRaw=byId('k-newhalfprice').value.trim(),halfPrice=halfRaw?M.toCentavos(halfRaw):null,parsedVariants=hasDrinkOptions?readVariantEditor(byId('k-newvariants')):{variants:[]};
      if(!name){$('addErr').textContent='Give the item a name.';return;}if(parsedVariants.error){$('addErr').textContent=parsedVariants.error;return;}
      if(hasDrinkOptions){if(parsedVariants.incomplete){$('addErr').textContent='Complete or remove each drink variant.';return;}if(!parsedVariants.variants.length){$('addErr').textContent='Add at least one drink size with a price.';return;}price=parsedVariants.variants[0].price;halfPrice=null;}
      else if(!Number.isSafeInteger(price)||price<=0){$('addErr').textContent='Enter a valid default price.';return;}
      if(!hasDrinkOptions&&halfRaw&&(isNaN(halfPrice)||halfPrice<=0||halfPrice>price)){$('addErr').textContent='Half-order price must be greater than zero and no more than the default price.';return;}
      $('addErr').textContent='';var submit=$('addForm').querySelector('[type="submit"]');submit.disabled=true;
      compressMenuImage(photoFile).then(function(image){S.menu.push({id:'u'+Date.now().toString(36),cat:newCat,name:name,price:price,halfPrice:hasDrinkOptions?null:halfPrice,variants:parsedVariants.variants,image:image,available:true,soldOut:false});return saveMenu();})
      .then(function(){renderMenuAdmin();byId('k-newname').value='';byId('k-newprice').value='';byId('k-newhalfprice').value='';byId('k-newvariants').querySelector('.variant-editor-list').innerHTML='';byId('k-newimage').value='';updateNewVariantControl();})
        .catch(function (error) { $('addErr').textContent = error.message; }).finally(function () { submit.disabled = false; });
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
    return cloud.getCurrentShift().then(function (shift) {
      S.shift = shift || null;
      return Promise.all([S.shift ? cloud.getOrders(S.shift.id) : Promise.resolve([]), cloud.getNextNo()]);
    }).then(function (results) {
      S.orders = results[0];
      S.nextNo = results[1];
      renderBrand();
      if (S.view === 'orders') renderOrders();
      if (S.view === 'shift') loadReportData();
      renderCart();
    }).finally(function () { refreshInFlight = false; });
  }

  cloud.getMenu().then(function (remote) {
    if (!remote || !Array.isArray(remote.menu) || !Array.isArray(remote.categories) || !remote.settings) throw new Error('The shared menu response is incomplete.');
    SAMPLE.settings = remote.settings;
    SAMPLE.categories = remote.categories;
    SAMPLE.menu = remote.menu.map(function(m){m.soldOut=!!m.soldOut;var drink=remote.categories.some(function(c){return c.id===m.cat&&(/^(drinks?|beverages?)$/i.test(String(c.name).trim())||/^(drinks?|beverages?)$/i.test(String(c.id).trim()));});m.variants=drink?(m.variants||[]).map(function(v){v.available=v.available!==false;return v;}):[];if(drink){if(!m.variants.length)m.variants=[{id:'vregular-'+m.id,name:'Regular',price:m.price,available:true}];m.halfPrice=null;m.price=m.variants[0].price;}return m;});
    startApp();
  }).catch(function (err) {
    startApp();
    toast('Using starter menu: ' + err.message);
  });
})();
