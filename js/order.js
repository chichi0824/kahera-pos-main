(function(){
  'use strict';
  var cloud=window.KaheraCloud,menu=[],categories=[],cart=[],activeCategory='all',requestId=null;
  var $=function(id){return document.getElementById(id);};
  var themeButton=$('theme-toggle');
  function applyTheme(theme){document.documentElement.setAttribute('data-theme',theme);if(themeButton){themeButton.textContent=theme==='dark'?'☀':'◐';themeButton.setAttribute('aria-label',theme==='dark'?'Switch to light mode':'Switch to dark mode');}}
  var savedTheme=null;try{savedTheme=localStorage.getItem('kahera:v1:theme');savedTheme=savedTheme?JSON.parse(savedTheme):null;}catch(e){}
  applyTheme(savedTheme==='dark'||savedTheme==='light'?savedTheme:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));
  if(themeButton)themeButton.addEventListener('click',function(){var next=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';applyTheme(next);try{localStorage.setItem('kahera:v1:theme',JSON.stringify(next));}catch(e){}});
  var money=function(cents){return new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format((cents||0)/100);};
  var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
  var total=function(){return cart.reduce(function(sum,line){return sum+line.price*line.qty;},0);};
  var count=function(){return cart.reduce(function(sum,line){return sum+line.qty;},0);};
  function categoryRank(category){
    var name=String(category.name||'').trim().toLowerCase();
    if(name==='ulam'||name==='meals')return 0;
    if(name==='merienda')return 1;
    if(name==='extra'||name==='extras')return 2;
    if(name==='drink'||name==='drinks'||name==='beverage'||name==='beverages')return 3;
    return 4;
  }
  function orderedCategories(){
    return categories.slice().sort(function(a,b){return categoryRank(a)-categoryRank(b)||String(a.name||'').localeCompare(String(b.name||''));});
  }
  function categoryLabel(category){return /^extras$/i.test(String(category.name||''))?'Extra':category.name;}
  function renderCategories(){
    $('category-list').innerHTML=[{id:'all',name:'All'}].concat(orderedCategories()).map(function(c){return '<button type="button" class="'+(activeCategory===c.id?'active':'')+'" data-category="'+esc(c.id)+'">'+esc(categoryLabel(c))+'</button>';}).join('');
  }
  function itemButtons(item){
    if(item.variants&&item.variants.length){
      return item.variants.map(function(v){var off=!item.available||item.soldOut||v.available===false||v.soldOut===true;return '<button type="button" data-add="'+esc(item.id)+'" data-variant="'+esc(v.id)+'" '+(off?'disabled':'')+'>'+esc(v.name)+' · '+money(v.price)+'</button>';}).join('');
    }
    var out='';
    if(item.halfPrice){out+='<button type="button" data-add="'+esc(item.id)+'" data-portion="full" '+(item.soldOut?'disabled':'')+'>Full · '+money(item.price)+'</button><button type="button" data-add="'+esc(item.id)+'" data-portion="half" '+(item.soldOut?'disabled':'')+'>Half · '+money(item.halfPrice)+'</button>';}
    else out+='<button type="button" data-add="'+esc(item.id)+'" data-portion="full" '+(item.soldOut?'disabled':'')+'>Add · '+money(item.price)+'</button>';
    return out;
  }
  function qtyInCart(itemId){
    return cart.filter(function(line){return line.id===itemId;}).reduce(function(sum,line){return sum+(Number(line.qty)||0);},0);
  }
  function renderMenuCard(item){
    var photo=item.image?'<img src="'+esc(item.image)+'" alt="'+esc(item.name)+'" loading="lazy">':'<div class="menu-card-placeholder"></div>';
    var unavailable=item.available===false||item.soldOut===true;
    var qty=qtyInCart(item.id);
    var quantityBadge=qty>0?'<span class="menu-card-qty" aria-label="'+qty+' '+(qty===1?'item':'items')+' selected">'+qty+'</span>':'';
    return '<article class="menu-card">'+photo+quantityBadge+'<div class="menu-card-content"><div><h3>'+esc(item.name)+'</h3><p>'+(unavailable?'Currently unavailable':item.variants&&item.variants.length?'Choose a price option':item.halfPrice?'Full or half portion':'Freshly prepared')+'</p></div><div class="price-actions">'+(unavailable?'<p>Sold out today</p>':itemButtons(item))+'</div></div></article>';
  }
  function renderMenu(){
    var q=$('menu-search').value.trim().toLowerCase();
    var visible=menu.filter(function(m){return (activeCategory==='all'||m.cat===activeCategory)&&(!q||m.name.toLowerCase().includes(q));});
    if(!visible.length){$('menu-grid').innerHTML='<p class="empty">No menu items found.</p>';return;}
    if(activeCategory!=='all'){
      $('menu-grid').innerHTML=visible.map(renderMenuCard).join('');
      return;
    }
    $('menu-grid').innerHTML=orderedCategories().map(function(category){
      var items=visible.filter(function(item){return item.cat===category.id;});
      if(!items.length)return '';
      return '<section class="category-section"><header class="category-heading"><h3>'+esc(categoryLabel(category))+'</h3><span>'+items.length+(items.length===1?' item':' items')+'</span></header><div class="category-grid">'+items.map(renderMenuCard).join('')+'</div></section>';
    }).join('')||'<p class="empty">No menu items found.</p>';
  }
  function addItem(itemId,variantId,portion){
    var item=menu.find(function(m){return m.id===itemId;});if(!item)return;
    var variant=(item.variants||[]).find(function(v){return v.id===variantId;});
    var price=variant?variant.price:portion==='half'?item.halfPrice:item.price;
    if(!Number.isSafeInteger(price)||price<1)return;
    var key=item.id+'|'+(variantId||'')+'|'+(portion||'full');
    var line=cart.find(function(x){return x.key===key;});
    if(line)line.qty=Math.min(30,line.qty+1);
    else cart.push({key:key,id:item.id,name:item.name,price:price,qty:1,portion:portion||'full',variantId:variantId||null,variantName:variant?variant.name:''});
    renderCart();
  }
  function renderCart(){
    $('cart-lines').innerHTML=cart.length?cart.map(function(line,i){return '<div class="cart-line"><div><strong>'+esc(line.name)+'</strong><small>'+(line.variantName?esc(line.variantName):line.portion==='half'?'Half portion':'Full portion')+' · '+money(line.price)+'</small></div><div class="line-controls"><button type="button" data-step="'+i+'" data-delta="-1" aria-label="Remove one">−</button><span>'+line.qty+'</span><button type="button" data-step="'+i+'" data-delta="1" aria-label="Add one">+</button></div></div>';}).join(''):'<p class="empty">Your order is empty. Add something delicious.</p>';
    $('cart-total').textContent=money(total());
    document.querySelectorAll('[data-cart-count]').forEach(function(el){el.textContent=count();});
    $('place-order').textContent='Place order · '+money(total());
    $('place-order').disabled=!cart.length;
    renderMenu();
  }
  function setFulfillment(){
    var delivery=document.querySelector('input[name="fulfillment"]:checked').value==='delivery';
    $('delivery-fields').hidden=!delivery;
    if(!delivery){$('delivery-address').value='';$('contact-to-confirm').checked=false;}
  }
  function showSuccess(order){
    $('success-number').textContent=order.no;
    $('success-detail').textContent=order.fulfillmentType==='delivery'?(order.deliveryContactRequested?'The store will contact you to confirm your delivery address.':'Your order is for delivery to '+order.deliveryAddress+'.'):'Your order is for pickup at the store.';
    $('order-success').hidden=false;
    document.querySelector('.layout').hidden=true;
    document.querySelector('.hero').hidden=true;
    window.scrollTo({top:0,behavior:'smooth'});
  }
  $('category-list').addEventListener('click',function(e){var b=e.target.closest('[data-category]');if(!b)return;activeCategory=b.getAttribute('data-category');renderCategories();renderMenu();});
  $('menu-grid').addEventListener('click',function(e){var b=e.target.closest('[data-add]');if(!b)return;addItem(b.getAttribute('data-add'),b.getAttribute('data-variant'),b.getAttribute('data-portion'));});
  $('menu-search').addEventListener('input',renderMenu);
  $('cart-lines').addEventListener('click',function(e){var b=e.target.closest('[data-step]');if(!b)return;var i=Number(b.getAttribute('data-step'));cart[i].qty+=Number(b.getAttribute('data-delta'));if(cart[i].qty<=0)cart.splice(i,1);renderCart();});
  document.querySelectorAll('input[name="fulfillment"]').forEach(function(el){el.addEventListener('change',setFulfillment);});
  $('customer-form').addEventListener('submit',function(e){
    e.preventDefault();$('form-error').textContent='';
    if(!cart.length){$('form-error').textContent='Add at least one item to your order.';return;}
    var fulfillment=document.querySelector('input[name="fulfillment"]:checked').value;
    var address=$('delivery-address').value.trim(),contactRequested=$('contact-to-confirm').checked;
    if(fulfillment==='delivery'&&!address&&!contactRequested){$('form-error').textContent='Enter your delivery address or select the option to be contacted.';return;}
    if(!requestId)requestId=window.crypto&&crypto.randomUUID?crypto.randomUUID():'online-'+Date.now()+'-'+Math.random().toString(36).slice(2);
    var payload={id:requestId,customerName:$('customer-name').value.trim(),customerPhone:$('customer-phone').value.trim(),fulfillmentType:fulfillment,deliveryAddress:fulfillment==='delivery'?address:'',deliveryContactRequested:fulfillment==='delivery'&&contactRequested,lines:cart.map(function(l){return{id:l.id,qty:l.qty,portion:l.portion,variantId:l.variantId};})};
    var button=$('place-order');button.disabled=true;button.textContent='Sending your order…';
    cloud.createPublicOrder(payload).then(showSuccess).catch(function(error){$('form-error').textContent=error.message||'We could not send your order. Please try again.';button.disabled=false;button.textContent='Place order · '+money(total());});
  });
  $('order-again').addEventListener('click',function(){cart=[];requestId=null;$('customer-form').reset();setFulfillment();renderCart();$('order-success').hidden=true;document.querySelector('.layout').hidden=false;document.querySelector('.hero').hidden=false;window.scrollTo({top:0,behavior:'smooth'});});
  var orderingIsClosed=false;
  function loadCustomerMenu(){
    return cloud.getMenu().then(function(data){
      categories=data.categories||[];menu=(data.menu||[]).filter(function(m){return m.available&&!m.soldOut;});
      $('store-name').textContent=data.settings&&data.settings.bizName||"Victoria's";
      $('store-note').textContent=data.settings&&data.settings.bizNote||'Freshly prepared favorites';
      document.title='Order Online · '+$('store-name').textContent;
      renderCategories();renderMenu();
    });
  }
  function applyOrderingStatus(isOpen){
    if(!isOpen){
      orderingIsClosed=true;
      if($('order-success').hidden){
        $('ordering-closed').hidden=false;
        document.querySelector('.layout').hidden=true;
        document.querySelector('.hero').hidden=true;
        document.title='Ordering temporarily closed';
      }
      return;
    }
    if(orderingIsClosed){
      orderingIsClosed=false;
      $('ordering-closed').hidden=true;
      document.querySelector('.layout').hidden=false;
      document.querySelector('.hero').hidden=false;
      if(!menu.length)loadCustomerMenu().catch(function(error){$('menu-grid').innerHTML='<p class="empty">The menu is temporarily unavailable. '+esc(error.message)+'</p>';});
    }
  }
  function checkOrderingStatus(){
    cloud.getPublicSettings().then(function(settings){applyOrderingStatus(!!settings.customerOrderingEnabled);}).catch(function(){});
  }
  cloud.getPublicSettings().then(function(settings){
    applyOrderingStatus(!!settings.customerOrderingEnabled);
    if(settings.customerOrderingEnabled)return loadCustomerMenu();
    return null;
  }).catch(function(error){
    $('menu-grid').innerHTML='<p class="empty">Online ordering is temporarily unavailable. '+esc(error.message)+'</p>';
  });
  window.setInterval(checkOrderingStatus,15000);
  setFulfillment();renderCart();
})();