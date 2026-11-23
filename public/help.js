/**
 * IronBend – Help System
 * מוסיף כפתור ? לכל דף עם עזרה מותאמת לדף הנוכחי
 */
(function () {
  const PAGE = document.body.dataset.page || '';

  // ── תוכן עזרה לפי דף ────────────────────────────────────
  const HELP = {
    admin: {
      title: ' ניהול מערכת',
      steps: [
        { icon:'', title:'מודולים', text:'הפעל/כבה כל שירות. WhatsApp, מייל, OCR — כל מה שלא מוגדר אפשר לכבות.' },
        { icon:'', title:'WhatsApp', text:'הכנס Token ו-Phone ID מ-Meta Business. לחץ "בדוק חיבור" לאימות.' },
        { icon:'', title:'מייל', text:'הכנס פרטי IMAP (שרת, פורט, כתובת, סיסמה). המערכת תקרא הזמנות נכנסות כל דקה.' },
        { icon:'', title:'Priority ERP', text:'הכנס כתובת שרת, משתמש וסיסמה. לחץ "בדוק חיבור" — המערכת תסנכרן לקוחות והזמנות.' },
        { icon:'', title:'מכונות', text:'בדוק איזה COM Port מחובר לכל מכונה. תוכל לערוך ולשמור.' },
      ]
    },
    dashboard: {
      title: ' דשבורד ראשי',
      steps: [
        { icon:'', title:'כרטיסי KPI', text:'6 כרטיסים בחלק העליון — הזמנות היום, בייצור, הושלמו, דחופות, פחת%, ממתינות. מתעדכנים כל 15 שניות.' },
        { icon:'', title:'מכונות', text:'כל מכונה מציגה counter (כמה יחידות יצר היום), סטטוס, והזמנה פעילה. כתום = רץ, ירוק = פנוי, אדום = תקלה.' },
        { icon:'', title:'התראות', text:'פאנל ימין מציג התראות פעילות. לחץ  לסגירת התראה.' },
        { icon:'', title:'תור ייצור', text:'הזמנות שנמצאות בייצור כרגע. תאריכים אדומים = איחור.' },
      ]
    },
    orders: {
      title: ' הזמנות',
      steps: [
        { icon:'', title:'הזמנה חדשה', text:'לחץ "הזמנה חדשה" בניווט. אשף 4 שלבים: לקוח → אספקה → פריטים → אישור.' },
        { icon:'', title:'חיפוש וסינון', text:'סנן לפי סטטוס, תאריך, או לקוח. לחץ על שורה לפתיחת פרטי הזמנה.' },
        { icon:'', title:'שינוי סטטוס', text:'פתח הזמנה → שנה סטטוס. הסטטוסים: ממתינה ← בתור ייצור ← בייצור ← הושלם ← בדרך ← סופק.' },
        { icon:'', title:'הדפסת QR', text:'בפרטי הזמנה לחץ "הדפס QR" — מדבקות לכל פריט לסריקה במכונה.' },
      ]
    },
    new: {
      title: ' הזמנה חדשה',
      steps: [
        { icon:'1', title:'שלב 1 – לקוח', text:'חפש לקוח קיים לפי שם/טלפון, או הוסף חדש. אם יש Priority — יסתנכרן אוטומטית.' },
        { icon:'2', title:'שלב 2 – אספקה', text:'בחר תאריך אספקה, כתובת, ועדיפות (רגיל/דחוף). הגדרת "דחוף" תציג התראה בדשבורד.' },
        { icon:'3', title:'שלב 3 – פריטים', text:'הוסף פלטות ופריטים. לכל פריט: קוטר, צורה (L/U/Z/מלבן...), אורך ממדים, כמות. המשקל מחושב אוטומטית.' },
        { icon:'4', title:'שלב 4 – אישור', text:'סיכום ההזמנה עם משקל כולל. לחץ "שמור" — ההזמנה נכנסת לתור.' },
      ]
    },
    machine: {
      title: ' תחנת מכונה',
      steps: [
        { icon:'', title:'סריקת QR', text:'סרוק את מדבקת ה-QR על הפריט. המערכת תעדכן את הפריט ל"בייצור" ותשלח פרמטרים למכונה.' },
        { icon:'⌨', title:'קלט ידני', text:'אם אין סורק — הכנס את קוד הפריט ידנית בשדה הקלט.' },
        { icon:'', title:'סיום פריט', text:'סרוק שוב את אותו QR לסיום. המערכת תחשב פחת אוטומטית ותעדכן counter.' },
        { icon:'', title:'Counter', text:'ה-counter מציג כמה יחידות יוצרו מהמכונה היום. מתאפס בתחילת כל יום.' },
      ]
    },
    reports: {
      title: ' דוחות וניתוח',
      steps: [
        { icon:'', title:'סינון תאריכים', text:'בחר תאריכי התחלה וסיום. כל הגרפים יתעדכנו לפי הטווח שנבחר.' },
        { icon:'', title:'גרפי ייצור', text:'גרף עמודות — הזמנות לפי יום. גרף קו — משקל ייצור. עוגה — חלוקת סטטוסים.' },
        { icon:'', title:'ניתוח פחת', text:'פחת לפי מכונה וקוטר. צבע אדום = פחת גבוה (מעל 10%). זה מקום לשיפור.' },
        { icon:'', title:'ייצוא CSV', text:'לחץ "ייצוא CSV" לקבלת קובץ אקסל עם כל הנתונים.' },
      ]
    },
    driver: {
      title: ' אפליקציית נהג',
      steps: [
        { icon:'', title:'בחירת נהג', text:'בפתיחה בחר את שמך מהרשימה. האפליקציה זוכרת אותך בפעם הבאה.' },
        { icon:'', title:'משלוחים היום', text:'רשימת כל המשלוחים לתאריך שנבחר. לחץ על משלוח לפרטים וניווט.' },
        { icon:'', title:'ניווט', text:'לחץ "נווט" לפתיחת Waze/Maps עם כתובת היעד. GPS מעקב פועל ברקע.' },
        { icon:'', title:'חתימה ואישור', text:'בהגעה — לחץ "אישור מסירה", קבל חתימה על המסך, ולחץ "שמור".' },
      ]
    },
    holdings: {
      title: ' לוח אחזקות',
      steps: [
        { icon:'', title:'תצוגה מאוחדת', text:'המספרים בחלק העליון הם משוקללים לפי אחוז האחזקה שלך. IronBend 100% = נספר מלא. הרי מדבר 50% = נספר בחצי.' },
        { icon:'', title:'כרטיסי חברה', text:'לכל חברה כרטיס עם KPIs, סטטוס ERP, ואחוז אחזקה.' },
        { icon:'', title:'עריכת חברה', text:'לחץ "עריכה" לשינוי אחוז אחזקה, סוג ERP, שם ואות זיהוי.' },
        { icon:'', title:'חברה חדשה', text:'לחץ "+ חברה חדשה" בפינה. הכנס שם, אחוז אחזקה, וסוג ERP.' },
      ]
    },
  };

  const helpData = HELP[PAGE] || {
    title: ' עזרה',
    steps: [{ icon:'', title:'ניווט', text:'השתמש בסרגל הניווט העליון לעבור בין מודולים.' }]
  };

  // ── Build UI ──────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #help-btn { display: none; }
    #help-overlay {
      position: fixed; inset: 0; z-index: 950;
      background: rgba(20,40,60,0.45);
      display: none; align-items: center; justify-content: center;
      padding: 20px;
    }
    #help-overlay.open { display: flex; }
    #help-panel {
      background: #fff; border-radius: 16px;
      width: 320px; max-height: 80vh;
      box-shadow: 0 20px 60px rgba(0,0,0,0.20);
      overflow: hidden; display: flex; flex-direction: column;
      font-family: 'Heebo', sans-serif;
      animation: slideUp .25s ease;
    }
    @keyframes slideUp { from { transform: translateY(20px); opacity:0 } to { transform:translateY(0); opacity:1 } }
    #help-head {
      background: #1A2330;
      color: #fff; padding: 16px 18px;
      display: flex; align-items: center; justify-content: space-between;
      border-bottom: 3px solid #C45C12;
    }
    #help-head-title { font-size: 15px; font-weight: 800; }
    #help-close {
      background: rgba(255,255,255,0.25); border: none; color: #fff;
      width: 28px; height: 28px; border-radius: 50%; font-size: 14px;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    #help-body { overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .help-step {
      background: #f8fafc; border: 1px solid rgba(0,0,0,0.07);
      border-radius: 10px; padding: 12px 14px;
      display: flex; gap: 12px; align-items: flex-start;
    }
    .help-step-icon { font-size: 20px; flex-shrink: 0; margin-top: 1px; }
    .help-step-title { font-size: 13px; font-weight: 800; color: #1a2533; margin-bottom: 3px; }
    .help-step-text  { font-size: 12px; color: #526070; line-height: 1.5; }
    #help-footer {
      padding: 12px 14px; border-top: 1px solid rgba(0,0,0,0.07);
      text-align: center; font-size: 11px; color: #8fa0b0;
    }
    @media (max-width: 600px) {
      #help-panel { width: calc(100vw - 40px); }
      #help-btn   { bottom: 74px; }
    }
  `;
  document.head.appendChild(style);

  // Button
  const btn = document.createElement('button');
  btn.id = 'help-btn';
  btn.title = 'עזרה';
  btn.textContent = '?';

  // Overlay
  const overlay = document.createElement('div');
  overlay.id = 'help-overlay';
  overlay.innerHTML = `
    <div id="help-panel">
      <div id="help-head">
        <span id="help-head-title">${helpData.title}</span>
        <button id="help-close"></button>
      </div>
      <div id="help-body">
        ${helpData.steps.map(s => `
          <div class="help-step">
            <div>
              <div class="help-step-title">${s.title}</div>
              <div class="help-step-text">${s.text}</div>
            </div>
          </div>`).join('')}
      </div>
      <div id="help-footer">לחץ מחוץ לחלון לסגירה • IronBend v1.0</div>
    </div>`;

  document.body.appendChild(btn);
  document.body.appendChild(overlay);

  btn.addEventListener('click', () => overlay.classList.add('open'));
  document.getElementById('help-close').addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
})();
