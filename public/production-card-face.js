(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IronBendProductionCardFace=api;})(typeof window==='undefined'?this:window,function(){
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // One presentation for the printed card and the scanned worker card. Geometry
  // must already be the canonical server SVG; this module never calculates it.
  function render(p){
    const short=(String(p.orderNumber||'').match(/[0-9]/g)||[]).join('').slice(-3);
    const label=short?'#'+short:p.orderNumber;
    const split=p.splitLabel?'<span class="split-badge">'+esc(p.splitLabel)+'</span>':'';
    return '<div class="pc-print-face" data-with-qr="'+(p.workerCode?'1':'0')+'"><div class="pc-print-main">'+
      '<div class="pc-print-head"><b style="white-space:nowrap">'+esc(label)+split+'</b><span class="pc-print-head-meta"><span class="pc-print-customer">'+esc(p.customer)+'</span><b class="pc-print-diameter">Ø '+esc(p.diameterLabel)+'</b></span></div>'+
      '<div class="pc-print-ref">'+esc(p.reference)+'</div>'+
      '<div class="pc-print-shape">'+(p.shapeSvg||'')+'</div>'+
      '<div class="pc-print-bottom"><span>L = '+esc(p.lengthCm)+' cm</span><span>'+(p.isPileAssembly?'CAGES ':'PCS ')+esc(p.quantity)+'</span></div></div>'+
      (p.workerCode?'<div class="pc-print-qr-panel"><div class="pc-print-qr-code" data-worker-card-code="'+esc(p.workerCode)+'"></div></div>':'')+'</div>';
  }
  return{render};
});
