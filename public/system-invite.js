'use strict';
(()=>{
 const $=id=>document.getElementById(id),roles={admin:'מנהל מערכת',manager:'מנהל',office:'משרד',finance:'כספים',production:'ייצור',production_planner:'תכנון ייצור',warehouse:'מחסן',quality:'בקרת איכות',maintenance:'תחזוקה',driver:'נהג',sales:'מכירות',kiosk:'עמדת ייצור',operator:'עמדת ייצור',viewer:'צפייה'};
 let token=new URLSearchParams(location.hash.slice(1)).get('token')||'',busy=false;
 history.replaceState(null,'',location.pathname);
 const errors={system_link_invalid:'הקישור אינו תקין. בקש קישור חדש מהמנהל.',system_link_expired:'תוקף הקישור הסתיים. בקש קישור חדש מהמנהל.',system_link_cancelled:'הקישור בוטל. פנה למנהל.',system_link_used:'הקישור כבר הופעל. היכנס מהאייקון במכשיר שהופעל, או בקש קישור חדש.',system_link_user_unavailable:'הגישה לחשבון אינה פעילה. פנה למנהל.'};
 function error(e){$('message').classList.add('error');$('message').textContent=errors[e.message]||'לא ניתן להשלים את הכניסה. בדוק חיבור ונסה שוב.';}
 async function call(action){const r=await fetch('/api/auth/system-link/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}),data=await r.json();if(!r.ok)throw Error(data.error);return data;}
 async function load(){try{if(!token)throw Error('system_link_invalid');const data=await call('preview');$('personName').textContent=data.user.display_name;$('personRole').textContent='הרשאות לפי תפקיד: '+(roles[data.user.role]||data.user.role);$('person').hidden=false;$('activate').hidden=false;$('message').textContent='תקף עד '+new Date(data.expires_at).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})+'. לאחר ההפעלה לא נדרש קוד כניסה.';}catch(e){error(e);}}
 $('activate').addEventListener('click',async()=>{if(busy||!token)return;busy=true;$('activate').disabled=true;try{const result=await call('claim');window.IronBendAuth.storeSession(result,true);token='';$('activate').hidden=true;$('lead').textContent='הכניסה נשמרה במכשיר שלך.';$('message').textContent='אפשר לפתוח את המערכת עכשיו ובהמשך להיכנס מהאייקון ללא קוד.';$('message').classList.remove('error');$('openSystem').hidden=false;$('installNote').hidden=false;}catch(e){error(e);$('activate').disabled=false;}finally{busy=false;}});load();
 if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
})();
