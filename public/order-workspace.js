(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IronBendOrderWorkspace=api;})(typeof window==='undefined'?this:window,function(){
  const delivered=['סופק – אושר','סופק - אושר','סופק','נמסרה'];
  const cancelled=['בוטלה','בוטל'];
  function bucket(order){if(order.deleted_at)return'trash';if(order.payment_status==='paid'||order.status==='שולם')return'closed';if(delivered.includes(order.status))return'delivered';if(cancelled.includes(order.status))return'cancelled';return'active';}
  function primaryStatus(order){if(order.status!=='אספקה חלקית')return order.status;const status=order.delivery_progress?.production_status;return !status||status==='ממתינה לאישור'?'בתור ייצור':status;}
  function rowTone(order){const group=bucket(order);if(group!=='active')return group;const status=primaryStatus(order);if(status==='בייצור')return'production';if(['בהעמסה','בדרך ללקוח','נשלחה','הושלם – ממתין לאיסוף'].includes(status))return'ready';if(['אושרה – ממתין לייצור','בתור ייצור'].includes(status))return'approved';return'waiting';}
  function deliveryDate(value){const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[3]}.${m[2]}.${m[1]}`:'—';}
  function deliverySummary(progress){if(!progress?.total_item_count)return '';const total=progress.total_item_count,shipped=progress.shipped_item_count||0,partial=progress.partially_shipped_item_count||0;if(!shipped&&!partial)return `${total} פריטים בהזמנה`;return `נשלחו במלואם ${shipped} מתוך ${total} פריטים${partial?` · ${partial} פריטים נשלחו בחלקם`:''}`;}
  function notes(order){const parts=[];const summary=deliverySummary(order.delivery_progress);if(summary)parts.push(summary);if(order.priority==='דחוף')parts.push('דחוף');if(order.general_notes)parts.push(order.general_notes);if(order.driver_notes)parts.push('הערת אספקה: '+order.driver_notes);if(order.deleted_at)parts.push('בסל המחזור: '+(order.deletion_reason||''));return parts;}
  return{bucket,rowTone,deliveryDate,notes,primaryStatus,deliverySummary,delivered,cancelled};
});
