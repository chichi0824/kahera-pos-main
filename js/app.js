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
  function normalizeNotificationSettings(value) {
    value = value && typeof value === 'object' ? value : {};
    var reminder = Number(value.reminderMinutes);
    return {
      voiceEnabled: value.voiceEnabled === true,
      browserEnabled: value.browserEnabled !== false,
      floatingEnabled: value.floatingEnabled !== false,
      reminderMinutes: [0,1,2,3,5,10].indexOf(reminder) >= 0 ? reminder : 3
    };
  }
  var notificationSettings = normalizeNotificationSettings(store.get('notificationSettings', null));
  var orderAlertAudio = null, orderAlertsEnabled = notificationSettings.voiceEnabled, onlineOrdersInitialized = false;
  var lastSuccessfulSyncAt = null;
  var originalDocumentTitle = document.title, titleAlertTimer = null;
  var orderReminderTimer = null, orderAlertAcknowledged = false;
  var orderAlertAckStorageKey = 'kahera-online-order-alert-acknowledged';
  function enableOrderAlerts() {
    try {
      var AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (AudioCtor) {
        if (!orderAlertAudio) orderAlertAudio = new AudioCtor();
        if (orderAlertAudio.state === 'suspended') orderAlertAudio.resume();
      }
    } catch (e) {}
    notificationSettings.voiceEnabled = true;
    notificationSettings.browserEnabled = true;
    store.set('notificationSettings', notificationSettings);
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(function(permission){ updateOrderAlertButton(); renderNotificationPermission(); });
    }
    orderAlertsEnabled = true;
    updateOrderAlertButton();
    toast('Voice order alerts enabled on this device');
    speakOrderAlert(0, false, true);
  }
  function updateOrderAlertButton() {
    var b = $('enableAlerts'); if (!b) return;
    var granted = notificationSettings.browserEnabled && 'Notification' in window && Notification.permission === 'granted';
    b.classList.toggle('alerts-on', orderAlertsEnabled || granted);
    b.textContent = (orderAlertsEnabled || granted) ? '🔔 Alerts on' : '🔔 Enable alerts';
    b.title = granted ? 'Voice and browser notifications are available' : 'Enable voice and allow browser notifications when prompted';
  }
  function playOrderAlert() {
    if (!notificationSettings.voiceEnabled) return;
    try {
      var AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (AudioCtor) {
        if (!orderAlertAudio) orderAlertAudio = new AudioCtor();
        if (orderAlertAudio.state === 'suspended') orderAlertAudio.resume();
        var ctx = orderAlertAudio, now = ctx.currentTime;
        // A louder, longer two-part chime that is easier to notice in a busy shop.
        [0,0.18,0.36,0.72,0.90].forEach(function(offset,i){
          var osc=ctx.createOscillator(),gain=ctx.createGain();
          osc.type='triangle';
          osc.frequency.value=[880,1174,1396,1174,1396][i];
          gain.gain.setValueAtTime(0.0001,now+offset);
          gain.gain.exponentialRampToValueAtTime(0.38,now+offset+0.025);
          gain.gain.exponentialRampToValueAtTime(0.0001,now+offset+0.28);
          osc.connect(gain);gain.connect(ctx.destination);
          osc.start(now+offset);osc.stop(now+offset+0.30);
        });
      }
    } catch (e) {}
  }
  function speakOrderAlert(count, reminder, test) {
    if (!notificationSettings.voiceEnabled) return;
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      playOrderAlert();
      return;
    }
    try {
      window.speechSynthesis.cancel();
      var phrase = test ? 'Voice order alerts are enabled.' :
        reminder ? (count === 1 ? 'Reminder. You have one online order waiting for attention.' : 'Reminder. You have ' + count + ' online orders waiting for attention.') :
        (count === 1 ? 'You have one new order.' : 'You have ' + count + ' new orders.');
      var utterance = new SpeechSynthesisUtterance(phrase);
      utterance.lang = 'en-PH';
      utterance.rate = 0.92;
      utterance.pitch = 1;
      utterance.volume = 1;
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      playOrderAlert();
    }
  }
  function renderFloatingOrderAlert() {
    var button = $('floatingOrderAlert');
    if (!button) return;
    if (!notificationSettings.floatingEnabled) { button.hidden = true; return; }
    var unpaid = S.orders.filter(function(o){ return o.source === 'online' && o.status === 'unpaid'; });
    button.hidden = unpaid.length === 0;
    if (unpaid.length) {
      button.innerHTML = '<span class="floating-order-icon" aria-hidden="true">' + (orderAlertAcknowledged ? '✓' : '🔔') + '</span><span class="floating-order-copy"><strong>' + (orderAlertAcknowledged ? 'Alert acknowledged' : 'Online order' + (unpaid.length === 1 ? '' : 's') + ' received') + '</strong><small>' + unpaid.length + ' awaiting payment · ' + (orderAlertAcknowledged ? 'Still needs attention' : 'Tap to acknowledge and view') + '</small></span><span class="floating-order-count">' + unpaid.length + '</span>';
      button.classList.toggle('is-acknowledged', orderAlertAcknowledged);
      button.setAttribute('aria-label', unpaid.length + ' unpaid online orders. ' + (orderAlertAcknowledged ? 'Alert acknowledged. Open orders.' : 'Acknowledge alert and open orders.'));
    }
  }
  function acknowledgeOrderAlert() {
    orderAlertAcknowledged = true;
    if (orderReminderTimer) clearInterval(orderReminderTimer);
    orderReminderTimer = null;
    try { localStorage.setItem(orderAlertAckStorageKey, String(Date.now())); } catch (e) {}
    renderFloatingOrderAlert();
    var count = S.orders.filter(function(o){ return o.source === 'online' && o.status === 'unpaid'; }).length;
    toast('Alert acknowledged · ' + count + ' online order' + (count === 1 ? '' : 's') + ' still awaiting payment');
  }
  function remindUnacknowledgedOrder() {
    if (orderAlertAcknowledged) return;
    var unpaid = S.orders.filter(function(o){ return o.source === 'online' && o.status === 'unpaid'; });
    if (!unpaid.length) {
      if (orderReminderTimer) clearInterval(orderReminderTimer);
      orderReminderTimer = null;
      return;
    }
    var message = unpaid.length === 1 ? 'Reminder: online order ' + unpaid[0].no + ' is still awaiting attention' : 'Reminder: ' + unpaid.length + ' online orders are still awaiting attention';
    toast(message);
    if (notificationSettings.voiceEnabled) speakOrderAlert(unpaid.length, true, false);
    if (notificationSettings.browserEnabled && 'Notification' in window && Notification.permission === 'granted') {
      try {
        var notification = new Notification('Kahera order reminder', { body: message, tag: 'kahera-online-order-reminder', renotify: true, icon: 'icons/kahera-icon.png' });
        notification.onclick = function(){ acknowledgeOrderAlert(); window.focus(); setView('orders'); notification.close(); };
      } catch(e) {}
    }
    if (document.hidden) {
      if (titleAlertTimer) clearInterval(titleAlertTimer);
      var show = true;
      titleAlertTimer = setInterval(function(){document.title=show?'🔔 Order needs attention · '+originalDocumentTitle:originalDocumentTitle;show=!show;},900);
    }
  }
  function startOrderReminder() {
    if (orderReminderTimer) clearInterval(orderReminderTimer);
    orderReminderTimer = null;
    if (!notificationSettings.reminderMinutes) return;
    orderReminderTimer = setInterval(remindUnacknowledgedOrder, notificationSettings.reminderMinutes * 60000);
  }
  function announceIncomingOrders(incoming) {
    if (!incoming.length) return;
    var message = incoming.length===1 ? 'New online order '+incoming[0].no+' received' : incoming.length+' new online orders received';
    var stamp = incoming.map(function(o){return o.id;}).join(',');
    try {
      var key='kahera-online-order-alert:'+stamp;
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key,'1');
    } catch(e) {}
    orderAlertAcknowledged = false;
    try { localStorage.removeItem(orderAlertAckStorageKey); } catch (e) {}
    renderFloatingOrderAlert();
    startOrderReminder();
    toast(message);
    if (notificationSettings.voiceEnabled) speakOrderAlert(incoming.length, false, false);
    if (notificationSettings.browserEnabled && 'Notification' in window && Notification.permission === 'granted') {
      try {
        var notification = new Notification('New Kahera online order', { body: message, tag: 'kahera-new-online-orders', renotify: true, icon: 'icons/kahera-icon.png' });
        notification.onclick = function(){ acknowledgeOrderAlert(); window.focus(); setView('orders'); notification.close(); };
      } catch(e) {}
    }
    if (document.hidden) {
      if (titleAlertTimer) clearInterval(titleAlertTimer);
      var show = true;
      titleAlertTimer = setInterval(function(){document.title=show?'🔔 New order · '+originalDocumentTitle:originalDocumentTitle;show=!show;},900);
    }
  }
  window.addEventListener('storage', function(event){
    if (event.key === orderAlertAckStorageKey && event.newValue) {
      orderAlertAcknowledged = true;
      if (orderReminderTimer) clearInterval(orderReminderTimer);
      orderReminderTimer = null;
      renderFloatingOrderAlert();
    }
  });
  document.addEventListener('visibilitychange',function(){
    if (!document.hidden) {
      if (titleAlertTimer) clearInterval(titleAlertTimer);
      titleAlertTimer=null;document.title=originalDocumentTitle;
    }
  });
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  // ---------- state ----------
  var S = {};
  var sharedMenuReady = false;
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
    S.isAdmin = true;
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
    S.calendarOrders = [];
    S.reportDays = [];
    S.pendingOrder = null;
    S.cart = store.get('cart', null) || blankCart();
    if (!Array.isArray(S.cart.lines)) S.cart.lines = [];
    S.cart.lines.forEach(function (line) {
      line.qty = Math.max(1, Math.min(99, Number(line.qty) || 1));
      line.price = Math.max(0, Math.round(Number(line.price) || 0));
      line.portion = line.portion === 'half' ? 'half' : 'full';
      line.fullPrice = line.fullPrice || (line.portion === 'full' ? line.price : line.price * 2);
      line.halfPrice = line.halfPrice || null;
    });
    syncCartPrices();
    S.view = store.get('view', 'register');
    S.cat = 'all'; S.q = ''; S.paying = false; S.method = 'cash'; S.menuAdminCat = 'all';
  }
  function saveCart() { store.set('cart', S.cart); }
  function syncCartPrices() {
    var changed = false;
    S.cart.lines.forEach(function (line) {
      var item = S.menu.filter(function (m) { return m.id === line.id; })[0];
      if (!item) return;
      var variants = Array.isArray(item.variants) ? item.variants : [];
      if (variants.length) {
        var selected = variants.filter(function (v) { return v.id === line.variantId; })[0];
        if (!selected) return;
        if ((!line.priceOverridden && line.price !== selected.price) || line.fullPrice !== selected.price ||
            line.variantName !== selected.name || line.halfPrice !== null) changed = true;
        if (!line.priceOverridden) line.price = selected.price;
        line.fullPrice = selected.price;
        line.halfPrice = null;
        line.portion = 'full';
        line.variantName = selected.name;
        line.optionPrice = selected.price;
      } else {
        var officialPrice = line.portion === 'half' && item.halfPrice ? item.halfPrice : item.price;
        if (line.portion === 'half' && !item.halfPrice) line.portion = 'full';
        if ((!line.priceOverridden && line.price !== officialPrice) || line.fullPrice !== item.price ||
            line.halfPrice !== (item.halfPrice || null) || line.name !== item.name) changed = true;
        if (!line.priceOverridden) line.price = officialPrice;
        line.fullPrice = item.price;
        line.halfPrice = item.halfPrice || null;
        line.name = item.name;
        line.variantId = null;
        line.variantName = '';
        line.optionPrice = null;
      }
    });
    if (changed) saveCart();
  }
  function totals() {
    return M.computeTotals(S.cart.lines, { vatRegistered: S.settings.vatRegistered !== false });
  }
  function nextNo() { return S.nextNo || 'K-0001'; }

  // ---------- views ----------
  function setView(v) {
    S.view = v; store.set('view', v);
    root.querySelectorAll('[role="tab"][data-view]').forEach(function (b) {
      var on = b.getAttribute('data-view') === v;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    root.querySelectorAll('.view').forEach(function (sec) { sec.hidden = sec.id !== 'view-' + v; });
    if (v === 'orders') renderOrders();
    if (v === 'shift') loadReportData();
    if (v === 'menu') renderMenuAdmin();
    if (v === 'settings') renderSettings();
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
  function hasPriceOptions(item){return !!item&&Array.isArray(item.variants)&&item.variants.length>0;}
  function renderVariantRow(v){return '<div class="variant-edit-row" data-variant-row="'+esc(v.id)+'"><div class="variant-fields"><input data-vf="name" aria-label="Variant name" maxlength="30" value="'+esc(v.name||'')+'" placeholder="e.g. Bote"><input data-vf="price" aria-label="Variant price" inputmode="decimal" value="'+(v.price>0?(v.price/100).toFixed(2):'')+'" placeholder="Price"></div><div class="variant-status"><label class="check"><input type="checkbox" data-vf="available"'+(v.available!==false?' checked':'')+'><span>Available</span></label><label class="check"><input type="checkbox" data-vf="soldOut"'+(v.soldOut?' checked':'')+'><span>Sold out</span></label></div><button type="button" class="btn small ghost" data-variant-remove="'+esc(v.id)+'" aria-label="Remove variant">✕</button></div>';}
  function renderVariantEditor(variants){return '<div class="variant-editor-list">'+(variants||[]).map(renderVariantRow).join('')+'</div><button type="button" class="btn small" data-variant-add>Add option</button>';}
  function readVariantEditor(container){var rows=Array.prototype.slice.call(container.querySelectorAll('[data-variant-row]')),out=[],names={};for(var i=0;i<rows.length;i++){var row=rows[i],id=row.getAttribute('data-variant-row'),name=row.querySelector('[data-vf="name"]').value.trim(),price=M.toCentavos(row.querySelector('[data-vf="price"]').value),available=row.querySelector('[data-vf="available"]').checked,soldOut=row.querySelector('[data-vf="soldOut"]').checked;if(!name||name.length>30||isNaN(price)||price<1)return{incomplete:true};var key=name.toLowerCase();if(names[key])return{error:'Variant names must be unique.'};names[key]=true;out.push({id:id||'v'+Date.now().toString(36)+'-'+i,name:name,price:price,available:available,soldOut:soldOut});}return{variants:out};}
  function updateNewVariantControl(){var drink=isDrinksCategory(byId('k-newcat').value),enabled=drink||byId('k-newusevariants').checked,priceLabel=byId('k-newprice').closest('label'),halfLabel=byId('k-newhalfprice').closest('label'),toggleLabel=byId('k-newusevariants').closest('label'),variantBox=byId('k-newvariants'),list=variantBox.querySelector('.variant-editor-list');priceLabel.hidden=enabled;halfLabel.hidden=enabled;toggleLabel.hidden=drink;variantBox.hidden=!enabled;variantBox.querySelector('strong').textContent=drink?'Drink sizes':'Price options';variantBox.querySelector('.hint').textContent=drink?'Add each drink size separately, set its price, and choose whether it is available today.':'Add each selling option separately, set its price, and choose whether it is available today.';if(!enabled)list.innerHTML='';else if(!list.querySelector('[data-variant-row]'))list.innerHTML=renderVariantRow({id:'vnew-'+Date.now().toString(36),name:'',price:0,available:true,soldOut:false});}
  function renderCats(){
    var html='<button type="button" class="chip" data-cat="all" aria-pressed="'+(S.cat==='all')+'">All</button>';
    orderedCategories().forEach(function(c){html+='<button type="button" class="chip" data-cat="'+esc(c.id)+'" aria-pressed="'+(S.cat===c.id)+'">'+esc(categoryLabel(c))+'</button>';});
    $('cats').innerHTML=html;
  }
  function renderTile(m,bumpId){
    var n=qtyInCart(m.id),photo=m.image?'<img class="tile-photo" src="'+esc(m.image)+'" alt="" loading="lazy">':'<span class="tile-photo placeholder" aria-hidden="true">🍽️</span>';
    var hasOptions=hasPriceOptions(m),availableVariants=hasOptions?m.variants.filter(function(v){return v.available!==false&&!v.soldOut;}):[];
    var disabled=m.soldOut===true||m.available===false;
    var actions='';
    if(hasOptions){
      actions=m.variants.map(function(v){
        var off=disabled||v.available===false||v.soldOut===true;
        return '<button type="button" class="tile-option" data-add="'+esc(m.id)+'" data-variant="'+esc(v.id)+'"'+(off?' disabled':'')+'>'+esc(v.name)+'<strong>'+M.peso(v.price)+'</strong>'+(v.soldOut?'<small>Sold out</small>':'')+'</button>';
      }).join('');
    }else if(m.halfPrice){
      actions='<button type="button" class="tile-option" data-add="'+esc(m.id)+'" data-portion="full"'+(disabled?' disabled':'')+'>Full<strong>'+M.peso(m.price)+'</strong></button>'+
        '<button type="button" class="tile-option" data-add="'+esc(m.id)+'" data-portion="half"'+(disabled?' disabled':'')+'>Half<strong>'+M.peso(m.halfPrice)+'</strong></button>';
    }else{
      actions='<button type="button" class="tile-option" data-add="'+esc(m.id)+'" data-portion="full"'+(disabled?' disabled':'')+'>Add<strong>'+M.peso(m.price)+'</strong></button>';
    }
    var statusLabel=disabled?'Sold Out':(hasOptions&&!availableVariants.length?'No options available':'');
    return '<article class="tile tile-choice'+(m.id===bumpId?' bump':'')+(m.image?' has-photo':'')+(disabled?' is-sold-out':'')+'" style="--c:'+catColor(m.cat)+'">'+photo+'<span class="t-cat" aria-hidden="true"></span><span class="t-name">'+esc(m.name)+'</span>'+(statusLabel?'<span class="sold-out-tag">'+statusLabel+'</span>':'')+'<div class="tile-options">'+actions+'</div>'+(n?'<span class="t-qty" aria-label="'+n+' in order">'+n+'</span>':'')+'</article>';
  }

  function qtyInCart(id) {
    return S.cart.lines.filter(function (x) { return x.id === id; }).reduce(function (n, line) { return n + line.qty; }, 0);
  }

  function renderGrid(bumpId){
    var q=S.q.trim().toLowerCase(),visible=S.menu.filter(function(m){return (hasPriceOptions(m)||m.available)&&(S.cat==='all'||m.cat===S.cat)&&(!q||m.name.toLowerCase().indexOf(q)!==-1);});
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
    c.table = '';

    if (!c.lines.length) {
      $('lines').innerHTML = '<li class="empty">Tap a menu item to start an order.</li>';
    } else {
      $('lines').innerHTML = c.lines.map(function (l, i) {
        var portionControl = '<span class="portion-label">' + esc(l.variantName || (l.portion === 'half' ? 'Half' : 'Full')) + '</span>';
        return '<li class="line">' +
          '<span class="l-name"><span class="line-item-name">' + esc(l.name) + '</span>' + portionControl + '</span>' +
          '<span class="stepper"><button type="button" data-line="' + i + '" data-d="-1" aria-label="Remove one ' + esc(l.name) + '">−</button>' +
          '<span aria-label="Quantity">' + l.qty + '</span>' +
          '<button type="button" data-line="' + i + '" data-d="1" aria-label="Add one ' + esc(l.name) + '">+</button></span>' +
          '<label class="line-price"><span class="sr-only">Line total</span><span class="unit-currency" aria-hidden="true">₱</span><input type="number" min="0.01" step="0.01" inputmode="decimal" data-line-total="' + i + '" aria-label="Editable line total for ' + esc(l.name) + '" value="' + ((Number.isSafeInteger(l.lineTotal) ? l.lineTotal : l.price * l.qty) / 100).toFixed(2) + '"></label>' +
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
      h += row('Less 20% ' + DISC_LABEL[t.discountKind] + ' discount', M.peso(-t.discount, { symbol: false }), 'less');
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
  var paymentProofData = '';
  function compressPaymentImage(file) {
    return new Promise(function(resolve,reject){
      if(!file || !/^image\//.test(file.type)){reject(new Error('Choose an image file.'));return;}
      var reader=new FileReader();reader.onerror=function(){reject(new Error('Could not read the selected photo.'));};
      reader.onload=function(){var img=new Image();img.onerror=function(){reject(new Error('Could not open the selected photo.'));};img.onload=function(){
        var scale=Math.min(1,1280/Math.max(img.width,img.height)),canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        var quality=.76,result=canvas.toDataURL('image/jpeg',quality);while(result.length>650000&&quality>.42){quality-=.08;result=canvas.toDataURL('image/jpeg',quality);}
        if(result.length>650000){reject(new Error('Photo is too large. Please take a smaller photo.'));return;}resolve(result);
      };img.src=reader.result;};reader.readAsDataURL(file);
    });
  }
  function setPaymentProof(dataUrl){paymentProofData=dataUrl||'';$('paymentProofPreview').hidden=!paymentProofData;$('paymentProofImage').src=paymentProofData;if(!paymentProofData)byId('k-payment-proof').value='';}
  function openPay(open) {
    S.paying = open;
    $('pay').hidden = !open;
    $('cartActions').hidden = open;
    if (open) {
      byId('k-tendered').value = '';
      byId('k-ref').value = '';
      setPaymentProof('');
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
    if (S.method !== 'ewallet' && paymentProofData) setPaymentProof('');
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
      if (S.method === 'ewallet' ? (ref.length < 4 && !paymentProofData) : ref.length < 4) { err.textContent = S.method === 'ewallet' ? 'Enter a reference number or attach a payment confirmation photo.' : 'Type the reference number from the customer\'s payment confirmation.'; byId('k-ref').focus(); return; }
    }
    var orderSnapshot = {
      type: S.cart.type, table: S.cart.type === 'dine' ? S.cart.table : '',
      lines: clone(S.cart.lines), totals: t, method: S.method, tendered: tendered, ref: ref, paymentProof: paymentProofData
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
    h += '<div class="slip-brand"><img class="slip-logo" src="./icons/kahera-icon.png" alt="Kahera icon"><div><h3>' + esc(S.settings.bizName) + '</h3><p class="center slip-location">' + esc(S.settings.bizNote) + '</p></div></div>';
    h += '<p class="stamp">Order slip · not an official receipt</p>';
    h += '<div class="row"><span>' + esc(o.no) + '</span><span>' + new Date(o.ts).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</span></div>';
    h += '<div class="row"><span>' + (o.type === 'dine' ? 'Dine-in' + (o.table ? ' · Table ' + esc(o.table) : '') : 'Take-out') + '</span><span>' + METHOD_LABEL[o.method] + '</span></div><hr>';
    o.lines.forEach(function (l) {
      h += '<div class="row"><span>' + l.qty + ' × ' + (l.variantName ? esc(l.name) + ' · ' + esc(l.variantName) : (l.portion === 'half' ? 'Half ' : '') + esc(l.name)) + '</span><span>' + M.peso(l.lineTotalOverridden === true ? l.lineTotal : l.price * l.qty, { symbol: false }) + '</span></div>';
    });
    h += '<hr><div class="row"><span>Subtotal</span><span>' + M.peso(t.gross, { symbol: false }) + '</span></div>';
    if (t.discountKind !== 'none') {
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
  var pendingOnlinePaymentOrder = null, onlinePaymentProofData = '';
  function renderOrders() {
    var list = S.orders.slice().reverse();
    var unpaid = list.filter(function(o){return o.source==='online'&&o.status==='unpaid';});
    var voided = list.filter(function(o){return o.status==='void';}).length;
    var paid = list.filter(function(o){return o.status==='paid';}).length;
    $('ordersNote').textContent = list.length ? unpaid.length+' unpaid · '+paid+' paid · '+voided+' voided' : '';
    $('onlineOrders').innerHTML = unpaid.length ? '<div class="online-orders-head"><div><p class="eyebrow">CUSTOMER ORDERS</p><h3>Incoming online orders</h3></div><span class="pill unpaid">'+unpaid.length+' awaiting payment</span></div>'+unpaid.map(function(o){
      var fulfil=o.fulfillmentType==='delivery'?'Delivery':'Pickup';
      var address=o.fulfillmentType==='delivery'?(o.deliveryContactRequested?'Customer asked staff to contact them to confirm the delivery address':(o.deliveryAddress||'Address not provided')):'Pickup at store';
      return '<article class="online-order-card"><div class="online-order-top"><div><span class="mono">'+esc(o.no)+'</span><span class="pill unpaid">Unpaid</span><span class="pill online">Online · '+fulfil+'</span></div><strong class="online-order-total">'+M.peso(o.totals.total)+'</strong></div><div class="online-order-customer"><strong>'+esc(o.customerName||'Customer')+'</strong><a href="tel:'+esc(o.customerPhone||'')+'">'+esc(o.customerPhone||'No contact number')+'</a></div><p class="online-order-address">'+esc(address)+'</p><ul class="online-order-lines">'+o.lines.map(function(l){return '<li><span>'+l.qty+' × '+(l.variantName?esc(l.name)+' · '+esc(l.variantName):(l.portion==='half'?'Half ':'')+esc(l.name))+'</span><strong>'+M.peso(l.price*l.qty)+'</strong></li>';}).join('')+'</ul><div class="online-order-actions"><span class="hint">Awaiting payment confirmation</span><button type="button" class="btn primary small" data-mark-paid="'+esc(o.id)+'">Mark as Paid</button></div></article>';
    }).join('') : '<div class="online-orders-empty"><strong>No unpaid online orders</strong><span>New customer orders will appear here automatically.</span></div>';
    if (!list.length) {
      $('ordersTable').innerHTML = '<tbody><tr><td class="empty">No orders yet today.</td></tr></tbody>';
      return;
    }
    var h = '<thead><tr><th>Order</th><th>Time</th><th>Source / Customer</th><th class="hide-sm">Type</th><th class="hide-sm">Items</th><th>Status</th><th class="num">Total</th><th class="num"><span class="sr-only">Actions</span></th></tr></thead><tbody>';
    list.forEach(function (o) {
      var isVoid=o.status==='void',isOnline=o.source==='online';
      var type=isOnline?(o.fulfillmentType==='delivery'?'Delivery':'Pickup'):(o.type==='dine'?'Dine-in'+(o.table?' · T'+esc(o.table):''):'Take-out');
      var status=isVoid?'<span class="pill void">Void</span>':o.status==='unpaid'?'<span class="pill unpaid">Unpaid</span>':'<span class="pill paid">Paid'+(isOnline?' · '+(o.method==='ewallet'?'E-wallet':'Cash'):'')+'</span>';
      h+='<tr class="'+(isVoid?'is-void':o.status==='unpaid'?'is-unpaid':'')+'"><td class="mono">'+esc(o.no)+'</td><td class="mono">'+timeOf(o.ts)+'</td><td>'+(isOnline?'<strong>'+esc(o.customerName||'Customer')+'</strong><small class="order-source">Online</small>':'POS')+'</td><td class="hide-sm">'+type+'</td><td class="hide-sm">'+o.lines.map(function(l){return l.qty+'× '+(l.variantName?esc(l.name)+' · '+esc(l.variantName):(l.portion==='half'?'Half ':'')+esc(l.name));}).join(', ')+'</td><td>'+status+'</td><td class="num mono">'+M.peso(o.totals.total)+'</td><td class="num"><div class="row-actions">'+(isOnline&&o.status==='paid'?'<span class="hint">Cash received</span>':'')+(!isOnline?'<button type="button" class="btn small" data-slip="'+esc(o.no)+'">Slip</button>':'')+(isVoid?'':pendingVoid===o.no?'<span class="confirm">Void '+esc(o.no)+'? <button type="button" class="btn small danger" data-void-yes="'+esc(o.no)+'">Void</button><button type="button" class="btn small" data-void-no>Keep</button></span>':'<button type="button" class="btn small danger" data-void="'+esc(o.no)+'">Void</button>')+'</div></td></tr>';
    });
    $('ordersTable').innerHTML=h+'</tbody>';
  }

  function findOrder(no) { return S.orders.filter(function (o) { return o.no === no; })[0]; }

  // ---------- calendar-based reporting ----------
  var reportLoadSequence=0,lastReportRefresh=0;
  function loadReportData(){
    lastReportRefresh=Date.now();
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
      S.reportDays=data.days||[];S.calendarOrders=data.orders||[];S.reportOrders=S.calendarOrders.slice();
      var current=reportRange();S.reportOrders=S.reportOrders.filter(function(o){return o.reportDate>=current.from&&o.reportDate<=current.to;});
      $('reportLoading').hidden=true;renderShift();
    }).catch(function(error){if(sequence!==reportLoadSequence)return;$('reportLoading').hidden=true;toast('Could not load reports: '+error.message);});
  }
  function renderReportCalendar(){
    var month=monthBounds(S.calendarMonth),first=new Date(month.from+'T00:00:00Z'),offset=(first.getUTCDay()+6)%7,days=Number(month.to.slice(8)),salesByDate={};
    S.calendarOrders.forEach(function(o){var day=o.reportDate||'';if(!day)return;var s=salesByDate[day]||(salesByDate[day]={sales:0,count:0});if(o.status==='void')return;s.sales+=o.totals.total;s.count++;});
    var daysMeta={};S.reportDays.forEach(function(d){daysMeta[d.date]=d;});
    var html='<div class="calendar-weekdays">'+['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(function(x){return'<span>'+x+'</span>';}).join('')+'</div><div class="calendar-days">';
    for(var i=0;i<offset;i++)html+='<span class="calendar-blank"></span>';
    for(var n=1;n<=days;n++){var date=S.calendarMonth+'-'+String(n).padStart(2,'0'),summary=salesByDate[date],meta=daysMeta[date],selected=date===S.reportDate,hasSales=!!(summary&&summary.count);html+='<button type="button" class="calendar-day'+(selected?' selected':'')+(hasSales?' has-sales':'')+(meta?' has-report':'')+'" data-calendar-date="'+date+'" aria-label="'+formatDate(date)+', '+(summary?M.peso(summary.sales)+' sales':'no sales')+'"><span>'+n+'</span>'+(hasSales?'<small>'+(summary.sales>=100000?(summary.sales/100000).toFixed(1)+'k':Math.round(summary.sales/100).toString())+'</small>':(meta?'<i></i>':''))+'</button>';}
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
    var bars='',labels='',chartValues=[],chartLabels=[],chartTitle='Sales by hour';
    if(S.reportMode==='day'){
      var hours=Object.keys(s.byHour).map(Number),lo=hours.length?Math.min.apply(null,hours):7,hi=hours.length?Math.max.apply(null,hours):12;
      while(hi-lo<5){if(lo>0)lo--;if(hi-lo<5&&hi<23)hi++;}
      for(var hour=lo;hour<=hi;hour++){chartValues.push(s.byHour[hour]||0);chartLabels.push((hour%12||12)+(hour<12?'a':'p'));}
    }else{
      var span=Math.round((new Date(range.to+'T00:00:00Z')-new Date(range.from+'T00:00:00Z'))/86400000),monthly=span>62,trend={};
      S.reportOrders.forEach(function(o){if(o.status==='void')return;var key=monthly?o.reportDate.slice(0,7):o.reportDate;trend[key]=(trend[key]||0)+o.totals.total;});
      if(monthly){var startMonth=range.from.slice(0,7),endMonth=range.to.slice(0,7),cur=startMonth;while(cur<=endMonth){chartLabels.push(new Date(cur+'-01T00:00:00Z').toLocaleDateString('en-PH',{timeZone:'UTC',month:'short'}));chartValues.push(trend[cur]||0);var p=cur.split('-').map(Number),next=new Date(Date.UTC(p[0],p[1],1));cur=next.toISOString().slice(0,7);}}
      else{var curDate=range.from;while(curDate<=range.to){chartLabels.push(String(Number(curDate.slice(8))));chartValues.push(trend[curDate]||0);curDate=dateShift(curDate,1);}}
      chartTitle=monthly?'Sales by month':'Sales by day';
    }
    var max=chartValues.reduce(function(m,v){return Math.max(m,v);},0);
    chartValues.forEach(function(v,i){var pct=max?Math.round(v/max*100):0,lab=chartLabels[i];bars+='<div class="bar'+(v?'':' zero')+'" style="height:'+Math.max(pct,1)+'%" title="'+lab+': '+M.peso(v)+'">'+(v?'<span>'+(v>=100000?'₱'+(v/100000).toFixed(1)+'k':'₱'+Math.round(v/100))+'</span>':'')+'</div>';labels+='<span>'+lab+'</span>';});
    $('reportChartTitle').textContent=chartTitle;$('bars').innerHTML=bars;$('barLabels').innerHTML=labels;
    $('split').innerHTML=['cash','ewallet','card'].map(function(m){var v=s.byMethod[m]||0,pct=s.net?Math.round(v/s.net*100):0;return'<div class="split-row"><span>'+METHOD_LABEL[m]+'</span><span class="split-track"><span class="split-fill" style="width:'+pct+'%;display:block"></span></span><b>'+M.peso(v)+' · '+pct+'%</b></div>';}).join('');
    var top=s.topCategories||[];
    $('topItems').innerHTML=top.length?'<thead><tr><th>Item / selected option</th><th class="num">Qty</th><th class="num">Sales</th></tr></thead>'+top.map(function(category){return'<tbody><tr class="top-category-heading"><th colspan="3">'+'<span class="top-category-name">'+esc(category.name)+'</span><small class="top-category-count">'+category.qty+' sold</small></th></tr>'+category.items.map(function(item){var options=item.options.map(function(option){return esc(option.name)+' × '+option.qty;}).join(' · ');return'<tr><td>'+esc(item.name)+'<br><small class="portion-breakdown">'+options+'</small></td><td class="num mono">'+item.qty+'</td><td class="num mono">'+M.peso(item.amount)+'</td></tr>';}).join('')+'</tbody>';}).join(''):'<tbody><tr><td class="empty">No item sales in this period.</td></tr></tbody>';
    var orders=S.reportOrders.slice().sort(function(x,y){return y.ts-x.ts;});
    $('reportOrdersTable').innerHTML=orders.length?'<thead><tr><th>Order</th><th>Date / Time</th><th>Payment</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>'+orders.map(function(o){return'<tr class="'+(o.status==='void'?'is-void':'')+'"><td class="mono">'+esc(o.no)+'</td><td>'+new Date(o.ts).toLocaleString('en-PH',{timeZone:'Asia/Manila',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+'</td><td>'+METHOD_LABEL[o.method]+(o.hasPaymentProof?' <button type="button" class="btn small" data-proof="'+esc(o.id)+'">View proof</button>':'')+'</td><td>'+(o.status==='void'?'Voided':'Paid')+'</td><td class="num mono">'+M.peso(o.totals.total)+'</td></tr>';}).join('')+'</tbody>':'<tbody><tr><td class="empty">No transactions found for this period.</td></tr></tbody>';
    $('reportTransactionCount').textContent=orders.length+' transaction'+(orders.length===1?'':'s');
  }
  function changeReportPeriod(delta){
    if(S.reportMode==='day')S.reportDate=dateShift(S.reportDate,delta);
    else if(S.reportMode==='week')S.reportDate=dateShift(S.reportDate,delta*7);
    else if(S.reportMode==='month'){var p=dateParts(S.reportDate),d=new Date(Date.UTC(p[0],p[1]-1+delta,1));S.reportDate=d.toISOString().slice(0,10);}
    else if(S.reportMode==='year'){var y=dateParts(S.reportDate),targetYear=y[0]+delta,lastDay=new Date(Date.UTC(targetYear,y[1],0)).getUTCDate();S.reportDate=targetYear+'-'+String(y[1]).padStart(2,'0')+'-'+String(Math.min(y[2],lastDay)).padStart(2,'0');}
    else {S.reportDate=dateShift(S.reportDate,delta);}
    S.calendarMonth=dateMonth(S.reportDate);if(S.reportMode==='custom'){S.customFrom=S.reportDate;S.customTo=S.reportDate;}loadReportData();
  }
  var csvExportDialog=null,csvExportAction='download';
  function csvExportBounds(mode,from,to){
    var today=manilaToday(),range;
    if(mode==='current')range=reportRange();
    else if(mode==='day')range={from:S.reportDate,to:S.reportDate};
    else if(mode==='week'){var weekday=new Date(S.reportDate+'T00:00:00Z').getUTCDay(),monday=weekday===0?-6:1-weekday;var start=dateShift(S.reportDate,monday);range={from:start,to:dateShift(start,6)};}
    else if(mode==='month')range=monthBounds(S.reportDate.slice(0,7));
    else if(mode==='year'){var y=S.reportDate.slice(0,4);range={from:y+'-01-01',to:y+'-12-31'};}
    else if(mode==='custom')range={from:from,to:to};
    else range={from:'2000-01-01',to:today};
    return range;
  }
  function openCsvExport(action){
    csvExportAction=action;
    if(!csvExportDialog){
      csvExportDialog=document.createElement('dialog');csvExportDialog.className='csv-export-dlg';
      csvExportDialog.innerHTML='<form method="dialog" class="csv-export-card"><div class="csv-export-head"><div><p class="eyebrow">Daily reports</p><h2>Export transactions</h2></div><button type="button" class="btn ghost" data-csv-close aria-label="Close">✕</button></div><label for="csvExportPeriod">What would you like to export?<select id="csvExportPeriod"><option value="day">This day</option><option value="week">This week</option><option value="month">This month</option><option value="year">This year</option><option value="custom">Custom date range</option><option value="all">All records</option></select></label><div class="csv-export-custom" hidden><label for="csvExportFrom">From<input type="date" id="csvExportFrom"></label><label for="csvExportTo">To<input type="date" id="csvExportTo"></label></div><p class="hint" data-csv-range></p><p class="err" data-csv-error role="alert"></p><div class="csv-export-actions"><button type="button" class="btn ghost" data-csv-close>Cancel</button><button type="button" class="btn primary" data-csv-confirm>Continue</button></div></form>';
      root.appendChild(csvExportDialog);
      csvExportDialog.querySelectorAll('[data-csv-close]').forEach(function(b){b.addEventListener('click',function(){csvExportDialog.close();});});
      csvExportDialog.querySelector('#csvExportPeriod').addEventListener('change',updateCsvExportRange);
      csvExportDialog.querySelector('#csvExportFrom').addEventListener('change',updateCsvExportRange);
      csvExportDialog.querySelector('#csvExportTo').addEventListener('change',updateCsvExportRange);
      csvExportDialog.querySelector('[data-csv-confirm]').addEventListener('click',runCsvExport);
      csvExportDialog.addEventListener('click',function(e){if(e.target===csvExportDialog)csvExportDialog.close();});
    }
    var period=csvExportDialog.querySelector('#csvExportPeriod');
    period.value=S.reportMode==='custom'?'custom':S.reportMode;
    csvExportDialog.querySelector('#csvExportFrom').value=S.customFrom||S.reportDate;
    csvExportDialog.querySelector('#csvExportTo').value=S.customTo||S.reportDate;
    csvExportDialog.querySelector('[data-csv-error]').textContent='';
    updateCsvExportRange();
    if(csvExportDialog.showModal)csvExportDialog.showModal();else csvExportDialog.setAttribute('open','');
  }
  function updateCsvExportRange(){
    if(!csvExportDialog)return;
    var mode=csvExportDialog.querySelector('#csvExportPeriod').value,custom=csvExportDialog.querySelector('.csv-export-custom');
    custom.hidden=mode!=='custom';
    var range=csvExportBounds(mode,csvExportDialog.querySelector('#csvExportFrom').value,csvExportDialog.querySelector('#csvExportTo').value);
    var label=csvExportDialog.querySelector('[data-csv-range]');
    if(mode==='custom'&&(!range.from||!range.to)){label.textContent='Choose both dates to continue.';return;}
    if(mode==='custom'&&range.from>range.to){label.textContent='The start date must be before the end date.';return;}
    label.textContent='Date range: '+formatDate(range.from)+' – '+formatDate(range.to)+(mode==='all'?' · all available transaction history':'');
  }
  function runCsvExport(){
    var mode=csvExportDialog.querySelector('#csvExportPeriod').value,from=csvExportDialog.querySelector('#csvExportFrom').value,to=csvExportDialog.querySelector('#csvExportTo').value;
    var range=csvExportBounds(mode,from,to),error=csvExportDialog.querySelector('[data-csv-error]');
    if(!range.from||!range.to||range.from>range.to){error.textContent='Choose a valid start and end date.';return;}
    if(range.to>manilaToday()){error.textContent='The end date cannot be in the future.';return;}
    var button=csvExportDialog.querySelector('[data-csv-confirm]');button.disabled=true;button.textContent='Preparing…';error.textContent='';
    cloud.getReports(range.from,range.to).then(function(data){
      var csv=M.toCSV(data.orders||[]);
      if(csvExportAction==='copy'){copyText(csv,'Report CSV copied. Paste it into a spreadsheet.');}
      else{var blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='victorias-report-'+range.from+'-to-'+range.to+'.csv';document.body.appendChild(link);link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(link.href);},1000);toast('Report CSV saved.');}
      csvExportDialog.close();
    }).catch(function(err){error.textContent='Could not prepare CSV: '+err.message;}).finally(function(){button.disabled=false;button.textContent='Continue';});
  }
  function copyReportCsv(){openCsvExport('copy');}
  function downloadCsv(){openCsvExport('download');}

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
    var catOpts = function (sel) { return S.categories.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(categoryLabel(c)) + '</option>'; }).join(''); };
    var defaultCat = S.categories.filter(function (c) { return c.id === 'meals' || c.name.toLowerCase() === 'ulam'; })[0] || S.categories[0];
    $('newCat').innerHTML = catOpts(defaultCat.id);
    updateNewVariantControl();
    $('menuAdminFilters').innerHTML = '<button type="button" class="chip" data-admin-cat="all" aria-pressed="' + (S.menuAdminCat === 'all') + '">All</button>' + S.categories.map(function (c) { return '<button type="button" class="chip" data-admin-cat="' + esc(c.id) + '" aria-pressed="' + (S.menuAdminCat === c.id) + '">' + esc(categoryLabel(c)) + '</button>'; }).join('');
    var visibleMenu = S.menu.filter(function (m) { return S.menuAdminCat === 'all' || m.cat === S.menuAdminCat; });
    var h = '<colgroup><col class="menu-col-item"><col class="menu-col-category hide-sm"><col class="menu-col-pricing"><col class="menu-col-status"><col class="menu-col-delete"></colgroup><thead><tr><th>Item</th><th class="hide-sm">Category</th><th>Pricing / Options</th><th>Status</th><th class="num"><span class="sr-only">Delete</span></th></tr></thead><tbody>';
    var adminCategories = orderedCategories().filter(function (c) { return S.menuAdminCat === 'all' || c.id === S.menuAdminCat; });
    adminCategories.forEach(function (cat) {
      var categoryItems = visibleMenu.filter(function (m) { return m.cat === cat.id; });
      if (!categoryItems.length) return;
      h += '<tr class="menu-category-row"><th colspan="5"><span>' + esc(categoryLabel(cat)) + '</span><small>' + categoryItems.length + (categoryItems.length === 1 ? ' item' : ' items') + '</small></th></tr>';
      categoryItems.forEach(function (m) {
        var drink = isDrinksCategory(m.cat), usesOptions = drink || hasPriceOptions(m);
        h += '<tr class="' + (usesOptions ? 'drink-menu-row' : '') + '" data-item="' + esc(m.id) + '">' +
          '<td class="menu-item-cell"><div class="menu-item-editor">' + (m.image ? '<img class="menu-thumb" src="' + esc(m.image) + '" alt="">' : '<span class="menu-thumb placeholder">🍽️</span>') + '<div class="menu-item-fields"><input aria-label="Name" data-f="name" value="' + esc(m.name) + '" maxlength="40"><input class="menu-image-input" type="file" accept="image/*" data-f="image" aria-label="Photo for ' + esc(m.name) + '"></div></div></td>' +
          '<td class="hide-sm"><select aria-label="Category" data-f="cat">' + catOpts(m.cat) + '</select></td>' +
          (usesOptions ? '<td colspan="2" class="drink-variants-cell" data-variant-container>' + (drink ? '<strong>Drink sizes</strong>' : '<label class="check menu-options-toggle"><input type="checkbox" data-f="useVariants" checked><span>Use price options</span></label>') + renderVariantEditor(m.variants) + '</td>' :
            '<td class="menu-pricing-cell"><label><span>Full ₱</span><input aria-label="Full order price in pesos" data-f="price" inputmode="decimal" value="' + (m.price / 100).toFixed(2) + '"></label><label><span>Half ₱</span><input aria-label="Half order price in pesos" data-f="halfPrice" inputmode="decimal" placeholder="—" value="' + (m.halfPrice ? (m.halfPrice / 100).toFixed(2) : '') + '"></label><label class="check menu-options-toggle"><input type="checkbox" data-f="useVariants"><span>Use price options</span></label></td><td><div class="menu-status-cell"><label class="check"><input type="checkbox" data-f="available"' + (m.available ? ' checked' : '') + '><span>Available</span></label><label class="check"><input type="checkbox" data-f="soldOut"' + (m.soldOut ? ' checked' : '') + '><span>Sold out</span></label></div></td>') +
          '<td class="num"><button type="button" class="btn small ghost" data-del="' + esc(m.id) + '" aria-label="Delete ' + esc(m.name) + '">✕</button></td>' +
          '</tr>';
      });
    });
    $('menuTable').innerHTML = visibleMenu.length ? h + '</tbody>' : '<tbody><tr><td colspan="5" class="empty">No items in this category yet.</td></tr></tbody>';
  }
  function normalizeSharedMenu(remote){
    if(!remote||!Array.isArray(remote.menu)||!Array.isArray(remote.categories)||!remote.settings)throw new Error('The shared menu response is incomplete.');
    var categories=clone(remote.categories);
    var menu=remote.menu.map(function(m){m=clone(m);m.soldOut=!!m.soldOut;m.variants=(m.variants||[]).map(function(v){v.available=v.available!==false;v.soldOut=!!v.soldOut;return v;});var drink=categories.some(function(c){return c.id===m.cat&&(/^(drinks?|beverages?)$/i.test(String(c.name).trim())||/^(drinks?|beverages?)$/i.test(String(c.id).trim()));});if(drink){if(!m.variants.length)m.variants=[{id:'vregular-'+m.id,name:'Regular',price:m.price,available:true,soldOut:false}];m.halfPrice=null;m.price=m.variants[0].price;}return m;});
    return {settings:clone(remote.settings),categories:categories,menu:menu};
  }
  var menuSaveChain = Promise.resolve();
  function saveMenu() {
    if (!sharedMenuReady) {
      S.settings = clone(SAMPLE.settings); S.categories = clone(SAMPLE.categories); S.menu = clone(SAMPLE.menu);
      renderMenuAdmin(); renderGrid();
      var unavailable = new Error('The shared menu did not load. Menu changes are paused to protect your saved items. Refresh after the connection is restored.');
      toast(unavailable.message);
      return Promise.reject(unavailable);
    }
    menuSaveChain = menuSaveChain.catch(function () {}).then(function () {
      var payload = { settings: clone(S.settings), categories: clone(S.categories), menu: clone(S.menu) };
      return cloud.saveMenu(payload);
    }).then(function () {
      renderGrid();
      toast('Menu saved to the shared database. Cashiers will see it shortly.');
    }).catch(function (err) {
      return cloud.getMenu().then(function(remote){var restored=normalizeSharedMenu(remote);S.settings=restored.settings;S.categories=restored.categories;S.menu=restored.menu;syncCartPrices();}).catch(function(){}).then(function(){renderMenuAdmin();renderGrid();toast('Menu was not saved: '+err.message);throw err;});
    });
    return menuSaveChain;
  }
  function renderBrand() {
    $('biz').textContent = S.settings.bizName + ' · ' + S.settings.bizNote;
    $('orderCount').textContent = S.orders.filter(function (o) { return o.status !== 'void'; }).length;
    var notice = $('reportNotice');
    if (notice) {
      notice.hidden = true;
    }
  }

  function renderAll() {
    renderBrand(); renderCats(); renderGrid(); renderCart();
    if (S.view === 'orders') renderOrders();
    if (S.view === 'shift') renderShift();
  }

  // ---------- cart mutations ----------
  function addItem(id,variant,portion){
    var m=S.menu.filter(function(x){return x.id===id;})[0];if(!m)return;
    if(m.soldOut||m.available===false){toast(m.name+' is sold out');return;}
    var hasOptions=hasPriceOptions(m),chosen=variant||null;
    if(hasOptions){
      if(!chosen||chosen.available===false||chosen.soldOut){toast('Choose an available option');return;}
    }else if(portion==='half'&&!m.halfPrice){return;}
    var selectedPortion=hasOptions?'full':(portion==='half'?'half':'full');
    var fullPrice=chosen?chosen.price:m.price,halfPrice=chosen?null:(m.halfPrice||null);
    var price=selectedPortion==='half'?halfPrice:fullPrice;
    var key=chosen?chosen.id:'default';
    var l=S.cart.lines.filter(function(x){return x.id===id&&(x.variantId||'default')===key&&x.portion===selectedPortion&&x.price===price;})[0];
    if(l){l.qty=Math.min(99,(Number(l.qty)||0)+1);l.lineTotal=null;l.lineTotalOverridden=false;}
    else S.cart.lines.push({id:m.id,name:m.name,price:price,fullPrice:fullPrice,halfPrice:halfPrice,portion:selectedPortion,variantId:chosen?chosen.id:null,variantName:chosen?chosen.name:'',optionPrice:chosen?chosen.price:null,qty:1});
    saveCart();renderCart();renderGrid(id);
  }
  var choosingItemId=null;
  function showVariantPicker(m){
    choosingItemId=m.id;var dlg=$('variantDlg');
    if(!dlg){dlg=document.createElement('dialog');dlg.className='variant-dlg';dlg.setAttribute('data-k','variantDlg');root.appendChild(dlg);}
    dlg.innerHTML='<form method="dialog" class="variant-card"><div class="variant-head"><div><p class="eyebrow">Choose an option</p><h2>'+esc(m.name)+'</h2></div><button type="submit" class="btn ghost" aria-label="Close">✕</button></div><div class="variant-options">'+m.variants.filter(function(v){return v.available!==false;}).map(function(v){return '<button type="button" class="variant-option" data-variant-id="'+esc(v.id)+'"'+(v.soldOut?' disabled aria-disabled="true"':'')+'><span>'+esc(v.name)+(v.soldOut?' · Sold out':'')+'</span><b>'+M.peso(v.price)+'</b></button>';}).join('')+'</div></form>';
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
    l.qty = (Number(l.qty) || 0) + Number(d);
    l.lineTotal = null;
    l.lineTotalOverridden = false;
    if (l.qty <= 0) S.cart.lines.splice(i, 1);
    saveCart(); renderCart(); renderGrid();
  }

  // ---------- events ----------
  var eventsBound = false;
  function bind() {
    if (eventsBound) return;
    eventsBound = true;
    root.querySelectorAll('[data-open-view]').forEach(function (button) {
      button.addEventListener('click', function () {
        setView(button.getAttribute('data-open-view'));
      });
    });
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

    var orderShareUrl = new URL('order.html', window.location.href).href;
    $('openOrderShare').addEventListener('click', function () {
      $('orderShareUrl').value = orderShareUrl;
      $('orderShareQr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=12&data=' + encodeURIComponent(orderShareUrl);
      $('orderShareFeedback').textContent = '';
      if ($('orderShareDlg').showModal) $('orderShareDlg').showModal();
      else $('orderShareDlg').setAttribute('open', '');
    });
    $('closeOrderShare').addEventListener('click', function () {
      if ($('orderShareDlg').close) $('orderShareDlg').close();
      else $('orderShareDlg').removeAttribute('open');
    });
    $('copyOrderShare').addEventListener('click', function () {
      var field = $('orderShareUrl');
      var copied = function () { $('orderShareFeedback').textContent = 'Link copied. You can now paste it into Messenger or any chat.'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(orderShareUrl).then(copied).catch(function () {
          field.focus(); field.select();
          try { document.execCommand('copy'); copied(); } catch (e) { $('orderShareFeedback').textContent = 'Select and copy the link above.'; }
        });
      } else {
        field.focus(); field.select();
        try { document.execCommand('copy'); copied(); } catch (e) { $('orderShareFeedback').textContent = 'Select and copy the link above.'; }
      }
    });
    $('shareOrderLink').addEventListener('click', function () {
      if (navigator.share) {
        navigator.share({ title: 'Order from our menu', text: 'You can place your order here:', url: orderShareUrl }).then(function () {
          $('orderShareFeedback').textContent = 'Share sheet opened.';
        }).catch(function (error) {
          if (error && error.name !== 'AbortError') $('orderShareFeedback').textContent = 'Sharing was unavailable. Copy the link and paste it into Messenger.';
        });
      } else {
        $('orderShareFeedback').textContent = 'Copy the link above, then paste it into Messenger.';
      }
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
      if (!b || b.disabled) return;
      var itemId=b.getAttribute('data-add'),variantId=b.getAttribute('data-variant'),portion=b.getAttribute('data-portion')||'full';
      var item=S.menu.filter(function(m){return m.id===itemId;})[0];
      var variant=item&&Array.isArray(item.variants)?item.variants.filter(function(v){return v.id===variantId;})[0]:null;
      addItem(itemId,variant,portion);
    });

    $('otype').addEventListener('click', function (e) {
      var b = e.target.closest('[data-v]');
      if (!b) return;
      S.cart.type = b.getAttribute('data-v'); saveCart(); renderCart();
    });
    $('lines').addEventListener('click', function (e) {
      var b = e.target.closest('[data-line]');
      if (b) stepLine(+b.getAttribute('data-line'), +b.getAttribute('data-d'));
    });
    $('lines').addEventListener('change', function (e) {
      var amountInput = e.target.closest('[data-line-total]');
      if (amountInput) {
        var amountLine = S.cart.lines[+amountInput.getAttribute('data-line-total')];
        var adjustedTotal = M.toCentavos(amountInput.value);
        if (!amountLine) return;
        if (isNaN(adjustedTotal) || adjustedTotal < 1 || adjustedTotal > 10000000000) {
          toast('Enter a valid line total greater than ₱0.');
          renderCart();
          return;
        }
        amountLine.lineTotal = adjustedTotal;
        amountLine.lineTotalOverridden = true;
        saveCart(); renderCart();
        return;
      }
      var sel = e.target.closest('[data-portion]');
      if (!sel) return;
      var lineIndex = +sel.getAttribute('data-portion');
      var line = S.cart.lines[lineIndex];
      if (!line || !line.halfPrice) return;
      var nextPortion = sel.value === 'half' ? 'half' : 'full';
      if (nextPortion === line.portion) return;
      var nextPrice = nextPortion === 'half' ? line.halfPrice : line.fullPrice;
      if (line.qty > 1) {
        // Change exactly one serving; keep the remaining quantity unchanged.
        line.qty -= 1;
        line.lineTotal = null;
        line.lineTotalOverridden = false;
        var matchingLine = S.cart.lines.filter(function (candidate, index) {
          return index !== lineIndex &&
            candidate.id === line.id &&
            (candidate.variantId || 'default') === (line.variantId || 'default') &&
            candidate.portion === nextPortion &&
            candidate.price === nextPrice;
        })[0];
        if (matchingLine && matchingLine.qty < 99) {
          matchingLine.qty += 1;
        } else {
          var splitLine = Object.assign({}, line, {
            qty: 1,
            portion: nextPortion,
            price: nextPrice,
            priceOverridden: false
          });
          S.cart.lines.splice(lineIndex + 1, 0, splitLine);
        }
        toast('One serving changed to ' + (nextPortion === 'half' ? 'Half' : 'Full') + '.');
      } else {
        line.portion = nextPortion;
        line.price = nextPrice;
        line.priceOverridden = false;
        line.lineTotal = null;
        line.lineTotalOverridden = false;
      }
      saveCart(); renderCart(); renderGrid();
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
    byId('k-payment-proof').addEventListener('change',function(e){var file=e.target.files&&e.target.files[0];if(!file)return;$('payErr').textContent='Preparing payment photo…';compressPaymentImage(file).then(function(data){setPaymentProof(data);$('payErr').textContent='Photo attached. Verify payment was received before completing the sale.';}).catch(function(error){setPaymentProof('');$('payErr').textContent=error.message;});});
    $('removePaymentProof').addEventListener('click',function(){setPaymentProof('');$('payErr').textContent='Payment photo removed.';});
    $('reportOrdersTable').addEventListener('click',function(e){var b=e.target.closest('[data-proof]');if(!b)return;b.disabled=true;cloud.getPaymentProof(b.getAttribute('data-proof')).then(function(dataUrl){$('proofFullImage').src=dataUrl;$('proofTitle').textContent='Payment proof';$('proofDlg').showModal();}).catch(function(error){toast('Could not load payment proof: '+error.message);}).finally(function(){b.disabled=false;});});
    $('proofClose').addEventListener('click',function(){$('proofDlg').close();$('proofFullImage').src='';});

    $('slipClose').addEventListener('click', function () {
      var dlg = $('slipDlg');
      if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
    });
    $('slipDlg').addEventListener('close', function () { if (S.view === 'register') byId('k-search').focus(); });

    $('mGo').addEventListener('click', function (e) {
      e.preventDefault();
      byId('k-order').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('onlineOrders').addEventListener('click', function (e) {
      var t = e.target.closest('[data-mark-paid]');
      if (!t || t.disabled) return;
      pendingOnlinePaymentOrder = S.orders.filter(function (o) { return o.id === t.getAttribute('data-mark-paid'); })[0] || null;
      if (!pendingOnlinePaymentOrder) return;
      onlinePaymentProofData = '';
      $('onlinePayOrderLabel').textContent = pendingOnlinePaymentOrder.no + ' · ' + M.peso(pendingOnlinePaymentOrder.totals.total);
      $('onlinePayRef').value = '';
      $('onlinePayProofFile').value = '';
      $('onlinePayProofPreview').hidden = true;
      $('onlinePayProofImage').removeAttribute('src');
      $('onlinePayError').textContent = '';
      document.querySelector('input[name="online-payment-method"][value="cash"]').checked = true;
      $('onlineEwalletFields').hidden = true;
      $('onlinePayDlg').showModal();
    });
    document.querySelectorAll('input[name="online-payment-method"]').forEach(function(input){
      input.addEventListener('change',function(){
        $('onlineEwalletFields').hidden = document.querySelector('input[name="online-payment-method"]:checked').value !== 'ewallet';
      });
    });
    $('onlinePayClose').addEventListener('click',function(){$('onlinePayDlg').close();});
    $('onlinePayProofFile').addEventListener('change',function(e){
      var file=e.target.files&&e.target.files[0];if(!file)return;
      $('onlinePayError').textContent='Preparing receipt photo…';
      compressPaymentImage(file).then(function(data){
        onlinePaymentProofData=data;$('onlinePayProofImage').src=data;$('onlinePayProofPreview').hidden=false;$('onlinePayError').textContent='Receipt photo attached.';
      }).catch(function(error){onlinePaymentProofData='';$('onlinePayProofPreview').hidden=true;$('onlinePayError').textContent=error.message;});
    });
    $('onlinePayRemoveProof').addEventListener('click',function(){
      onlinePaymentProofData='';$('onlinePayProofFile').value='';$('onlinePayProofPreview').hidden=true;$('onlinePayProofImage').removeAttribute('src');
    });
    $('onlinePayConfirm').addEventListener('click',function(){
      if(!pendingOnlinePaymentOrder)return;
      var method=document.querySelector('input[name="online-payment-method"]:checked').value;
      var button=$('onlinePayConfirm');
      button.disabled=true;button.textContent='Saving…';$('onlinePayError').textContent='';
      cloud.markOrderPaid(pendingOnlinePaymentOrder.id,{method:method,ref:method==='ewallet'?$('onlinePayRef').value.trim():'',paymentProof:method==='ewallet'?onlinePaymentProofData:''}).then(function(updated){
        S.orders=S.orders.map(function(x){return x.id===updated.id?updated:x;});
        $('onlinePayDlg').close();pendingOnlinePaymentOrder=null;onlinePaymentProofData='';
        renderOrders();renderBrand();toast(updated.no+' marked paid · '+(updated.method==='ewallet'?'E-wallet':'Cash'));
      }).catch(function(error){$('onlinePayError').textContent='Could not update payment: '+error.message;}).finally(function(){button.disabled=false;button.textContent='Confirm payment received';});
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
    $('calendarPrev').addEventListener('click',function(){var p=S.calendarMonth.split('-').map(Number),d=new Date(Date.UTC(p[0],p[1]-2,1));S.calendarMonth=d.toISOString().slice(0,7);if(S.reportMode==='month'){var day=dateParts(S.reportDate)[2],last=Number(monthBounds(S.calendarMonth).to.slice(8));S.reportDate=S.calendarMonth+'-'+String(Math.min(day,last)).padStart(2,'0');}loadReportData();});
    $('calendarNext').addEventListener('click',function(){var p=S.calendarMonth.split('-').map(Number),d=new Date(Date.UTC(p[0],p[1],1));S.calendarMonth=d.toISOString().slice(0,7);if(S.reportMode==='month'){var day=dateParts(S.reportDate)[2],last=Number(monthBounds(S.calendarMonth).to.slice(8));S.reportDate=S.calendarMonth+'-'+String(Math.min(day,last)).padStart(2,'0');}loadReportData();});
    $('reportPrev').addEventListener('click',function(){changeReportPeriod(-1);});
    $('reportNext').addEventListener('click',function(){changeReportPeriod(1);});
    $('reportToday').addEventListener('click',function(){S.reportDate=manilaToday();S.calendarMonth=dateMonth(S.reportDate);S.reportMode='day';loadReportData();});
    $('applyCustomRange').addEventListener('click',function(){var from=byId('reportFrom').value,to=byId('reportTo').value;if(!from||!to){toast('Choose both start and end dates.');return;}if(from>to){toast('Start date must be before end date.');return;}S.customFrom=from;S.customTo=to;S.reportDate=from;S.calendarMonth=dateMonth(from);S.reportMode='custom';loadReportData();});

    $('settingsForm').addEventListener('submit', function (e) { e.preventDefault(); });
    $('settingsForm').addEventListener('change', function () {
      S.settings.bizName = byId('k-biz').value.trim() || 'My Store';
      S.settings.bizNote = byId('k-biznote').value.trim();
      renderBrand(); renderTotals(); saveMenu();
    });
    $('newCat').addEventListener('change', updateNewVariantControl);
    byId('k-newusevariants').addEventListener('change', updateNewVariantControl);
    byId('k-newusevariants').addEventListener('change', updateNewVariantControl);
    $('menuAdminFilters').addEventListener('click', function (e) {
      var b = e.target.closest('[data-admin-cat]'); if (!b) return;
      S.menuAdminCat = b.getAttribute('data-admin-cat'); renderMenuAdmin();
    });
    $('menuTable').addEventListener('click', function (e) {
      var tr = e.target.closest('[data-item]');
      if (!tr) return;
      var itemId = tr.getAttribute('data-item');
      var item = S.menu.filter(function (x) { return x.id === itemId; })[0];
      if (!item) return;
      var add = e.target.closest('[data-variant-add]');
      var remove = e.target.closest('[data-variant-remove]');
      var del = e.target.closest('[data-del]');
      if (add) {
        var list = tr.querySelector('.variant-editor-list');
        if (list.querySelectorAll('[data-variant-row]').length >= 20) { toast('Maximum 20 price options per item.'); return; }
        list.insertAdjacentHTML('beforeend', renderVariantRow({ id: 'v' + Date.now().toString(36), name: '', price: 0, available: true, soldOut: false }));
        return;
      }
      if (remove) {
        var variantRow = remove.closest('[data-variant-row]');
        var variantName = variantRow.querySelector('[data-vf="name"]').value.trim() || 'this option';
        if (!window.confirm('Remove "' + variantName + '" from ' + item.name + '? This change will be saved to the shared menu.')) return;
        if (tr.querySelectorAll('[data-variant-row]').length <= 1) { toast('Keep at least one option, or turn off price options.'); return; }
        variantRow.remove();
        var remaining = readVariantEditor(tr.querySelector('[data-variant-container]'));
        if (!remaining.incomplete && !remaining.error) { item.variants = remaining.variants; item.price = remaining.variants[0].price; item.halfPrice = null; saveMenu().then(renderMenuAdmin).catch(function () {}); }
        return;
      }
      if (del) {
        if (!window.confirm('Delete "' + item.name + '" from the menu? This cannot be undone from this screen.')) return;
        S.menu = S.menu.filter(function (x) { return x.id !== itemId; });
        saveMenu().then(function () { renderMenuAdmin(); toast('Removed ' + item.name); }).catch(function () {});
      }
    });
    $('menuTable').addEventListener('change', function (e) {
      var f = e.target.getAttribute('data-f');
      var tr = e.target.closest('[data-item]');
      if (!tr) return;
      var item = S.menu.filter(function (x) { return x.id === tr.getAttribute('data-item'); })[0];
      if (!item) return;
      var variantField = e.target.getAttribute('data-vf');
      if (variantField && e.target.closest('[data-variant-row]')) {
        var variantResult = readVariantEditor(e.target.closest('[data-variant-container]'));
        if (variantResult.error) { toast(variantResult.error); return; }
        if (variantResult.incomplete) return;
        item.variants = variantResult.variants; item.price = variantResult.variants[0].price; item.halfPrice = null;
        saveMenu().then(renderMenuAdmin).catch(function () {}); return;
      }
      if (!f) return;
      if (f === 'image') {
        var photoInput = e.target; photoInput.disabled = true;
        compressMenuImage(photoInput.files && photoInput.files[0]).then(function (image) { item.image = image; return saveMenu(); }).then(function () { renderMenuAdmin(); toast('Item photo saved.'); }).catch(function (error) { toast(error.message); photoInput.disabled = false; photoInput.value = ''; });
        return;
      }
      if (f === 'useVariants') {
        if (e.target.checked) { item.variants = [{ id: 'v' + Date.now().toString(36), name: 'Regular', price: item.price, available: true, soldOut: false }]; item.halfPrice = null; }
        else { item.price = hasPriceOptions(item) ? item.variants[0].price : item.price; item.variants = []; }
        saveMenu().then(renderMenuAdmin).catch(function () {}); return;
      }
      if (f === 'name') { var name = e.target.value.trim(); if (name) item.name = name; else e.target.value = item.name; }
      if (f === 'cat') { item.cat = e.target.value; if (isDrinksCategory(item.cat)) { item.halfPrice = null; if (!hasPriceOptions(item)) item.variants = [{ id: 'vregular-' + Date.now().toString(36), name: 'Regular', price: item.price, available: true, soldOut: false }]; item.price = item.variants[0].price; } }
      if (f === 'available') item.available = e.target.checked;
      if (f === 'soldOut') item.soldOut = e.target.checked;
      if (f === 'price') {
        var cents = M.toCentavos(e.target.value);
        if (isNaN(cents) || cents <= 0) { toast('Enter a price like 65 or 65.50'); e.target.value = (item.price / 100).toFixed(2); return; }
        item.price = cents; e.target.value = (cents / 100).toFixed(2);
        if (item.halfPrice && item.halfPrice > item.price) { item.halfPrice = null; toast('Half-order price cleared because it cannot exceed the full price.'); }
      }
      if (f === 'halfPrice') {
        var half = e.target.value.trim() === '' ? null : M.toCentavos(e.target.value);
        if (half !== null && (isNaN(half) || half <= 0 || half > item.price)) { toast('Half-order price must be greater than zero and no more than the full price.'); e.target.value = item.halfPrice ? (item.halfPrice / 100).toFixed(2) : ''; return; }
        item.halfPrice = half; e.target.value = half === null ? '' : (half / 100).toFixed(2);
      }
      if (f === 'cat') saveMenu().then(renderMenuAdmin).catch(function () {});
      else saveMenu().catch(function () {});
    });
    $('addForm').addEventListener('click', function (e) {
      var add = e.target.closest('[data-variant-add]'), remove = e.target.closest('[data-variant-remove]');
      if (!add && !remove) return;
      var list = byId('k-newvariants').querySelector('.variant-editor-list');
      if (add) {
        if (list.querySelectorAll('[data-variant-row]').length >= 20) { toast('Maximum 20 price options per item.'); return; }
        list.insertAdjacentHTML('beforeend', renderVariantRow({ id: 'v' + Date.now().toString(36), name: '', price: 0, available: true, soldOut: false }));
      } else {
        var newVariantRow = remove.closest('[data-variant-row]');
        var newVariantName = newVariantRow.querySelector('[data-vf="name"]').value.trim() || 'this option';
        if (!window.confirm('Remove "' + newVariantName + '" from the new item?')) return;
        newVariantRow.remove();
      }
    });
    $('addForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = byId('k-newname').value.trim(), photoFile = byId('k-newimage').files && byId('k-newimage').files[0], newCat = byId('k-newcat').value;
      var hasOptions = isDrinksCategory(newCat) || byId('k-newusevariants').checked;
      var priceRaw = byId('k-newprice').value.trim(), price = priceRaw ? M.toCentavos(priceRaw) : NaN;
      var halfRaw = byId('k-newhalfprice').value.trim(), halfPrice = halfRaw ? M.toCentavos(halfRaw) : null;
      var parsedVariants = hasOptions ? readVariantEditor(byId('k-newvariants')) : { variants: [] };
      if (!name) { $('addErr').textContent = 'Give the item a name.'; return; }
      if (parsedVariants.error) { $('addErr').textContent = parsedVariants.error; return; }
      if (hasOptions) {
        if (parsedVariants.incomplete) { $('addErr').textContent = 'Complete or remove each price option.'; return; }
        if (!parsedVariants.variants.length) { $('addErr').textContent = 'Add at least one price option.'; return; }
        price = parsedVariants.variants[0].price; halfPrice = null;
      } else if (!Number.isSafeInteger(price) || price <= 0) { $('addErr').textContent = 'Enter a valid default price.'; return; }
      if (!hasOptions && halfRaw && (isNaN(halfPrice) || halfPrice <= 0 || halfPrice > price)) { $('addErr').textContent = 'Half-order price must be greater than zero and no more than the default price.'; return; }
      $('addErr').textContent = '';
      var submit = $('addForm').querySelector('[type="submit"]'); submit.disabled = true;
      compressMenuImage(photoFile).then(function (image) {
        S.menu.push({ id: 'u' + Date.now().toString(36), cat: newCat, name: name, price: price, halfPrice: hasOptions ? null : halfPrice, variants: parsedVariants.variants, image: image, available: true, soldOut: false });
        return saveMenu();
      }).then(function () {
        renderMenuAdmin(); byId('k-newname').value = ''; byId('k-newprice').value = ''; byId('k-newhalfprice').value = '';
        byId('k-newusevariants').checked = false; byId('k-newvariants').querySelector('.variant-editor-list').innerHTML = '';
        byId('k-newimage').value = ''; updateNewVariantControl();
      }).catch(function (error) { $('addErr').textContent = error.message; }).finally(function () { submit.disabled = false; });
    });

    $('settingsView').addEventListener('change', function (event) {
      var target = event.target;
      if (target.matches('[data-k="customerOrderingEnabled"]')) {
        saveCustomerOrdering(target.checked);
        return;
      }
      if (target.matches('[data-k="voiceAlertsEnabled"]')) notificationSettings.voiceEnabled = target.checked;
      if (target.matches('[data-k="browserAlertsEnabled"]')) notificationSettings.browserEnabled = target.checked;
      if (target.matches('[data-k="floatingAlertEnabled"]')) notificationSettings.floatingEnabled = target.checked;
      if (target.matches('[data-k="reminderInterval"]')) notificationSettings.reminderMinutes = Number(target.value);
      store.set('notificationSettings', notificationSettings);
      orderAlertsEnabled = notificationSettings.voiceEnabled;
      if (target.matches('[data-k="browserAlertsEnabled"]') && target.checked && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(function(){renderNotificationPermission();updateOrderAlertButton();});
      }
      if (notificationSettings.reminderMinutes && S.orders.some(function(o){return o.source==='online'&&o.status==='unpaid';}) && !orderAlertAcknowledged) startOrderReminder();
      else if (orderReminderTimer && !notificationSettings.reminderMinutes) { clearInterval(orderReminderTimer); orderReminderTimer = null; }
      renderNotificationPermission();
      renderFloatingOrderAlert();
      updateOrderAlertButton();
      toast('Notification preferences saved on this device');
    });
    $('testVoiceAlert').addEventListener('click', function () {
      notificationSettings.voiceEnabled = true;
      orderAlertsEnabled = true;
      store.set('notificationSettings', notificationSettings);
      try { var AudioCtor=window.AudioContext||window.webkitAudioContext;if(AudioCtor){if(!orderAlertAudio)orderAlertAudio=new AudioCtor();if(orderAlertAudio.state==='suspended')orderAlertAudio.resume();} } catch(e) {}
      speakOrderAlert(0, false, true);
      updateOrderAlertButton();
      $('voiceAlertsEnabled').checked = true;
      toast('Voice notification test started');
    });
    $('requestBrowserPermission').addEventListener('click', function () {
      if (!('Notification' in window)) { renderNotificationPermission(); return; }
      notificationSettings.browserEnabled = true;
      store.set('notificationSettings', notificationSettings);
      Notification.requestPermission().then(function(){renderNotificationPermission();updateOrderAlertButton();});
    });
    $('refreshSystemStatus').addEventListener('click', function(){refreshSettingsStatus();refreshSharedData().catch(function(){});});
    $('changePasswordForm').addEventListener('submit', function(event){
      event.preventDefault();
      var current=$('currentPassword').value,newPassword=$('newPassword').value,confirmPassword=$('confirmPassword').value;
      $('changePasswordError').textContent='';
      if(newPassword.length<8){$('changePasswordError').textContent='Use at least 8 characters for your new password.';return;}
      if(newPassword!==confirmPassword){$('changePasswordError').textContent='The new passwords do not match.';return;}
      var submit=$('changePasswordForm').querySelector('button[type="submit"]');
      submit.disabled=true;submit.textContent='Updating password…';
      cloud.changePassword({currentPassword:current,newPassword:newPassword,confirmPassword:confirmPassword}).then(function(){
        $('changePasswordForm').reset();
        toast('Password changed successfully');
      }).catch(function(error){$('changePasswordError').textContent=error.message||'Could not change password.';}).finally(function(){submit.disabled=false;submit.textContent='Change password';});
    });

    $('logout').addEventListener('click', function () {
      cloud.logout();
      if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
      S.cart = blankCart();
      showOwnerLogin();
    });
    $('floatingOrderAlert').addEventListener('click', function(){ acknowledgeOrderAlert(); setView('orders'); });
    updateOrderAlertButton();
    $('theme').addEventListener('click', function () {
      var de = document.documentElement;
      var cur = de.getAttribute('data-theme') || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = cur === 'dark' ? 'light' : 'dark';
      de.setAttribute('data-theme', next);
      store.set('theme', next);
    });
  }

  function renderNotificationPermission() {
    var status = $('notificationPermissionStatus');
    if (!status) return;
    if (!('Notification' in window)) status.textContent = 'Browser notifications are not supported by this browser.';
    else if (Notification.permission === 'granted') status.textContent = notificationSettings.browserEnabled ? 'Browser permission granted on this device.' : 'Browser permission is granted, but notifications are turned off in Kahera settings.';
    else if (Notification.permission === 'denied') status.textContent = 'Permission is blocked by the browser. Change it in your browser site settings.';
    else status.textContent = 'Permission has not been requested yet.';
  }
  function renderSettings() {
    $('voiceAlertsEnabled').checked = notificationSettings.voiceEnabled;
    $('browserAlertsEnabled').checked = notificationSettings.browserEnabled;
    $('floatingAlertEnabled').checked = notificationSettings.floatingEnabled;
    $('reminderInterval').value = String(notificationSettings.reminderMinutes);
    renderNotificationPermission();
    refreshSettingsStatus();
  }
  function saveCustomerOrdering(enabled) {
    var control = $('customerOrderingEnabled');
    if (!enabled && !window.confirm('Close customer online ordering? Customers will no longer be able to submit new orders. Existing orders will remain in Kahera POS.')) {
      control.checked = true; return;
    }
    control.disabled = true;
    $('customerOrderingFeedback').textContent = 'Saving shared setting…';
    cloud.saveSettings({customerOrderingEnabled:enabled}).then(function(settings){
      control.checked = settings.customerOrderingEnabled;
      $('customerOrderingStatus').textContent = settings.customerOrderingEnabled ? 'OPEN' : 'CLOSED';
      $('customerOrderingStatus').className = 'settings-status ' + (settings.customerOrderingEnabled ? 'is-open' : 'is-closed');
      $('customerOrderingFeedback').textContent = settings.customerOrderingEnabled ? 'Customers can place new online orders.' : 'The customer page is still accessible, but checkout is disabled.';
      toast(settings.customerOrderingEnabled ? 'Customer ordering is now open' : 'Customer ordering is now closed');
    }).catch(function(error){
      control.checked = !enabled;
      $('customerOrderingFeedback').textContent = error.message || 'Could not save customer ordering status.';
      toast('Could not update customer ordering');
    }).finally(function(){control.disabled=false;});
  }
  function refreshSettingsStatus() {
    $('customerOrderingStatus').textContent = 'Checking…';
    $('customerOrderingFeedback').textContent = 'Loading shared setting…';
    $('cloudConnectionStatus').textContent = 'Checking…';
    $('databaseConnectionStatus').textContent = 'Checking…';
    $('systemOverallStatus').textContent = 'Checking…';
    Promise.all([cloud.getSettings(),cloud.getSystemStatus()]).then(function(results){
      var settings=results[0],health=results[1];
      $('customerOrderingEnabled').checked = settings.customerOrderingEnabled;
      $('customerOrderingEnabled').disabled = false;
      $('customerOrderingStatus').textContent = settings.customerOrderingEnabled ? 'OPEN' : 'CLOSED';
      $('customerOrderingStatus').className = 'settings-status ' + (settings.customerOrderingEnabled ? 'is-open' : 'is-closed');
      $('customerOrderingFeedback').textContent = settings.customerOrderingEnabled ? 'Customers can place new online orders.' : 'The customer page is still accessible, but checkout is disabled.';
      $('cloudConnectionStatus').textContent = health.cloud === 'connected' ? 'Connected' : 'Unavailable';
      $('databaseConnectionStatus').textContent = health.database === 'connected' ? 'Connected' : 'Unavailable';
      $('systemOverallStatus').textContent = 'Operational';
      $('systemOverallStatus').className = 'settings-status is-open';
      $('systemCheckedAt').textContent = new Date(health.checkedAt).toLocaleString('en-PH',{dateStyle:'medium',timeStyle:'short'});
      $('systemStatusFeedback').textContent = '';
    }).catch(function(error){
      $('customerOrderingStatus').textContent = 'Unavailable';
      $('customerOrderingStatus').className = 'settings-status is-closed';
      $('customerOrderingFeedback').textContent = error.message || 'Could not load shared settings.';
      $('customerOrderingEnabled').disabled = true;
      $('cloudConnectionStatus').textContent = 'Unavailable';
      $('databaseConnectionStatus').textContent = 'Not verified';
      $('systemOverallStatus').textContent = 'Needs attention';
      $('systemOverallStatus').className = 'settings-status is-closed';
      $('systemStatusFeedback').textContent = error.message || 'Could not reach the cloud service.';
    });
    $('lastSyncStatus').textContent = lastSuccessfulSyncAt ? new Date(lastSuccessfulSyncAt).toLocaleString('en-PH',{dateStyle:'medium',timeStyle:'short'}) : 'Waiting for first successful sync';
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
    renderAll();
    setView(S.view);
    tick(); setInterval(tick, 30000);
    refreshSharedData().catch(function (error) { toast('Cloud sync unavailable: ' + error.message); });
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(function () { refreshSharedData().catch(function () {}); }, 7000);
  }

  var refreshInFlight = false;
  var refreshInterval = null;
  var loginFormBound = false;
  function refreshSharedData() {
    if (refreshInFlight) return Promise.resolve();
    refreshInFlight = true;
    return cloud.getCurrentShift().then(function (shift) {
      S.shift = shift || null;
      return Promise.all([cloud.getOrders(S.shift ? S.shift.id : null), cloud.getNextNo()]);
    }).then(function (results) {
      var previousOnlineIds=S.orders.filter(function(o){return o.source==='online'&&o.status==='unpaid';}).map(function(o){return o.id;});
      var incoming=onlineOrdersInitialized ? results[0].filter(function(o){return o.source==='online'&&o.status==='unpaid'&&previousOnlineIds.indexOf(o.id)===-1;}) : [];
      onlineOrdersInitialized = true;
      S.orders = results[0];
      S.nextNo = results[1];
      lastSuccessfulSyncAt = Date.now();
      if (S.view === 'settings') $('lastSyncStatus').textContent = new Date(lastSuccessfulSyncAt).toLocaleString('en-PH',{dateStyle:'medium',timeStyle:'short'});
      renderFloatingOrderAlert();
      if (!S.orders.some(function(o){ return o.source === 'online' && o.status === 'unpaid'; })) {
        if (orderReminderTimer) clearInterval(orderReminderTimer);
        orderReminderTimer = null;
        orderAlertAcknowledged = false;
      }
      if(incoming.length)announceIncomingOrders(incoming);
      renderBrand();
      if (S.view === 'orders') renderOrders();
      if (S.view === 'shift' && reportRange().to >= manilaToday() && Date.now()-lastReportRefresh>30000) loadReportData();
      renderCart();
    }).catch(function (error) {
      if (/Owner login required/i.test(error && error.message || '')) {
        cloud.logout();
        if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
        showOwnerLogin();
        return;
      }
      throw error;
    }).finally(function () { refreshInFlight = false; });
  }

  function showOwnerLogin(){
    var panel=document.getElementById('owner-login'),form=document.getElementById('owner-login-form'),error=document.getElementById('owner-login-error');
    root.hidden=true;panel.hidden=false;
    if (loginFormBound) return;
    loginFormBound = true;
    form.addEventListener('submit',function(event){
      event.preventDefault();
      var button=form.querySelector('button[type="submit"]'),password=document.getElementById('owner-password').value;
      error.textContent='';button.disabled=true;button.textContent='Signing in…';
      cloud.login(password).then(function(){
        return cloud.getMenu().then(function(remote){
          var shared=normalizeSharedMenu(remote);SAMPLE.settings=shared.settings;SAMPLE.categories=shared.categories;SAMPLE.menu=shared.menu;sharedMenuReady=true;
          panel.hidden=true;root.hidden=false;startApp();
        });
      }).catch(function(err){cloud.logout();error.textContent=err.message||'Unable to sign in.';}).finally(function(){button.disabled=false;button.textContent='Sign in';});
    });
  }
  cloud.checkSession().then(function(authenticated){
    if(!authenticated){showOwnerLogin();return;}
    cloud.getMenu().then(function(remote){
      var shared=normalizeSharedMenu(remote);SAMPLE.settings=shared.settings;SAMPLE.categories=shared.categories;SAMPLE.menu=shared.menu;sharedMenuReady=true;root.hidden=false;startApp();
    }).catch(function(err){
      if (/Owner login required/i.test(err && err.message || '')) {
        cloud.logout();
        showOwnerLogin();
        return;
      }
      sharedMenuReady=false;root.hidden=false;startApp();toast('Shared menu unavailable: '+err.message+'. Menu editing is paused to protect saved items.');
    });
  }).catch(showOwnerLogin);
})();
