'use strict';
const cards=require('./productionCards');
const face=require('../public/production-card-face');
const units=require('../public/display-units');
const QRCode=require('qrcode');
const {expandProductionCardsForOrder}=require('./productionCardPrintPage');

function buildWorkerOriginalCard(db,item,token=''){
  const all=db.prepare('SELECT i.* FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=? ORDER BY i.id').all(item.order_id);
  cards.attachOrderLineNumbers(all);
  const parent=all.find(i=>Number(i.id)===Number(item.id));
  if(!parent)throw Object.assign(new Error('not_found'),{statusCode:404});
  const suffix=String(token).match(/-C(\d+)OF(\d+)$/i);
  const index=suffix?Number(suffix[1]):1,count=suffix?Number(suffix[2]):1;
  if(!Number.isSafeInteger(index)||!Number.isSafeInteger(count)||index<1||count<1||index>count||count>512||count>Number(parent.quantity||1))throw Object.assign(new Error('invalid_card_split'),{statusCode:400});
  let original=parent;
  // A cage QR can refer to one of its original, virtual production components.
  const expanded=expandProductionCardsForOrder([parent],(value,fallback)=>{try{return typeof value==='string'?JSON.parse(value):value||fallback;}catch{return fallback;}});
  if(expanded.some(i=>i.virtual_card)){
    const matches=expanded.filter(i=>String(token).includes(String(i.scan_suffix||'__no_suffix__')));
    if(matches.length!==1)throw Object.assign(new Error('specific_component_card_required'),{statusCode:409});
    original=matches[0];
  }
  const quantity=count===1?original.quantity:Math.floor(Number(parent.quantity)/count)+(index<=Number(parent.quantity)%count?1:0);
  const diameter=cards.shapeDiameterFromItem(original);
  const length=cards.shapeTotalLengthMmFromItem(original);
  const isAssembly=original.pile_card_type==='pile_assembly';
  const reference=cards.itemOrderLineLabel(parent)+' · '+(original.struct_element||item.customer_name||'');
  let html=face.render({orderNumber:item.order_num,customer:item.customer_name,diameterLabel:isAssembly?String(Number(diameter)/10)+' cm':diameter,reference,shapeSvg:cards.shapeSvgForProductionCard(original),lengthCm:units.formatLengthCmFromMm(length).replace(/\s*ס[״"]מ\s*$/,''),quantity:quantity??'—',isPileAssembly:isAssembly,splitLabel:count>1?index+'/'+count:'',workerCode:String(token||item.id)});
  const qr=QRCode.create(String(token||item.id),{errorCorrectionLevel:'M'}),size=qr.modules.size;
  let blocks='';for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(qr.modules.get(y,x))blocks+=`M${x+2} ${y+2}h1v1h-1z`;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size+4} ${size+4}" role="img" aria-label="QR"><rect width="100%" height="100%" fill="white"/><path d="${blocks}" fill="black"/></svg>`;
  html=html.replace(/(<div class="pc-print-qr-code"[^>]*>)(<\/div>)/,'$1'+svg+'$2');
  return{html,whole_item:!original.virtual_card&&count===1,item_id:Number(item.id),card_index:index,card_total:count,card_quantity:quantity??null,read_only:true};
}
module.exports={buildWorkerOriginalCard};
