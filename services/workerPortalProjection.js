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
module.exports={daily};
