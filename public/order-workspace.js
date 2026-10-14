(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IronBendOrderWorkspace=api;})(typeof window==='undefined'?this:window,function(){
  const delivered=['סופק – אושר','סופק - אושר','סופק','נמסרה'];
  const cancelled=['בוטלה','בוטל'];
  function bucket(order){if(order.deleted_at)return'trash';if(order.payment_status==='paid'||order.status==='שולם')return'closed';if(delivered.includes(order.status))return'delivered';if(cancelled.includes(order.status))return'cancelled';return'active';}
  function rowTone(order){const group=bucket(order);if(group!=='active')return group;if(order.status==='בייצור')return'production';if(['בהעמסה','אספקה חלקית','בדרך ללקוח','נשלחה','הושלם – ממתין לאיסוף'].includes(order.status))return'ready';if(['אושרה – ממתין לייצור','בתור ייצור'].includes(order.status))return'approved';return'waiting';}
  function deliveryDate(value){const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[3]}.${m[2]}.${m[1]}`:'—';}
  function notes(order){const parts=[];const p=order.delivery_progress;if(p?.shipped_unit_count){const partial=p.remaining_unit_count>0;parts.push(`${partial?'אספקה חלקית':'נשלחה במלואה'}: ${p.shipped_item_count} מתוך ${p.total_item_count} פריטים · ${p.shipped_unit_count} מתוך ${p.total_unit_count} יח׳`);}if(order.priority==='דחוף')parts.push('דחוף');if(order.general_notes)parts.push(order.general_notes);if(order.driver_notes)parts.push('הערת אספקה: '+order.driver_notes);if(order.deleted_at)parts.push('בסל המחזור: '+(order.deletion_reason||''));return parts;}
  return{bucket,rowTone,deliveryDate,notes,delivered,cancelled};
});
