'use strict';

const TYPE_LABELS={coil:'גליל',straight:'ליפט / מוטות ישרים',bent:'מכופף',mesh:'רשת'};
const {purchaseUnit,estimatedWeight}=require('../public/purchase-units');
const fail=code=>{throw Object.assign(new Error(code),{code,statusCode:400});};
const string=value=>String(value??'').trim().slice(0,1000);
function normalizeDraft(db,input={}) {
  if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>500)fail('purchase_draft_lines_required');
  const supplierId=Number(input.supplier_id)||null;
  const supplier=supplierId?db.prepare('SELECT id,name FROM suppliers WHERE id=? AND active=1').get(supplierId):null;
  if(supplierId&&!supplier)fail('supplier_not_found');
  const lines=input.lines.map((line,index)=>{
    if(!Object.hasOwn(TYPE_LABELS,line.material_type))fail('invalid_material_type');
    if(line.quantity===null||line.quantity===''||typeof line.quantity==='boolean')fail('invalid_purchase_quantity');
    // Unversioned clients retain their explicit historical kg/sheet semantics.
    // New clients must name the purchase unit; never reinterpret a kg number as rolls.
    const expected=purchaseUnit(line.material_type);
    const unit=Object.hasOwn(line,'purchase_unit')?line.purchase_unit:(line.material_type==='mesh'?'sheet':'kg');
    if(unit!=='kg'&&unit!==expected.unit)fail('invalid_purchase_unit');
    if(line.material_type==='mesh'&&unit!=='sheet')fail('invalid_purchase_unit');
    const quantity=Number(line.quantity);
    if(!Number.isFinite(quantity)||quantity<=0||quantity>1e9||(['coil','sheet'].includes(unit)&&!Number.isSafeInteger(quantity))||(unit==='bundle'&&!Number.isSafeInteger(quantity*2)))fail('invalid_purchase_quantity');
    let unitWeight=null,totalWeight=null;
    if(unit==='coil'||unit==='bundle'){
      if(line.unit_weight_kg===null||line.unit_weight_kg===''||typeof line.unit_weight_kg==='boolean')fail('invalid_unit_weight');
      unitWeight=Number(line.unit_weight_kg);
      if(!Number.isFinite(unitWeight)||unitWeight<0.001||unitWeight>1e7)fail('invalid_unit_weight');
      totalWeight=estimatedWeight(quantity,unitWeight);
      if(!Number.isFinite(totalWeight)||totalWeight>1e9)fail('invalid_purchase_quantity');
    }
    const shortage=line.shortage_kg==null?null:Number(line.shortage_kg);
    if(shortage!==null&&(!Number.isFinite(shortage)||shortage<0||shortage>1e9))fail('invalid_shortage_weight');
    const diameter=line.diameter===undefined||line.diameter===null||line.diameter===''?null:Number(line.diameter);
    if(diameter!==null&&(!Number.isFinite(diameter)||diameter<=0))fail('invalid_diameter');
    if(line.material_type!=='mesh'&&diameter===null)fail('diameter_required');
    const specification=string(line.specification);
    const length=line.length_m===undefined||line.length_m===null||line.length_m===''?null:Number(line.length_m);
    if(length!==null&&(typeof line.length_m==='boolean'||!Number.isFinite(length)||length<=0||length>1000))fail('invalid_purchase_length');
    if(length!==null&&!['straight','bent'].includes(line.material_type))fail('invalid_purchase_length');
    if(unit==='sheet'&&!specification)fail('mesh_specification_required');
    return {row:index+1,material_type:line.material_type,type_label:TYPE_LABELS[line.material_type],diameter,specification,length_m:length,quantity,unit,unit_label:unit==='kg'?'ק״ג':unit==='sheet'?'יחידות':expected.label,unit_weight_kg:unitWeight,estimated_weight_kg:totalWeight,shortage_kg:shortage,notes:string(line.notes)};
  });
  const deliveryDate=string(input.expected_date);
  if(deliveryDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)||!Number.isFinite(Date.parse(deliveryDate))||new Date(deliveryDate).toISOString().slice(0,10)!==deliveryDate))fail('invalid_expected_date');
  return {supplier:supplier?.name||string(input.supplier_name),expected_date:deliveryDate,reference:string(input.reference),notes:string(input.notes),lines};
}
function csvCell(value) {
  let text=String(value??'');
  // Treat user strings as data, including formulas hidden behind whitespace.
  if(/^[\s\u0000-\u001f]*[=+\-@]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
function exportPurchaseDraft(db,input={}) {
  const draft=normalizeDraft(db,input);
  const rows=[['ספק','אספקה מבוקשת','אסמכתה','שורה','סוג חומר','קוטר במ״מ','מפרט','אורך (מטר)','כמות להזמנה','יחידה','ק״ג ליחידה (משוער)','משקל להזמנה בק״ג (משוער)','חוסר מדויק בק״ג','הערות שורה','הערות להזמנה']];
  for(const line of draft.lines)rows.push([draft.supplier,draft.expected_date,draft.reference,line.row,line.type_label,line.diameter,line.specification,line.length_m,line.quantity,line.unit_label,line.unit_weight_kg,line.estimated_weight_kg,line.shortage_kg,line.notes,draft.notes]);
  return {filename:'purchase-order-draft.csv',content:'\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n',draft};
}
module.exports={normalizeDraft,exportPurchaseDraft,csvCell};
