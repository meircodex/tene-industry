'use strict';
const {israelDay}=require('./productionActuals');
function daily(db,userId,now=new Date()){
 const date=israelDay(now),rows=db.prepare(`SELECT a.*,i.status,i.total_weight FROM worker_card_activity a JOIN items i ON i.id=a.item_id
 WHERE a.actor_user_id=? AND a.action='status_changed' AND json_extract(a.details_json,'$.to_status')='הושלם'
 AND COALESCE(json_extract(a.details_json,'$.unchanged'),0)=0
 AND a.id=(SELECT MAX(b.id) FROM worker_card_activity b WHERE b.item_id=a.item_id AND b.action='status_changed'
 AND json_extract(b.details_json,'$.to_status')='הושלם' AND COALESCE(json_extract(b.details_json,'$.unchanged'),0)=0)
 AND i.status IN ('הושלם','הועמס','נשלח','סופק','ממתין לאיסוף')`).all(userId);
 const completed=rows.filter(r=>israelDay(new Date(r.occurred_at.includes('T')?r.occurred_at:r.occurred_at.replace(' ','T')+'Z'))===date);
 const kg=completed.reduce((sum,r)=>sum+Number(JSON.parse(r.details_json).completed_weight_kg??r.total_weight??0),0);
 return{date,time_zone:'Asia/Jerusalem',completed_cards:completed.length,weight_kg:kg,weight_basis:'theoretical_at_completion'};
}
function history(db,userId,page=1,limit=10){
 // One eligible activity per actor/item. Opening a card is kept in the activity
 // ledger, but must neither create a personal work row nor move an old one up.
 const latest=`SELECT MAX(id) FROM worker_card_activity
  WHERE actor_user_id=? AND action IN ('status_changed','updated')
  AND (COALESCE(json_extract(details_json,'$.unchanged'),0)=0
   OR json_extract(details_json,'$.zone') IS NOT NULL
   OR json_extract(details_json,'$.actual_weight_kg') IS NOT NULL)
  GROUP BY item_id`;
 const total=db.prepare(`SELECT COUNT(*) AS n FROM worker_card_activity a JOIN items i ON i.id=a.item_id
  WHERE a.id IN (${latest})`).get(userId).n;
 const rows=db.prepare(`SELECT a.item_id,a.occurred_at,a.action,a.card_token,i.status,i.shape_name,i.diameter,i.quantity,i.zone,i.total_weight,o.order_num,c.name AS customer_name
  FROM worker_card_activity a JOIN items i ON i.id=a.item_id LEFT JOIN pallets p ON p.id=i.pallet_id
  LEFT JOIN orders o ON o.id=COALESCE(i.order_id,p.order_id) LEFT JOIN customers c ON c.id=o.customer_id
  WHERE a.id IN (${latest}) ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(userId,limit,(page-1)*limit);
 return {rows,page,limit,total};
}
module.exports={daily,history};
