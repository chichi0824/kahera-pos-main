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
  const m=await db.prepare('SELECT id,category_id AS cat,name,price,available FROM menu_items ORDER BY sort_order,name').all();
  return {settings:JSON.parse(s.settings_json),categories:c.results||[],menu:(m.results||[]).map(x=>({...x,available:!!x.available}))};
}
function validateMenu(b) {
  if(!b||!b.settings||!Array.isArray(b.categories)||!Array.isArray(b.menu))throw new Error('Menu payload is incomplete.');
  if(b.menu.length>500||b.categories.length>30)throw new Error('Menu exceeds the allowed limit.');
  const cats=new Set(),items=new Set();
  for(const c of b.categories){if(!c||!text(c.id,80)||!text(c.name,60)||cats.has(c.id))throw new Error('A menu category is invalid.');cats.add(c.id);}
  for(const m of b.menu){if(!m||!text(m.id,80)||items.has(m.id)||!text(m.name,40)||!cats.has(m.cat)||!Number.isSafeInteger(m.price)||m.price<1||m.price>100000000||typeof m.available!=='boolean')throw new Error('A menu item is invalid.');items.add(m.id);}
  if(typeof b.settings.bizName!=='string'||typeof b.settings.bizNote!=='string'||typeof b.settings.vatRegistered!=='boolean')throw new Error('Store settings are invalid.');
}
async function saveMenu(db,b) {
  validateMenu(b);
  const q=[db.prepare('DELETE FROM menu_items'),db.prepare('DELETE FROM menu_categories'),db.prepare('INSERT OR REPLACE INTO store_settings(id,settings_json,updated_at) VALUES(1,?,CURRENT_TIMESTAMP)').bind(JSON.stringify(b.settings))];
  b.categories.forEach((c,i)=>q.push(db.prepare('INSERT INTO menu_categories(id,name,sort_order) VALUES(?,?,?)').bind(c.id,c.name.trim(),i)));
  b.menu.forEach((m,i)=>q.push(db.prepare('INSERT INTO menu_items(id,category_id,name,price,available,sort_order) VALUES(?,?,?,?,?,?)').bind(m.id,m.cat,m.name.trim(),m.price,m.available?1:0,i)));
  await db.batch(q);
}
async function currentShift(db){return db.prepare("SELECT id,device_id,started_at,ended_at,status FROM shifts WHERE status='open' LIMIT 1").first();}
async function ensureShift(db,deviceId) {
  let s=await currentShift(db);if(s)return s;
  try{await db.prepare("INSERT INTO shifts(id,device_id,started_at,status) VALUES(?,?,?,'open')").bind(uuid(),deviceId||'shared-device',new Date().toISOString()).run();}
  catch(e){s=await currentShift(db);if(s)return s;throw e;}
  return currentShift(db);
}
function rowOrder(r){const o=JSON.parse(r.payload_json);o.status=r.status;if(r.voided_at)o.voidedAt=Date.parse(r.voided_at);return o;}
async function orders(db,shiftId) {
  if(!shiftId){const s=await currentShift(db);if(!s)return [];shiftId=s.id;}
  const r=await db.prepare('SELECT payload_json,status,voided_at FROM orders WHERE shift_id=? ORDER BY created_at,order_no').bind(shiftId).all();
  return (r.results||[]).map(rowOrder);
}
function validateOrder(b) {
  if(!b||!text(b.id,80)||!['dine','take'].includes(b.type)||!Array.isArray(b.lines)||!b.lines.length||b.lines.length>100)throw new Error('Order details are incomplete.');
  for(const l of b.lines)if(!l||!text(l.id,80)||!text(l.name,80)||!Number.isSafeInteger(l.price)||l.price<1||!Number.isInteger(l.qty)||l.qty<1||l.qty>99)throw new Error('An order item is invalid.');
  if(!b.totals||!Number.isSafeInteger(b.totals.total)||b.totals.total<1||!['cash','ewallet','card'].includes(b.method)||!Number.isSafeInteger(b.tendered)||b.tendered<b.totals.total)throw new Error('Payment details are invalid.');
  if(b.method!=='cash'&&!text(b.ref,40))throw new Error('Payment reference is required.');
}
async function createOrder(db,b,deviceId) {
  validateOrder(b);
  let existing=await db.prepare('SELECT payload_json,status,voided_at FROM orders WHERE id=?').bind(b.id).first();if(existing)return rowOrder(existing);
  const shift=await ensureShift(db,deviceId);
  const n=await db.prepare('UPDATE order_counters SET value=value+1 WHERE id=1 RETURNING value').first();
  if(!n)throw new Error('Order counter is missing. Run the D1 migration.');
  const ts=Date.now(),no='K-'+pad(n.value);
  const o={id:b.id,no,ts,type:b.type,table:b.type==='dine'?String(b.table||'').slice(0,3):'',lines:b.lines,totals:b.totals,method:b.method,tendered:b.tendered,change:b.tendered-b.totals.total,ref:b.ref||'',status:'paid',shiftId:shift.id};
  const q=[db.prepare('INSERT INTO orders(id,order_no,shift_id,device_id,created_at,order_type,table_no,payment_method,payment_reference,tendered,change_amount,status,totals_json,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(o.id,o.no,shift.id,deviceId||'unknown',new Date(ts).toISOString(),o.type,o.table,o.method,o.ref,o.tendered,o.change,'paid',JSON.stringify(o.totals),JSON.stringify(o))];
  o.lines.forEach(l=>q.push(db.prepare('INSERT INTO order_items(order_id,menu_item_id,item_name,unit_price,quantity,line_total) VALUES(?,?,?,?,?,?)').bind(o.id,l.id||null,l.name,l.price,l.qty,l.price*l.qty)));
  try{await db.batch(q);}catch(e){existing=await db.prepare('SELECT payload_json,status,voided_at FROM orders WHERE id=?').bind(b.id).first();if(existing)return rowOrder(existing);throw e;}
  return o;
}
export default {
 async fetch(request,env) {
  const origin=corsOrigin(request,env);
  if(request.method==='OPTIONS'){if(!origin)return json({error:'Origin is not allowed.'},403);return new Response(null,{status:204,headers:cors(origin)});}
  if(request.headers.has('Origin')&&!origin)return json({error:'Origin is not allowed.'},403);
  const h=cors(origin),u=new URL(request.url),db=env.kahera_db;
  try {
   if(!db)return json({error:'Cloudflare D1 binding kahera_db is missing.'},500,h);
   if(u.pathname==='/api/login'&&request.method==='POST'){const b=await request.json();if(typeof b.password!=='string'||!env.ADMIN_PASSWORD||!eq(b.password,env.ADMIN_PASSWORD))return json({error:'Incorrect administrator password.'},401,h);return json({token:await makeToken(env.SESSION_SECRET),expiresIn:28800},200,h);}
   if(u.pathname==='/api/menu'&&request.method==='GET')return json(await menu(db),200,h);
   if(u.pathname==='/api/menu'&&request.method==='PUT'){if(!(await isAdmin(bearer(request),env.SESSION_SECRET)))return json({error:'Administrator session expired. Please log in again.'},401,h);await saveMenu(db,await request.json());return json({ok:true,message:'Shared menu saved to Cloudflare D1.'},200,h);}
   if(u.pathname==='/api/shifts/start'&&request.method==='POST'){const b=await request.json().catch(()=>({}));return json({shift:await ensureShift(db,b.deviceId||'shared-device')},200,h);}
   if(u.pathname==='/api/shifts/current'&&request.method==='GET')return json({shift:await currentShift(db)},200,h);
   if(u.pathname==='/api/shifts/close'&&request.method==='POST'){const b=await request.json();if(!text(b.shiftId,80))return json({error:'Shift ID is required.'},400,h);const r=await db.prepare("UPDATE shifts SET status='closed',ended_at=? WHERE id=? AND status='open'").bind(new Date().toISOString(),b.shiftId).run();if(!r.meta||!r.meta.changes)return json({error:'This shift is already closed or no longer active. Refresh the POS.'},409,h);return json({ok:true},200,h);}
   if(u.pathname==='/api/orders/next-number'&&request.method==='GET'){const c=await db.prepare('SELECT value FROM order_counters WHERE id=1').first();return json({no:'K-'+pad((c?c.value:0)+1)},200,h);}
   if(u.pathname==='/api/orders'&&request.method==='GET')return json({orders:await orders(db,u.searchParams.get('shiftId')||'')},200,h);
   if(u.pathname==='/api/orders'&&request.method==='POST'){const b=await request.json();return json({order:await createOrder(db,b,b.deviceId||'unknown')},201,h);}
   const v=u.pathname.match(/^\/api\/orders\/([^/]+)\/void$/);
   if(v&&request.method==='POST'){const oid=decodeURIComponent(v[1]);const r=await db.prepare('SELECT payload_json,status,voided_at FROM orders WHERE id=?').bind(oid).first();if(!r)return json({error:'Order not found.'},404,h);if(r.status==='void')return json({order:rowOrder(r)},200,h);const o=rowOrder(r);o.status='void';o.voidedAt=Date.now();await db.prepare("UPDATE orders SET status='void',voided_at=?,payload_json=? WHERE id=?").bind(new Date(o.voidedAt).toISOString(),JSON.stringify(o),oid).run();return json({order:o},200,h);}
   return json({error:'Not found.'},404,h);
  } catch(e){return json({error:e.message||'Unexpected server error.'},500,h);}
 }
};
