/** Kahera cloud client: shared menu, orders and shifts use Cloudflare D1. */
(function (root) {
  "use strict";
  var API_URL = "https://kahera-menu-api.kahera-menu-api.workers.dev";
  var token = null, DEVICE_KEY = "kahera:v1:device-id";
  function uuid() { return root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : "k-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2); }
  function getDeviceId() {
    try { var saved=root.localStorage.getItem(DEVICE_KEY);if(saved)return saved;var created=uuid();root.localStorage.setItem(DEVICE_KEY,created);return created; }
    catch(_){return uuid();}
  }
  function request(path,options) {
    options=options||{};options.headers=options.headers||{};options.headers["Content-Type"]="application/json";
    if(token)options.headers.Authorization="Bearer "+token;
    return fetch(API_URL.replace(/\/$/,"")+path,options).then(function(r){return r.json().catch(function(){return {};}).then(function(b){if(!r.ok)throw new Error(b.error||"Request failed ("+r.status+").");return b;});});
  }
  root.KaheraCloud={
    getDeviceId:getDeviceId,newId:uuid,
    getMenu:function(){return request("/api/menu",{method:"GET",cache:"no-store"});},
    saveMenu:function(payload){return request("/api/menu",{method:"PUT",body:JSON.stringify(payload)});},
    getCurrentShift:function(){return request("/api/shifts/current",{method:"GET",cache:"no-store"}).then(function(b){return b.shift;});},
    getReports:function(from,to){return request("/api/reports?from="+encodeURIComponent(from)+"&to="+encodeURIComponent(to),{method:"GET",cache:"no-store"});},
    getOrders:function(shiftId){return request("/api/orders"+(shiftId?"?shiftId="+encodeURIComponent(shiftId):""),{method:"GET",cache:"no-store"}).then(function(b){return b.orders||[];});},
    getNextNo:function(){return request("/api/orders/next-number",{method:"GET",cache:"no-store"}).then(function(b){return b.no;});},
    createOrder:function(order){var payload=Object.assign({},order,{id:order.id||uuid(),deviceId:order.deviceId||getDeviceId()});return request("/api/orders",{method:"POST",body:JSON.stringify(payload)}).then(function(b){return b.order;});},
    getPaymentProof:function(orderId){return request("/api/orders/"+encodeURIComponent(orderId)+"/payment-proof",{method:"GET",cache:"no-store"}).then(function(b){return b.dataUrl;});},
    voidOrder:function(orderId){return request("/api/orders/"+encodeURIComponent(orderId)+"/void",{method:"POST",body:"{}"}).then(function(b){return b.order;});}
  };
})(typeof window!=="undefined"?window:this);
