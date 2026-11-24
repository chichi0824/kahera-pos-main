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
async function storedOwnerPassword(db,password,env){
  const row=await db.prepare('SELECT salt,password_hash AS passwordHash FROM admin_credentials WHERE id=1').first();
  if(row){const actual=await hashOwnerPassword(password,row.salt);return eq(actual,row.passwordHash);}
  return text(env.ADMIN_PASSWORD,200)&&eq(password,env.ADMIN_PASSWORD);
}
async function hashOwnerPassword(password,saltText){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:unb64(saltText),iterations:150000,hash:'SHA-256'},key,256);
  return b64(new Uint8Array(bits));
}
async function setOwnerPassword(db,password){
  const salt=b64(crypto.getRandomValues(new Uint8Array(16)));
  const passwordHash=await hashOwnerPassword(password,salt);
  await db.prepare('INSERT OR REPLACE INTO admin_credentials(id,salt,password_hash,updated_at) VALUES(1,?,?,CURRENT_TIMESTAMP)').bind(salt,passwordHash).run();
}
async function getAppSettings(db){
  const row=await db.prepare('SELECT customer_ordering_enabled AS customerOrderingEnabled,updated_at AS updatedAt FROM app_settings WHERE id=1').first();
  if(!row)throw new Error('Application settings are not initialized. Apply migration 0003_owner_settings.sql to D1.');
  return {customerOrderingEnabled:!!row.customerOrderingEnabled,updatedAt:row.updatedAt||null};
}
async function saveAppSettings(db,body){
  if(!body||typeof body.customerOrderingEnabled!=='boolean')throw new Error('Customer ordering status is invalid.');
  await db.prepare('UPDATE app_settings SET customer_ordering_enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=1').bind(body.customerOrderingEnabled?1:0).run();
  return getAppSettings(db);
}
async function menu(db) {
  const s=await db.prepare('SELECT settings_json FROM store_settings WHERE id=1').first();
  if(!s)throw new Error('Shared menu is not initialized. Run migration 0002_seed_shared_menu.sql against the remote D1 database.');
  const c=await db.prepare('SELECT id,name FROM menu_categories ORDER BY sort_order,name').all();
  const m=await db.prepare('SELECT id,category_id AS cat,name,price,half_price AS halfPrice,image_data AS image,available,sold_out AS soldOut,variants_json AS variantsJson FROM menu_items ORDER BY sort_order,name').all();
  return {settings:JSON.parse(s.settings_json),categories:c.results||[],menu:(m.results||[]).map(x=>({...x,halfPrice:x.halfPrice===null?null:x.halfPrice,variants:JSON.parse(x.variantsJson||'[]'),image:x.image||'',available:!!x.available,soldOut:!!x.soldOut}))};
}
export function validateMenu(b) {
  if(!b||!b.settings||!Array.isArray(b.categories)||!Array.isArray(b.menu))throw new Error('Menu payload is incomplete.');
  if(b.menu.length>500||b.categories.length>30)throw new Error('Menu exceeds the allowed limit.');
  const cats=new Map(),items=new Set();
  for(const c of b.categories){if(!c||!text(c.id,80)||!text(c.name,60)||cats.has(c.id))throw new Error('A menu category is invalid.');cats.set(c.id,c.name);}
  for(const m of b.menu){
    if(!m||!text(m.id,80)||items.has(m.id)||!text(m.name,40)||!cats.has(m.cat)||!Number.isSafeInteger(m.price)||m.price<1||m.price>100000000||!(m.halfPrice===null||m.halfPrice===undefined||(Number.isSafeInteger(m.halfPrice)&&m.halfPrice>0&&m.halfPrice<=m.price))||typeof m.available!=='boolean'||!(m.soldOut===undefined||typeof m.soldOut==='boolean')||!(m.image===undefined||m.image===null||m.image===''||(typeof m.image==='string'&&m.image.length<=120000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(m.image))))throw new Error('A menu item is invalid.');
    const variants=Array.isArray(m.variants)?m.variants:[];
    const isDrinks=/^(drinks?|beverages?)$/i.test(String(cats.get(m.cat)).trim())||/^(drinks?|beverages?)$/i.test(String(m.cat).trim());
    if(variants.length>20)throw new Error('A menu item can have no more than 20 price options.');
    if(isDrinks&&!variants.length)throw new Error('Drinks must have at least one price option.');
    if(variants.length&&(m.halfPrice!==null&&m.halfPrice!==undefined||m.price!==variants[0].price))throw new Error('Items with price options must use the first option as the base price and cannot have a half-order price.');
    const variantIds=new Set(),variantNames=new Set();
    for(const v of variants){if(!v||!text(v.id,80)||variantIds.has(v.id)||!text(v.name,30)||variantNames.has(v.name.toLowerCase())||!Number.isSafeInteger(v.price)||v.price<1||v.price>100000000||!(v.available===undefined||typeof v.available==='boolean')||!(v.soldOut===undefined||typeof v.soldOut==='boolean'))throw new Error('A menu price option is invalid.');variantIds.add(v.id);variantNames.add(v.name.toLowerCase());}
    items.add(m.id);
  }
  if(typeof b.settings.bizName!=='string'||typeof b.settings.bizNote!=='string'||typeof b.settings.vatRegistered!=='boolean'||!(b.settings.brandIcon===undefined||b.settings.brandIcon===''||(typeof b.settings.brandIcon==='string'&&b.settings.brandIcon.length<=120000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(b.settings.brandIcon))))throw new Error('Store settings are invalid.');
}
export async function saveMenu(db,b) {
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
  // A report is created every calendar day; it must never gate Register access.
  let active=await currentShift(db);
  if(active && active.report_date===local.date)return active;
  if(active && (!active.report_date || active.report_date<local.date)) {
    await db.prepare("UPDATE shifts SET status='closed',ended_at=?,close_reason='automatic_midnight' WHERE id=? AND status='open'")
      .bind(now.toISOString(),active.id).run();
    active=null;
  }
  const alreadyCreated=await db.prepare("SELECT id,status FROM shifts WHERE report_date=? LIMIT 1").bind(local.date).first();
  if(alreadyCreated){
    // A daily report record must never prevent a sale. Reopen today's report
    // if an earlier/legacy deployment left it closed.
    if(alreadyCreated.status!=='open'){
      await db.prepare("UPDATE shifts SET status='open',ended_at=NULL,close_reason=NULL WHERE id=?").bind(alreadyCreated.id).run();
    }
    return currentShift(db);
  }
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
  {
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
export function validateOnlineOrder(b) {
  if(!b||!text(b.id,80)||!/^[a-zA-Z0-9-]{8,80}$/.test(b.id)||!text(b.customerName,80)||!text(b.customerPhone,30)||!['pickup','delivery'].includes(b.fulfillmentType)||!Array.isArray(b.lines)||!b.lines.length||b.lines.length>50)throw new Error('Please complete your name, contact number, order type, and items.');
  const address=text(b.deliveryAddress,240)?b.deliveryAddress.trim():'';
  const contactRequested=b.deliveryContactRequested===true;
  if(b.fulfillmentType==='delivery'&&!address&&!contactRequested)throw new Error('Enter your delivery address or ask the store to contact you to confirm it.');
  if(b.fulfillmentType==='pickup'&&(address||contactRequested))throw new Error('Pickup orders do not need delivery details.');
  return {address,contactRequested};
}
async function createOnlineOrder(db,b) {
  const details=validateOnlineOrder(b);

  const address=details.address,contactRequested=details.contactRequested;
  const existing=await db.prepare('SELECT payload_json,status,voided_at FROM orders WHERE id=?').bind(b.id).first();
  if(existing)return rowOrder(existing);
  const availability=await getAppSettings(db);
  if(!availability.customerOrderingEnabled)throw new Error('Online ordering is temporarily closed. Please check back later.');
  const lines=[];
  for(const line of b.lines){
    if(!line||!text(line.id,80)||!Number.isInteger(line.qty)||line.qty<1||line.qty>30||!(line.portion===undefined||['full','half'].includes(line.portion)))throw new Error('An order item is invalid.');
    const item=await db.prepare('SELECT m.id,m.category_id AS categoryId,c.name AS categoryName,m.name,m.price,m.half_price AS halfPrice,m.available,m.sold_out AS soldOut,m.variants_json AS variantsJson FROM menu_items m LEFT JOIN menu_categories c ON c.id=m.category_id WHERE m.id=?').bind(line.id).first();
    if(!item||!item.available||item.soldOut)throw new Error('A selected item is unavailable. Refresh the menu and review your cart.');
    const variants=JSON.parse(item.variantsJson||'[]');
    let price=line.portion==='half'?item.halfPrice:item.price,variantName='';
    if(variants.length){
      if(!text(line.variantId,80))throw new Error('Choose a valid price option.');
      const v=variants.find(x=>x.id===line.variantId);
      if(!v||v.available===false||v.soldOut===true)throw new Error('A selected price option is unavailable. Refresh the menu.');
      price=v.price;variantName=v.name;
    }else if(line.variantId)throw new Error('A selected price option is invalid.');
    if(!Number.isSafeInteger(price)||price<1)throw new Error('The selected item price is invalid.');
    lines.push({id:item.id,name:item.name,categoryId:item.categoryId||null,categoryName:item.categoryName||'Uncategorized',price,qty:line.qty,portion:variants.length?'full':(line.portion==='half'?'half':'full'),variantId:line.variantId||null,variantName,priceOverridden:false});
  }
  const settingsRow=await db.prepare('SELECT settings_json FROM store_settings WHERE id=1').first();
  if(!settingsRow)throw new Error('The shared menu is not initialized.');
  const totals=calculateTotals(lines,JSON.parse(settingsRow.settings_json),'none',1,0);
  const shift=await currentShift(db);
  const counter=await db.prepare('UPDATE order_counters SET value=value+1 WHERE id=1 RETURNING value').first();
  if(!counter)throw new Error('Order counter is missing. Run the D1 migration.');
  const ts=Date.now(),no='K-'+pad(counter.value);
  const order={id:b.id,no,ts,type:'take',table:'',lines,totals,method:'cash',tendered:0,change:0,ref:'',status:'unpaid',shiftId:shift?shift.id:null,source:'online',customerName:b.customerName.trim(),customerPhone:b.customerPhone.trim(),fulfillmentType:b.fulfillmentType,deliveryAddress:address,deliveryContactRequested:contactRequested,hasPaymentProof:false};
  const statements=[db.prepare("INSERT INTO orders(id,order_no,shift_id,device_id,created_at,order_type,table_no,payment_method,payment_reference,tendered,change_amount,status,totals_json,payload_json,source,customer_name,customer_phone,fulfillment_type,delivery_address,delivery_contact_requested) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(order.id,order.no,order.shiftId,'online',new Date(ts).toISOString(),'take','', 'cash','',0,0,'unpaid',JSON.stringify(totals),JSON.stringify(order),'online',order.customerName,order.customerPhone,order.fulfillmentType,order.deliveryAddress,contactRequested?1:0)];
  lines.forEach(line=>statements.push(db.prepare('INSERT INTO order_items(order_id,menu_item_id,item_name,unit_price,quantity,line_total,portion) VALUES(?,?,?,?,?,?,?)').bind(order.id,line.id,line.name,line.price,line.qty,line.lineTotalOverridden === true ? line.lineTotal : line.price*line.qty,line.portion)));
  try{await db.batch(statements);}catch(error){const duplicate=await db.prepare('SELECT payload_json,status,voided_at FROM orders WHERE id=?').bind(b.id).first();if(duplicate)return rowOrder(duplicate);throw error;}
  return order;
}
async function markOnlineOrderPaid(db,id,payment){
  const row=await db.prepare('SELECT payload_json,status,source FROM orders WHERE id=?').bind(id).first();
  if(!row)throw new Error('Order not found.');
  if(row.source!=='online')throw new Error('Only online orders can be marked paid here.');
  if(row.status==='paid')return rowOrder(row);
  if(row.status!=='unpaid')throw new Error('This order cannot be marked paid.');
  const method=payment&&payment.method==='ewallet'?'ewallet':'cash';
  const ref=method==='ewallet'&&typeof payment.ref==='string'?payment.ref.trim():'';
  const proof=method==='ewallet'&&typeof payment.paymentProof==='string'?payment.paymentProof:'';
  if(ref.length>40)throw new Error('Payment reference must be 40 characters or fewer.');
  if(proof&&(!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(proof)||proof.length>650000))throw new Error('E-wallet receipt image is invalid or too large.');
  const order=JSON.parse(row.payload_json);
  order.status='paid';order.paidAt=Date.now();order.method=method;order.ref=ref;order.tendered=order.totals.total;order.change=0;order.hasPaymentProof=!!proof;
  await db.prepare("UPDATE orders SET status='paid',payment_method=?,payment_reference=?,tendered=?,change_amount=0,payment_proof=?,payload_json=? WHERE id=? AND status='unpaid'")
    .bind(method,ref,order.tendered,proof||null,JSON.stringify(order),id).run();
  return order;
}

async function orders(db,shiftId) {
  if(shiftId){
    const r=await db.prepare("SELECT payload_json,status,voided_at FROM orders WHERE shift_id=? OR (source='online' AND status='unpaid') ORDER BY created_at,order_no").bind(shiftId).all();
    return (r.results||[]).map(rowOrder);
  }
  const today=manilaParts().date;
  const r=await db.prepare("SELECT payload_json,status,voided_at FROM orders WHERE COALESCE(date(created_at,'+8 hours'), '')=? OR (source='online' AND status='unpaid') ORDER BY created_at,order_no").bind(today).all();
  return (r.results||[]).map(rowOrder);
}
async function reportData(db,from,to) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)throw new Error('Choose a valid reporting date range.');
  const days=await db.prepare("SELECT s.id,s.report_date AS date,s.started_at AS startedAt,s.ended_at AS endedAt,s.status,s.close_reason AS closeReason,COUNT(CASE WHEN o.status!='unpaid' THEN o.id END) AS orderCount FROM shifts s LEFT JOIN orders o ON o.shift_id=s.id WHERE s.report_date BETWEEN ? AND ? GROUP BY s.id ORDER BY s.report_date").bind(from,to).all();
  const rows=await db.prepare("SELECT o.payload_json,o.status,o.voided_at,o.payment_proof,COALESCE(s.report_date,date(o.created_at,'+8 hours')) AS reportDate FROM orders o LEFT JOIN shifts s ON s.id=o.shift_id WHERE o.status!='unpaid' AND COALESCE(s.report_date,date(o.created_at,'+8 hours')) BETWEEN ? AND ? ORDER BY o.created_at,o.order_no").bind(from,to).all();
  const categoryRows=await db.prepare('SELECT m.id,c.name AS categoryName FROM menu_items m LEFT JOIN menu_categories c ON c.id=m.category_id').all();
  const categoryByItem={};(categoryRows.results||[]).forEach(row=>{categoryByItem[row.id]=row.categoryName||'Uncategorized';});
  const orders=(rows.results||[]).map(r=>{
    const order={...rowOrder(r),reportDate:r.reportDate||'',hasPaymentProof:!!r.payment_proof};
    order.lines=(order.lines||[]).map(line=>({...line,categoryName:line.categoryName||categoryByItem[line.id]||'Uncategorized'}));
    return order;
  });
  return {days:days.results||[],orders};
}
function calculateTotals(lines, settings, kind, diners, holders) {
  const vatReg = settings.vatRegistered !== false;
  const gross = lines.reduce((sum, line) => sum + (line.lineTotalOverridden === true ? line.lineTotal : line.price * line.qty), 0);
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
    if (!line || !text(line.id, 80) || !['full','half'].includes(line.portion || 'full') || !Number.isInteger(line.qty) || line.qty < 1 || line.qty > 99 || (line.lineTotalOverridden === true && (!Number.isSafeInteger(line.lineTotal) || line.lineTotal < 1 || line.lineTotal > 10000000000))) throw new Error('An order item is invalid.');
  }
  if (!b.totals || !['none', 'senior', 'pwd'].includes(b.totals.discountKind) ||
      !Number.isInteger(b.totals.diners) || b.totals.diners < 1 || b.totals.diners > 99 || !Number.isInteger(b.totals.idHolders) || b.totals.idHolders < 0 || b.totals.idHolders > b.totals.diners) throw new Error('Discount details are invalid.');
  if (!['cash', 'ewallet', 'card'].includes(b.method) ||
      !Number.isSafeInteger(b.tendered) || b.tendered < 1) throw new Error('Payment details are invalid.');
  if (b.method !== 'cash' && !(b.method === 'ewallet' && typeof b.paymentProof==='string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(b.paymentProof) && b.paymentProof.length<=650000) && !text(b.ref, 40)) throw new Error('Payment reference is required, or attach an e-wallet payment proof photo.');
  if (b.paymentProof && (b.method!=='ewallet' || typeof b.paymentProof!=='string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(b.paymentProof) || b.paymentProof.length>650000)) throw new Error('E-wallet payment proof photo is invalid or too large.');
}
async function createOrder(db,b,deviceId) {
  validateOrder(b);
  let existing = await db.prepare('SELECT payload_json,status,voided_at FROM orders WHERE id=?').bind(b.id).first();
  if (existing) return rowOrder(existing);
  const menuRows = [];
  for (const line of b.lines) {
    const item = await db.prepare('SELECT m.id,m.category_id AS categoryId,c.name AS categoryName,m.name,m.price,m.half_price AS halfPrice,m.available,m.sold_out AS soldOut,m.variants_json AS variantsJson FROM menu_items m LEFT JOIN menu_categories c ON c.id=m.category_id WHERE m.id=?').bind(line.id).first();
    if (!item || !item.available) throw new Error('A selected menu item is not available today. Refresh the menu and review the cart.');
    if (item.soldOut) throw new Error('A selected menu item is sold out. Refresh the menu and review the cart.');
    const portion = line.portion === 'half' ? 'half' : 'full';
    const variants = JSON.parse(item.variantsJson || '[]');
    let officialPrice = portion === 'half' ? item.halfPrice : item.price;
    let variantName = '';
    if (variants.length) {
      if (!line.variantId) throw new Error('Choose a valid drink size. Refresh the menu and review the cart.');
      const selected = variants.find(v => v.id === line.variantId);
      if (!selected || selected.available === false || selected.soldOut === true) {
        throw new Error('A selected drink size is no longer available. Refresh the menu and review the cart.');
      }
      officialPrice = selected.price;
      variantName = selected.name;
    } else if (line.variantId) {
      throw new Error('A selected menu option is invalid. Refresh the menu and review the cart.');
    }
    if (!Number.isSafeInteger(officialPrice) || officialPrice < 1 || officialPrice > 100000000) {
      throw new Error(portion === 'half'
        ? 'A half-order price is not configured for this menu item.'
        : 'The selected menu item has an invalid price. Contact the store.');
    }
    // An intentional POS line-price edit applies to this sale only.
    // It never changes the shared menu price in D1.
    const salePrice = line.priceOverridden === true ? line.price : officialPrice;
    if (!Number.isSafeInteger(salePrice) || salePrice < 1 || salePrice > 100000000) {
      throw new Error('Enter a valid item price greater than zero.');
    }
    menuRows.push({
      id: item.id,
      name: item.name,
      categoryId: item.categoryId || null,
      categoryName: item.categoryName || 'Uncategorized',
      price: salePrice,
      priceOverridden: line.priceOverridden === true,
      lineTotal: line.lineTotalOverridden === true ? line.lineTotal : salePrice * line.qty,
      lineTotalOverridden: line.lineTotalOverridden === true,
      qty: line.qty,
      portion,
      variantId: line.variantId || null,
      variantName
    });
  }
  const settingsRow = await db.prepare('SELECT settings_json FROM store_settings WHERE id=1').first();
  if (!settingsRow) throw new Error('The shared menu is not initialized.');
  const settings = JSON.parse(settingsRow.settings_json);
  const totals = calculateTotals(menuRows, settings, b.totals.discountKind, b.totals.diners, b.totals.idHolders);
  if (b.totals.total !== totals.total || b.totals.discountKind !== totals.discountKind) throw new Error('The order total does not match the official menu and discount calculation. Review the cart.');
  if (b.method !== 'cash' && b.tendered !== totals.total) throw new Error('For non-cash payments, the amount must match the order total.');
  // Reports are optional bookkeeping. A sale must be saved even when no report is open
  // or daily report creation/rollover has failed.
  const shift = await currentShift(db);
  const counter = await db.prepare('UPDATE order_counters SET value=value+1 WHERE id=1 RETURNING value').first();
  if (!counter) throw new Error('Order counter is missing. Run the D1 migration.');
  const ts=Date.now(), no='K-'+pad(counter.value);
  const order={
    id:b.id,no,ts,type:b.type,table:b.type==='dine'?String(b.table||'').slice(0,3):'',
    lines:menuRows,totals,method:b.method,tendered:b.tendered,change:b.tendered-totals.total,
    ref:b.ref||'',status:'paid',shiftId:shift ? shift.id : null,hasPaymentProof:!!b.paymentProof
  };
  const statements=[
    db.prepare('INSERT INTO orders(id,order_no,shift_id,device_id,created_at,order_type,table_no,payment_method,payment_reference,tendered,change_amount,status,totals_json,payload_json,payment_proof) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(order.id,order.no,order.shiftId,deviceId||'unknown',new Date(ts).toISOString(),order.type,order.table,order.method,order.ref,order.tendered,order.change,'paid',JSON.stringify(order.totals),JSON.stringify(order),b.paymentProof||null)
  ];
  order.lines.forEach(line=>statements.push(
    db.prepare('INSERT INTO order_items(order_id,menu_item_id,item_name,unit_price,quantity,line_total,portion) VALUES(?,?,?,?,?,?,?)')
      .bind(order.id,line.id,line.name,line.price,line.qty,line.lineTotalOverridden === true ? line.lineTotal : line.price*line.qty,line.portion||'full')
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
   if(u.pathname==='/api/auth/login'&&request.method==='POST'){
     const body=await request.json();
     if(!body||!text(body.password,200))return json({error:'Enter your owner password.'},400,h);
     const credential=await db.prepare('SELECT id FROM admin_credentials WHERE id=1').first();
     if(!credential&&!text(env.ADMIN_PASSWORD,200))return json({error:'Owner login is not configured. Set ADMIN_PASSWORD in Worker secrets.'},503,h);
     if(typeof env.SESSION_SECRET!=='string'||env.SESSION_SECRET.trim().length<32)return json({error:'Owner sessions are not configured. Set SESSION_SECRET (at least 32 characters) in Worker secrets.'},503,h);
     if(!await storedOwnerPassword(db,body.password,env))return json({error:'Incorrect password.'},401,h);
     return json({token:await makeToken(env.SESSION_SECRET)},200,h);
   }
   if(u.pathname==='/api/auth/session'&&request.method==='GET'){
     return await isAdmin(bearer(request),env.SESSION_SECRET)?json({authenticated:true},200,h):json({authenticated:false},401,h);
   }
   // Public menu reads are needed by the future customer ordering page.
   // All operational and administrative API routes require the owner session.
   if(!((u.pathname==='/api/menu'&&request.method==='GET')||(u.pathname==='/api/public/settings'&&request.method==='GET')||(u.pathname==='/api/public/orders'&&request.method==='POST'))&&!await isAdmin(bearer(request),env.SESSION_SECRET)){
     return json({error:'Owner login required.'},401,h);
   }
   // Report rollover is best-effort and must never block menu, register, or sales APIs.
   try { await runDailySchedule(db,new Date()); } catch (scheduleError) { /* sales remain available */ }
   if(u.pathname==='/api/public/settings'&&request.method==='GET')return json(await getAppSettings(db),200,h);
   if(u.pathname==='/api/public/orders'&&request.method==='POST'){const b=await request.json();return json({order:await createOnlineOrder(db,b)},201,h);}
   if(u.pathname==='/api/menu'&&request.method==='GET')return json(await menu(db),200,h);
   if(u.pathname==='/api/settings'&&request.method==='GET')return json(await getAppSettings(db),200,h);
   if(u.pathname==='/api/settings'&&request.method==='PUT')return json(await saveAppSettings(db,await request.json()),200,h);
   if(u.pathname==='/api/system/status'&&request.method==='GET'){
     await db.prepare('SELECT 1 AS ok').first();
     return json({cloud:'connected',database:'connected',checkedAt:new Date().toISOString()},200,h);
   }
   if(u.pathname==='/api/auth/change-password'&&request.method==='POST'){
     const body=await request.json();
     if(!body||!text(body.currentPassword,200))return json({error:'Enter your current password.'},400,h);
     if(!text(body.newPassword,200)||body.newPassword.length<8)return json({error:'Your new password must be at least 8 characters.'},400,h);
     if(body.newPassword!==body.confirmPassword)return json({error:'The new passwords do not match.'},400,h);
     if(!await storedOwnerPassword(db,body.currentPassword,env))return json({error:'Your current password is incorrect.'},400,h);
     await setOwnerPassword(db,body.newPassword);
     return json({ok:true,message:'Owner password updated.'},200,h);
   }
   if(u.pathname==='/api/menu'&&request.method==='PUT'){await saveMenu(db,await request.json());return json({ok:true,message:'Shared menu saved to Cloudflare D1.'},200,h);}
   if(u.pathname==='/api/shifts/current'&&request.method==='GET')return json({shift:await currentShift(db)},200,h);
   if(u.pathname==='/api/reports'&&request.method==='GET')return json(await reportData(db,u.searchParams.get('from')||'',u.searchParams.get('to')||''),200,h);
   if(u.pathname==='/api/orders/next-number'&&request.method==='GET'){const c=await db.prepare('SELECT value FROM order_counters WHERE id=1').first();return json({no:'K-'+pad((c?c.value:0)+1)},200,h);}
   if(u.pathname==='/api/orders'&&request.method==='GET')return json({orders:await orders(db,u.searchParams.get('shiftId')||'')},200,h);
   if(u.pathname==='/api/orders'&&request.method==='POST'){const b=await request.json();return json({order:await createOrder(db,b,b.deviceId||'unknown')},201,h);}
   const proof=u.pathname.match(/^\/api\/orders\/([^/]+)\/payment-proof$/);
   if(proof&&request.method==='GET'){const row=await db.prepare('SELECT payment_proof FROM orders WHERE id=?').bind(decodeURIComponent(proof[1])).first();if(!row)return json({error:'Order not found.'},404,h);if(!row.payment_proof)return json({error:'No payment proof is attached to this order.'},404,h);return json({dataUrl:row.payment_proof},200,h);}
   const paid=u.pathname.match(/^\/api\/orders\/([^/]+)\/mark-paid$/);
   if(paid&&request.method==='POST'){const payment=await request.json();const order=await markOnlineOrderPaid(db,decodeURIComponent(paid[1]),payment);return json({order},200,h);}
   const v=u.pathname.match(/^\/api\/orders\/([^/]+)\/void$/);
   if(v&&request.method==='POST'){const oid=decodeURIComponent(v[1]);const r=await db.prepare('SELECT payload_json,status,voided_at FROM orders WHERE id=?').bind(oid).first();if(!r)return json({error:'Order not found.'},404,h);if(r.status==='void')return json({order:rowOrder(r)},200,h);const o=rowOrder(r);o.status='void';o.voidedAt=Date.now();await db.prepare("UPDATE orders SET status='void',voided_at=?,payload_json=? WHERE id=?").bind(new Date(o.voidedAt).toISOString(),JSON.stringify(o),oid).run();return json({order:o},200,h);}
   return json({error:'Not found.'},404,h);
  } catch(e){const message=e.message||'Unexpected server error.';return json({error:message},message.indexOf('No daily report is open')===0?409:500,h);}
 },
 async scheduled(controller,env) {
   await runDailySchedule(env.kahera_db,new Date(controller.scheduledTime));
 }
};
