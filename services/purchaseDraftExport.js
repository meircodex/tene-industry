'use strict';

const TYPE_LABELS={coil:'גליל',straight:'ליפט / מוטות ישרים',bent:'מכופף',mesh:'רשת'};
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
    const quantity=Number(line.quantity),unit=line.material_type==='mesh'?'units':'kg';
    if(!Number.isFinite(quantity)||quantity<=0||quantity>1e9||(unit==='units'&&!Number.isSafeInteger(quantity)))fail('invalid_purchase_quantity');
    const diameter=line.diameter===undefined||line.diameter===null||line.diameter===''?null:Number(line.diameter);
    if(diameter!==null&&(!Number.isFinite(diameter)||diameter<=0))fail('invalid_diameter');
    if(unit==='kg'&&diameter===null)fail('diameter_required');
    const specification=string(line.specification);
    if(unit==='units'&&!specification)fail('mesh_specification_required');
    return {row:index+1,material_type:line.material_type,type_label:TYPE_LABELS[line.material_type],diameter,specification,quantity,unit,unit_label:unit==='units'?'יחידות':'ק״ג',notes:string(line.notes)};
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
  const rows=[['ספק','אספקה מבוקשת','אסמכתה','שורה','סוג חומר','קוטר במ״מ','מפרט / אורך','כמות להזמנה','יחידה','הערות שורה','הערות להזמנה']];
  for(const line of draft.lines)rows.push([draft.supplier,draft.expected_date,draft.reference,line.row,line.type_label,line.diameter,line.specification,line.quantity,line.unit_label,line.notes,draft.notes]);
  return {filename:'purchase-order-draft.csv',content:'\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n',draft};
}
module.exports={normalizeDraft,exportPurchaseDraft,csvCell};
