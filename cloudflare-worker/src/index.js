const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
function json(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } }); }
function b64(bytes) { let s=''; new Uint8Array(bytes).forEach(b=>s+=String.fromCharCode(b)); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); }
function unb64(v) { const s=v.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-v.length%4)%4); return Uint8Array.from(atob(s),c=>c.charCodeAt(0)); }
async function mac(v, secret) { if(!secret) throw new Error('SESSION_SECRET is not configured.'); const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(v))); }
async function makeToken(secret) { const p=b64(new TextEncoder().encode(JSON.stringify({role:'admin',exp:Math.floor(Date.now()/1000)+28800}))); return p+'.'+b64(await mac(p,secret)); }
async function isAdmin(token,secret) { if(!token||!secret)return false; const a=token.split('.'); if(a.length!==2)return false; try { const expected=await mac(a[0],secret), actual=unb64(a[1]); if(actual.length!==expected.length)return false; let d=0; for(let i=0;i<actual.length;i++)d|=actual[i]^expected[i]; if(d)return false; const p=JSON.parse(new TextDecoder().decode(unb64(a[0]))); return p.role==='admin'&&p.exp>Date.now()/1000; } catch(_){return false;} }
function eq(a,b) { a=String(a||'');b=String(b||'');let d=a.length^b.length,n=Math.max(a.length,b.length);for(let i=0;i<n;i++)d|=(a.charCodeAt(i%(a.length||1))||0)^(b.charCodeAt(i%(b.length||1))||0);return d===0; }
function corsOrigin(req,env) { const o=req.headers.get('Origin')||'';return (env.APP_ORIGINS||'').split(',').map(x=>x.trim()).includes(o)?o:''; }
function cors(o) { return o?{'Access-Control-Allow-Origin':o,'Vary':'Origin','Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'86400'}:{}; }
function bearer(r) { const h=r.headers.get('Authorization')||'';return h.startsWith('Bearer ')?h.slice(7):''; }
function uuid(){return crypto.randomUUID();}
function pad(n){return String(n).padStart(4,'0');}
function text(v,max){return typeof v==='string'&&v.trim().length>0&&v.length<=max;}
async function menu(db) {
  const s=await db.prepare('SELECT settings_json FROM store_settings WHERE id=1').first();
  if(!s)throw new Error('Shared menu is not initialized. Run migration 0002_seed_shared_menu.sql against the remote D1 database.');
  const c=await db.prepare('SELECT id,name FROM menu_categories ORDER BY sort_order,name').all();
  const m=await db.prepare('SELECT id,category_id AS cat,name,price,half_price AS halfPrice,image_data AS image,available,sold_out AS soldOut,variants_json AS variantsJson FROM menu_items ORDER BY sort_order,name').all();
  return {settings:JSON.parse(s.settings_json),categories:c.results||[],menu:(m.results||[]).map(x=>({...x,halfPrice:x.halfPrice===null?null:x.halfPrice,variants:JSON.parse(x.variantsJson||'[]'),image:x.image||'',available:!!x.available,soldOut:!!x.soldOut}))};
}
function validateMenu(b) {
  if(!b||!b.settings||!Array.isArray(b.categories)||!Array.isArray(b.menu))throw new Error('Menu payload is incomplete.');
  if(b.menu.length>500||b.categories.length>30)throw new Error('Menu exceeds the allowed limit.');
  const cats=new Map(),items=new Set();
  for(const c of b.categories){if(!c||!text(c.id,80)||!text(c.name,60)||cats.has(c.id))throw new Error('A menu category is invalid.');cats.set(c.id,c.name);}
  for(const m of b.menu){
    if(!m||!text(m.id,80)||items.has(m.id)||!text(m.name,40)||!cats.has(m.cat)||!Number.isSafeInteger(m.price)||m.price<1||m.price>100000000||!(m.halfPrice===null||m.halfPrice===undefined||(Number.isSafeInteger(m.halfPrice)&&m.halfPrice>0&&m.halfPrice<=m.price))||typeof m.available!=='boolean'||!(m.soldOut===undefined||typeof m.soldOut==='boolean')||!(m.image===undefined||m.image===null||m.image===''||(typeof m.image==='string'&&m.image.length<=120000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(m.image))))throw new Error('A menu item is invalid.');
    const variants=Array.isArray(m.variants)?m.variants:[];
    const isDrinks=/^(drinks?|beverages?)$/i.test(String(cats.get(m.cat)).trim())||/^(drinks?|beverages?)$/i.test(String(m.cat).trim());
    if(variants.length&&!isDrinks)throw new Error('Price options can only be added to Drinks items.');
    if(isDrinks&&(!variants.length||m.halfPrice!==null&&m.halfPrice!==undefined||m.price!==variants[0].price))throw new Error('Drinks must use individual variants only, without default or half-order prices.');
    if(variants.length>20)throw new Error('A menu item can have no more than 20 price options.');
    const variantIds=new Set(),variantNames=new Set();
    for(const v of variants){if(!v||!text(v.id,80)||variantIds.has(v.id)||!text(v.name,30)||variantNames.has(v.name.toLowerCase())||!Number.isSafeInteger(v.price)||v.price<1||v.price>100000000||!(v.available===undefined||typeof v.available==='boolean')||!(v.soldOut===undefined||typeof v.soldOut==='boolean'))throw new Error('A menu drink variant is invalid.');variantIds.add(v.id);variantNames.add(v.name.toLowerCase());}
    items.add(m.id);
  }
  if(typeof b.settings.bizName!=='string'||typeof b.settings.bizNote!=='string'||typeof b.settings.vatRegistered!=='boolean')throw new Error('Store settings are invalid.');
}
async function saveMenu(db,b) {
  validateMenu(b);
  const q=[db.prepare('DELETE FROM menu_items'),db.prepare('DELETE FROM menu_categories'),db.prepare('INSERT OR REPLACE INTO store_settings(id,settings_json,updated_at) VALUES(1,?,CURRENT_TIMESTAMP)').bind(JSON.stringify(b.settings))];
  b.categories.forEach((c,i)=>q.push(db.prepare('INSERT INTO menu_categories(id,name,sort_order) VALUES(?,?,?)').bind(c.id,c.name.trim(),i)));
  b.menu.forEach((m,i)=>q.push(db.prepare('INSERT INTO menu_items(id,category_id,name,price,half_price,image_data,available,sold_out,sort_order,variants_json) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(m.id,m.cat,m.name.trim(),m.price,m.halfPrice||null,m.image||null,m.available?1:0,m.soldOut?1:0,i,JSON.stringify(m.variants||[]))));
  await db.batch(q);
}
function manilaParts(date=new Date()) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const out={};parts.forEach(p=>{if(p.type!=='literal')out[p.type]=p.value;});
  return {date:out.year+'-'+out.month+'-'+out.day,hour:Number(out.hour),minute:Number(out.minute)};
}
function isWeekday(dateText) {
  const day=new Date(dateText+'T00:00:00Z').getUTCDay();
  return day>=1&&day<=5;
}
async function currentShift(db) {
  return db.prepare("SELECT id,device_id,started_at,ended_at,status,report_date,close_reason FROM shifts WHERE status='open' LIMIT 1").first();
}
async function ensureDailyReport(db,deviceId,now=new Date()) {
  const local=manilaParts(now);
  if(!isWeekday(local.date)||local.hour<7)return currentShift(db);
  let active=await currentShift(db);
  if(active && active.report_date===local.date)return active;
  if(active && (!active.report_date || active.report_date<local.date)) {
    await db.prepare("UPDATE shifts SET status='closed',ended_at=?,close_reason='automatic_midnight' WHERE id=? AND status='open'")
      .bind(now.toISOString(),active.id).run();
    active=null;
  }
  const alreadyCreated=await db.prepare("SELECT id,status FROM shifts WHERE report_date=? LIMIT 1").bind(local.date).first();
  if(alreadyCreated)return currentShift(db);
  try {
    await db.prepare("INSERT INTO shifts(id,device_id,started_at,status,report_date) VALUES(?,?,?,'open',?)")
      .bind(uuid(),deviceId||'scheduled-opening',now.toISOString(),local.date).run();
  } catch(error) {
    active=await currentShift(db);
    if(active)return active;
    throw error;
  }
  return currentShift(db);
}
async function runDailySchedule(db,now=new Date()) {
  const local=manilaParts(now);
  const active=await currentShift(db);
  if(active && active.report_date && active.report_date<local.date) {
    await db.prepare("UPDATE shifts SET status='closed',ended_at=?,close_reason='automatic_midnight' WHERE id=? AND status='open'")
      .bind(now.toISOString(),active.id).run();
  }
  if(isWeekday(local.date) && local.hour>=7) {
    const alreadyCreated=await db.prepare("SELECT id FROM shifts WHERE report_date=? LIMIT 1").bind(local.date).first();
    if(!alreadyCreated && !(await currentShift(db))) {
      try {
        await db.prepare("INSERT INTO shifts(id,device_id,started_at,status,report_date) VALUES(?,?,?,'open',?)")
          .bind(uuid(),'scheduled-opening',now.toISOString(),local.date).run();
      } catch(error) {
        if(!(await currentShift(db)))throw error;
      }
    }
  }
}
function rowOrder(r){const o=JSON.parse(r.payload_json);o.status=r.status;if(r.voided_at)o.voidedAt=Date.parse(r.voided_at);return o;}
async function orders(db,shiftId) {
  if(!shiftId){const s=await currentShift(db);if(!s)return [];shiftId=s.id;}
  const r=await db.prepare('SELECT payload_json,status,voided_at FROM orders WHERE shift_id=? ORDER BY created_at,order_no').bind(shiftId).all();
  return (r.results||[]).map(rowOrder);
}
async function reportData(db,from,to) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)throw new Error('Choose a valid reporting date range.');
  const days=await db.prepare("SELECT s.id,s.report_date AS date,s.started_at AS startedAt,s.ended_at AS endedAt,s.status,s.close_reason AS closeReason,COUNT(o.id) AS orderCount FROM shifts s LEFT JOIN orders o ON o.shift_id=s.id WHERE s.report_date BETWEEN ? AND ? GROUP BY s.id ORDER BY s.report_date").bind(from,to).all();
  const rows=await db.prepare("SELECT o.payload_json,o.status,o.voided_at,COALESCE(s.report_date,date(o.created_at,'+8 hours')) AS reportDate FROM orders o LEFT JOIN shifts s ON s.id=o.shift_id WHERE COALESCE(s.report_date,date(o.created_at,'+8 hours')) BETWEEN ? AND ? ORDER BY o.created_at,o.order_no").bind(from,to).all();
  return {days:days.results||[],orders:(rows.results||[]).map(r=>({...rowOrder(r),reportDate:r.reportDate||''}))};
}
function calculateTotals(lines, settings, kind, diners, holders) {
  const vatReg = settings.vatRegistered !== false;
  const gross = lines.reduce((sum, line) => sum + line.price * line.qty, 0);
  diners = Math.max(1, Math.min(99, Number.parseInt(diners, 10) || 1));
  holders = Math.max(0, Math.min(diners, Number.parseInt(holders, 10) || 0));
  kind = kind === 'senior' || kind === 'pwd' ? kind : 'none';
  const result = {
    gross, items: lines.reduce((n, line) => n + line.qty, 0), discountKind: 'none',
    diners, idHolders: 0, share: 0, vatRemoved: 0, discount: 0,
    vatable: 0, vat: 0, vatExemptSales: 0, total: gross, vatRegistered: vatReg
  };
  let regular = gross;
  if (kind !== 'none' && holders > 0 && gross > 0) {
    const share = Math.round(gross * holders / diners);
    const base = vatReg ? Math.round(share / 1.12) : share;
    const discount = Math.round(base * 0.20);
    regular = gross - share;
    result.discountKind = kind;
    result.idHolders = holders;
    result.share = share;
    result.vatRemoved = share - base;
    result.discount = discount;
    result.vatExemptSales = vatReg ? base : 0;
    result.total = regular + base - discount;
  }
  if (vatReg) {
    result.vatable = Math.round(regular / 1.12);
    result.vat = regular - result.vatable;
  }
  return result;
}
function validateOrder(b) {
  if (!b || !text(b.id, 80) || !['dine', 'take'].includes(b.type) ||
      !Array.isArray(b.lines) || !b.lines.length || b.lines.length > 50) throw new Error('Order details are incomplete.');
  for (const line of b.lines) {
    if (!line || !text(line.id, 80) || !['full','half'].includes(line.portion || 'full') || !Number.isInteger(line.qty) || line.qty < 1 || line.qty > 99) throw new Error('An order item is invalid.');
  }
  if (!b.totals || !['none', 'senior', 'pwd'].includes(b.totals.discountKind) ||
      !Number.isInteger(b.totals.diners) || b.totals.diners < 1 || b.totals.diners > 99 || !Number.isInteger(b.totals.idHolders) || b.totals.idHolders < 0 || b.totals.idHolders > b.totals.diners) throw new Error('Discount details are invalid.');
  if (!['cash', 'ewallet', 'card'].includes(b.method) ||
      !Number.isSafeInteger(b.tendered) || b.tendered < 1) throw new Error('Payment details are invalid.');
  if (b.method !== 'cash' && !text(b.ref, 40)) throw new Error('Payment reference is required.');
}
async function createOrder(db,b,deviceId) {
  validateOrder(b);
  let existing = await db.prepare('SELECT payload_json,status,voided_at FROM orders WHERE id=?').bind(b.id).first();
  if (existing) return rowOrder(existing);
  const menuRows = [];
  for (const line of b.lines) {
    const item = await db.prepare('SELECT id,name,price,half_price AS halfPrice,available,sold_out AS soldOut,variants_json AS variantsJson FROM menu_items WHERE id=?').bind(line.id).first();
    if (!item || !item.available) throw new Error('A selected menu item is not available today. Refresh the menu and review the cart.');
    if (item.soldOut) throw new Error('A selected menu item is sold out. Refresh the menu and review the cart.');
    const portion = line.portion === 'half' ? 'half' : 'full';
    const variants = JSON.parse(item.variantsJson || '[]');
    let officialPrice = portion === 'half' ? item.halfPrice : item.price;
    let variantName = '';
    if (line.variantId) {
      const selected = variants.find(v => v.id === line.variantId);
      if (!selected || selected.available===false || line.optionPrice !== selected.price) throw new Error('A selected drink size is no longer available or its price changed. Refresh the menu and review the cart.');
      officialPrice = selected.price;
      variantName = selected.name;
    }
    if (officialPrice === null || officialPrice === undefined) throw new Error('A half-order price is not configured for this menu item.');
    if (!Number.isSafeInteger(line.price) || line.price < 1 || line.price > 100000000) throw new Error('An adjusted item price is invalid.');
    menuRows.push({ id:item.id, name:item.name, price:line.price, qty:line.qty, portion:portion, variantId:line.variantId||null, variantName:variantName || line.variantName || '' });
  }
  const settingsRow = await db.prepare('SELECT settings_json FROM store_settings WHERE id=1').first();
  if (!settingsRow) throw new Error('The shared menu is not initialized.');
  const settings = JSON.parse(settingsRow.settings_json);
  const totals = calculateTotals(menuRows, settings, b.totals.discountKind, b.totals.diners, b.totals.idHolders);
  if (b.totals.total !== totals.total || b.totals.discountKind !== totals.discountKind) throw new Error('The order total does not match the official menu and discount calculation. Review the cart.');
  if (b.method !== 'cash' && b.tendered !== totals.total) throw new Error('For non-cash payments, the amount must match the order total.');
  const shift = await currentShift(db);
  if(!shift || shift.status!=='open') throw new Error('No daily report is open. Sales are disabled until the next report opens.');
  const counter = await db.prepare('UPDATE order_counters SET value=value+1 WHERE id=1 RETURNING value').first();
  if (!counter) throw new Error('Order counter is missing. Run the D1 migration.');
  const ts=Date.now(), no='K-'+pad(counter.value);
  const order={
    id:b.id,no,ts,type:b.type,table:b.type==='dine'?String(b.table||'').slice(0,3):'',
    lines:menuRows,totals,method:b.method,tendered:b.tendered,change:b.tendered-totals.total,
    ref:b.ref||'',status:'paid',shiftId:shift.id
  };
  const statements=[
    db.prepare('INSERT INTO orders(id,order_no,shift_id,device_id,created_at,order_type,table_no,payment_method,payment_reference,tendered,change_amount,status,totals_json,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(order.id,order.no,shift.id,deviceId||'unknown',new Date(ts).toISOString(),order.type,order.table,order.method,order.ref,order.tendered,order.change,'paid',JSON.stringify(order.totals),JSON.stringify(order))
  ];
  order.lines.forEach(line=>statements.push(
    db.prepare('INSERT INTO order_items(order_id,menu_item_id,item_name,unit_price,quantity,line_total,portion) VALUES(?,?,?,?,?,?,?)')
      .bind(order.id,line.id,line.name,line.price,line.qty,line.price*line.qty,line.portion||'full')
  ));
  try { await db.batch(statements); }
  catch(error) {
    existing=await db.prepare('SELECT payload_json,status,voided_at FROM orders WHERE id=?').bind(b.id).first();
    if(existing)return rowOrder(existing);
    throw error;
  }
  return order;
}
export default {
 async fetch(request,env) {
  const origin=corsOrigin(request,env);
  if(request.method==='OPTIONS'){if(!origin)return json({error:'Origin is not allowed.'},403);return new Response(null,{status:204,headers:cors(origin)});}
  if(request.headers.has('Origin')&&!origin)return json({error:'Origin is not allowed.'},403);
  const h=cors(origin),u=new URL(request.url),db=env.kahera_db;
  try {
   if(!db)return json({error:'Cloudflare D1 binding kahera_db is missing.'},500,h);
   await runDailySchedule(db,new Date());
   if(u.pathname==='/api/menu'&&request.method==='GET')return json(await menu(db),200,h);
   if(u.pathname==='/api/menu'&&request.method==='PUT'){await saveMenu(db,await request.json());return json({ok:true,message:'Shared menu saved to Cloudflare D1.'},200,h);}
   if(u.pathname==='/api/shifts/current'&&request.method==='GET')return json({shift:await currentShift(db)},200,h);
   if(u.pathname==='/api/reports'&&request.method==='GET')return json(await reportData(db,u.searchParams.get('from')||'',u.searchParams.get('to')||''),200,h);
   if(u.pathname==='/api/orders/next-number'&&request.method==='GET'){const c=await db.prepare('SELECT value FROM order_counters WHERE id=1').first();return json({no:'K-'+pad((c?c.value:0)+1)},200,h);}
   if(u.pathname==='/api/orders'&&request.method==='GET')return json({orders:await orders(db,u.searchParams.get('shiftId')||'')},200,h);
   if(u.pathname==='/api/orders'&&request.method==='POST'){const b=await request.json();return json({order:await createOrder(db,b,b.deviceId||'unknown')},201,h);}
   const v=u.pathname.match(/^\/api\/orders\/([^/]+)\/void$/);
   if(v&&request.method==='POST'){const oid=decodeURIComponent(v[1]);const r=await db.prepare('SELECT payload_json,status,voided_at FROM orders WHERE id=?').bind(oid).first();if(!r)return json({error:'Order not found.'},404,h);if(r.status==='void')return json({order:rowOrder(r)},200,h);const o=rowOrder(r);o.status='void';o.voidedAt=Date.now();await db.prepare("UPDATE orders SET status='void',voided_at=?,payload_json=? WHERE id=?").bind(new Date(o.voidedAt).toISOString(),JSON.stringify(o),oid).run();return json({order:o},200,h);}
   return json({error:'Not found.'},404,h);
  } catch(e){const message=e.message||'Unexpected server error.';return json({error:message},message.indexOf('No daily report is open')===0?409:500,h);}
 },
 async scheduled(controller,env) {
   await runDailySchedule(env.kahera_db,new Date(controller.scheduledTime));
 }
};
