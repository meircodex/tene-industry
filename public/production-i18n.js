(() => {
  const STORAGE_KEY = 'ironbend.production.lang';
  const SUPPORTED = {
    he: { label: 'עברית', dir: 'rtl', name: 'עברית' },
    en: { label: 'English', dir: 'ltr', name: 'English' },
    th: { label: 'ไทย', dir: 'ltr', name: 'ภาษาไทย' },
  };

  const dictionary = {
    en: {
      'טנא תעשיות · תחנת עובד': 'Tene Industry · Worker station',
      'דשבורד איסוף כרטיסים': 'Production card collection',
      'מסנכרן': 'Syncing',
      'חי': 'Live',
      'מתחבר מחדש': 'Reconnecting',
      'תור ייצור': 'Production queue',
      'הזמנה פתוחה': 'Open order',
      'הזמנות ממתינות': 'Waiting orders',
      'אין הזמנות ממתינות': 'No waiting orders',
      'אין הזמנה פתוחה': 'No open order',
      'כרטיסים': 'cards',
      'כרטיס': 'Card',
      'בוצעו': 'completed',
      'לקוח': 'Customer',
      'עדיפות': 'Priority',
      'רגיל': 'Normal',
      'דחוף': 'Urgent',
      'גבוה': 'High',
      'ממתין': 'Waiting',
      'בייצור': 'In production',
      'בוצע': 'Done',
      'הושלם': 'Done',
      'סופק': 'Supplied',
      'כמות': 'Quantity',
      'קוטר': 'Diameter',
      'אורך כללי': 'Total length',
      'משקל רצוי': 'Target weight',
      'משקל מצוי': 'Actual weight',
      'סטייה': 'Deviation',
      'שמור': 'Save',
      'תצוגה קריאה': 'Readable view',
      'לא משויך': 'Unassigned',
      'צורה': 'Shape',
      'מערכת ניהול ייצור תעשייתי': 'Industrial production management',
      'דשבורד': 'Dashboard',
      'הזמנות': 'Orders',
      'חדשה': 'New',
      'מכונה': 'Machine',
      'מכונות': 'Machines',
      'מתחבר...': 'Connecting...',
      'טוען...': 'Loading...',
      'בחר מכונה': 'Select machine',
      'מונה ייצור – בזמן אמת': 'Production counter · live',
      'יחידות יוצרו': 'Units produced',
      'התקדמות': 'Progress',
      'יעד:': 'Target:',
      'עבודה פעילה': 'Active job',
      'אין עבודה פעילה': 'No active job',
      'סטטוס': 'Status',
      'מונה': 'Counter',
      'פעולות': 'Actions',
      'בחר עבודה מהתור': 'Choose job from queue',
      'הכנס עבודה ידנית': 'Manual job',
      'כמות פסולת (אופציונלי):': 'Waste quantity (optional):',
      'סיים עבודה': 'Finish job',
      'ביטול': 'Cancel',
      'עבודה ידנית': 'Manual work',
      'כמות יח\'': 'Qty',
      'אורך / פרימטר (ס"מ)': 'Length / perimeter (cm)',
      'אורך / פרימטר (ס״מ)': 'Length / perimeter (cm)',
      'הערה': 'Note',
      'התחל עבודה': 'Start job',
      'טווחי חוט כפול/בודד משמשים לתעדוף עבודות למכונה המתאימה.': 'Single/double wire ranges prioritize jobs for the right machine.',
      'הגדרות ייצור ותחנות עבודה': 'Production and work-station settings',
      'מכונה חדשה': 'New machine',
      'שם מכונה *': 'Machine name *',
      'הוסף מכונה': 'Add machine',
      'פתח מסך מכונה': 'Open machine screen',
      'משמרת פעילה': 'Active shift',
      'מפעיל': 'Operator',
      'פריטים הושלמו': 'Completed items',
      'טון היום': 'Tons today',
      'פתח משמרת': 'Start shift',
      'סגור משמרת': 'End shift',
      'דיווח עצירה': 'Report stop',
      'כל המכונות': 'All machines',
      'פריטים ממתינים לייצור — ממוינים לפי עדיפות': 'Items waiting for production · sorted by priority',
      'דשבורד איסוף': 'Collection dashboard',
      'רענן': 'Refresh',
      'פתיחת משמרת': 'Start shift',
      'סוג משמרת': 'Shift type',
      'בוקר (07:00-15:00)': 'Morning (07:00-15:00)',
      'צהריים (15:00-23:00)': 'Afternoon (15:00-23:00)',
      'לילה (23:00-07:00)': 'Night (23:00-07:00)',
      '— בחר מפעיל —': '— Select operator —',
      '— כל המכונות —': '— All machines —',
      'דיווח עצירת מכונה': 'Report machine stop',
      '— בחר מכונה —': '— Select machine —',
      'סיבת עצירה': 'Stop reason',
      'הערות': 'Notes',
      'פרטים נוספים...': 'More details...',
      'דווח עצירה': 'Report stop',
      'דיווח פחת': 'Waste report',
      'כמות שיוצרה (יח\')': 'Produced quantity',
      'פחת בפועל (ס"מ)': 'Actual waste (cm)',
      'שמור דיווח': 'Save report',
      'אין פריטים ממתינים לייצור': 'No items waiting for production',
      'אין פריטים': 'No items',
      'פריטים': 'items',
      'פעיל': 'active',
      'עצירה': 'Stop',
      'התחל': 'Start',
      'פחת': 'Waste',
      'משקל': 'Weight',
      'אורך': 'Length',
      'מידות': 'Dimensions',
      'אספקה': 'Delivery',
      'ק״ג': 'kg',
      'ק"ג': 'kg',
      'מ״מ': 'mm',
      'מ"מ': 'mm',
      'יח׳': 'pcs',
      'יח\'': 'pcs',
      'ט': 't',
      'שגיאה': 'Error',
      'נשמר': 'Saved',
      'מכונה נמחקה': 'Machine deleted',
      'שם מכונה חובה': 'Machine name is required',
      'הוספת מכונה נכשלה': 'Adding machine failed',
      'מכונה נוספה': 'Machine added',
      'בחר מכונה תחילה': 'Select a machine first',
      'יש להזין אורך / פרימטר': 'Enter length / perimeter',
      'עבודה ידנית הוקצתה למכונה': 'Manual job assigned to machine',
      'שגיאת שרת:': 'Server error:',
      'שגיאה בטעינה': 'Loading error',
      'לסגור את המשמרת?': 'End this shift?',
      'בחר סיבת עצירה': 'Select a stop reason',
      'עצירה דווחה בהצלחה': 'Stop reported successfully',
      'ממתין לאישור מהמערכת…': 'Waiting for confirmation from the system…',
      'ממתין לאישור': 'Waiting for confirmation',
      'אושר במערכת': 'Confirmed by the system',
      'לא התקבל אישור': 'No confirmation received',
      'אישור קליטה מהמערכת': 'Confirmation that the system recorded the action',
      'נסה שוב': 'Try again',
      'אישור ': 'Confirmation ',
      'סריקת כרטיס ': 'Scan of card ',
      ' נקלטה במערכת.': ' was recorded in the system.',
      'נתוני העבודה בכרטיס ': 'Work details for card ',
      ' נשמרו במערכת.': ' were saved in the system.',
      'הסטטוס בכרטיס ': 'Status of card ',
      ' עודכן ל־': ' was changed to ',
      'שומר במערכת — ממתין לאישור…': 'Saving to the system — waiting for confirmation…',
      'הכרטיס זוהה. ממתין לאישור קליטה מהמערכת…': 'Card identified. Waiting for confirmation that the system recorded the scan…',
      'לא התקבל אישור קליטה מהמערכת. בדוק את החיבור ונסה שוב.': 'No scan confirmation received from the system. Check your connection and try again.',
      'לא התקבל אישור שמירה. ייתכן שהעדכון נקלט; הנתונים נשארו במסך. לחץ נסה שוב כדי לקבל אישור.': 'No save confirmation received. The update may have been saved; your entries remain on screen. Press Try again to get confirmation.',
      'לא התקבל אישור שמירה תקין.': 'No valid save confirmation received.',
      'לא התקבל אישור שהסריקה נרשמה. נסה שוב.': 'No confirmation that the scan was recorded. Try again.',
      'לא התקבל אישור בזמן. ייתכן שהפעולה נקלטה; אפשר לבדוק ולנסות שוב.': 'Confirmation did not arrive in time. The action may have been recorded; check and try again.',
      'לא התקבל אישור תקין מהמערכת. יש לבדוק ולנסות שוב.': 'No valid confirmation received from the system. Check and try again.',
      'אין חיבור למערכת ולא התקבל אישור קליטה.': 'No connection to the system and no confirmation that the action was recorded.',
      'לא התקבל אישור מהמערכת. הנתונים שהזנת נשארו במסך.': 'No confirmation received from the system. Your entries remain on screen.',
      'הנתונים במסך השתנו. לחץ שמור כדי לשלוח את הנתונים החדשים.': 'Your entries have changed. Press Save to send the new details.',
      'קוד הכרטיס אינו תקין. נסה לסרוק שוב.': 'Invalid card code. Scan the card again.',
      'קוד הכרטיס אינו תקין.': 'Invalid card code.',
      'הכרטיס לא נמצא במערכת.': 'The card was not found in the system.',
      'המכשיר אינו מאושר לסריקה. פתח את מסך הסריקה להפעלתו.': 'This device is not approved for scanning. Open the scanner screen to activate it.',
      'אין הרשאה לפעולה הזאת.': 'You do not have permission for this action.',
      'הייצור בכרטיס נעצר בעקבות ביטול.': 'Production for this card was stopped because it was cancelled.',
      'ההזמנה עדיין לא אושרה לייצור.': 'This order has not yet been approved for production.',
      'שינוי לאחור דורש תיקון מורשה במערכת.': 'Reversing the status requires an authorized correction in the system.',
      'הקטנת כמות שבוצעה דורשת תיקון מורשה.': 'Reducing a completed quantity requires an authorized correction.',
      'הכמות שהוזנה גדולה מהכמות בכרטיס.': 'The entered quantity exceeds the quantity on the card.',
      'הפעולה כבר נשלחה עם נתונים אחרים. רענן את הכרטיס לפני עדכון נוסף.': 'This action was already sent with different details. Refresh the card before another update.',
      'יש להזין משקל תקין שאינו שלילי.': 'Enter a valid weight of zero or more.',
      'יש להזין כמות שלמה שאינה שלילית.': 'Enter a whole quantity of zero or more.',
      'תור הייצור עודכן מהמערכת. אפשר לסרוק כרטיס.': 'The production queue is up to date. You can scan a card.',
      'לא התקבל עדכון מהמערכת. בדוק את החיבור ונסה שוב.': 'No update received from the system. Check your connection and try again.',
      'הסריקה נרשמה במערכת.': 'The scan was recorded in the system.',
      'כרטיס המקור אינו זמין. יש לבדוק את הקוד ולנסות שוב לפני תחילת ייצור.': 'The original card is unavailable. Check the code and try again before starting production.',
      'כרטיס המקור אינו זמין. יש לבדוק את הקוד — לא נוצר שרטוט חלופי.': 'The original card is unavailable. Check the code. No replacement drawing was created.',
      'כרטיס העבודה המקורי': 'Original work card',
      'סרוק QR או הקלד מספר כרטיס': 'Scan a QR code or enter a card number',
      'פתח כרטיס': 'Open card',
      'סריקת QR מהכרטיס המודפס תפתח כאן ישירות את הכרטיס לעדכון סטטוס, משקל ועבודה נוכחית.': 'Scan the QR code on the printed card to open it here and update its status, weight and current work.',
      'הכרטיס שנסרק לא נמצא בהזמנה הפתוחה': 'The scanned card was not found in the open order',
      'התחל ייצור': 'Start production',
      'סיים כרטיס': 'Complete card',
      'עדכון עבודה': 'Update work details',
      'ללא מכונה': 'No machine',
      'יוצר': 'Produced',
      'הערת ייצור': 'Production note',
      'יחידות הושלמו': 'units completed',
      'יחידה': 'unit',
    },
    th: {
      'טנא תעשיות · תחנת עובד': 'Tene Industry · สถานีคนงาน',
      'דשבורד איסוף כרטיסים': 'แดชบอร์ดเก็บบัตรผลิต',
      'מסנכרן': 'กำลังซิงค์',
      'חי': 'สด',
      'מתחבר מחדש': 'กำลังเชื่อมต่อใหม่',
      'תור ייצור': 'คิวการผลิต',
      'הזמנה פתוחה': 'งานที่เปิด',
      'הזמנות ממתינות': 'งานที่รอ',
      'אין הזמנות ממתינות': 'ไม่มีงานที่รอ',
      'אין הזמנה פתוחה': 'ไม่มีงานที่เปิด',
      'כרטיסים': 'บัตร',
      'כרטיס': 'บัตร',
      'בוצעו': 'เสร็จแล้ว',
      'לקוח': 'ลูกค้า',
      'עדיפות': 'ความสำคัญ',
      'רגיל': 'ปกติ',
      'דחוף': 'ด่วน',
      'גבוה': 'สูง',
      'ממתין': 'รอ',
      'בייצור': 'กำลังผลิต',
      'בוצע': 'เสร็จ',
      'הושלם': 'เสร็จ',
      'סופק': 'ส่งแล้ว',
      'כמות': 'จำนวน',
      'קוטר': 'เส้นผ่านศูนย์กลาง',
      'אורך כללי': 'ความยาวรวม',
      'משקל רצוי': 'น้ำหนักเป้าหมาย',
      'משקל מצוי': 'น้ำหนักจริง',
      'סטייה': 'ส่วนต่าง',
      'שמור': 'บันทึก',
      'תצוגה קריאה': 'มุมมองอ่านง่าย',
      'לא משויך': 'ยังไม่กำหนด',
      'צורה': 'รูปทรง',
      'מערכת ניהול ייצור תעשייתי': 'ระบบจัดการการผลิตอุตสาหกรรม',
      'דשבורד': 'แดชบอร์ด',
      'הזמנות': 'คำสั่งซื้อ',
      'חדשה': 'ใหม่',
      'מכונה': 'เครื่องจักร',
      'מכונות': 'เครื่องจักร',
      'מתחבר...': 'กำลังเชื่อมต่อ...',
      'טוען...': 'กำลังโหลด...',
      'בחר מכונה': 'เลือกเครื่องจักร',
      'מונה ייצור – בזמן אמת': 'ตัวนับการผลิต · สด',
      'יחידות יוצרו': 'ผลิตแล้ว',
      'התקדמות': 'ความคืบหน้า',
      'יעד:': 'เป้าหมาย:',
      'עבודה פעילה': 'งานที่กำลังทำ',
      'אין עבודה פעילה': 'ไม่มีงานที่กำลังทำ',
      'סטטוס': 'สถานะ',
      'מונה': 'ตัวนับ',
      'פעולות': 'การทำงาน',
      'בחר עבודה מהתור': 'เลือกงานจากคิว',
      'הכנס עבודה ידנית': 'งานแบบกรอกเอง',
      'כמות פסולת (אופציונלי):': 'จำนวนเศษเสีย (ไม่บังคับ):',
      'סיים עבודה': 'จบงาน',
      'ביטול': 'ยกเลิก',
      'עבודה ידנית': 'งานแบบกรอกเอง',
      'כמות יח\'': 'จำนวน',
      'אורך / פרימטר (ס"מ)': 'ความยาว / รอบ (ซม.)',
      'אורך / פרימטר (ס״מ)': 'ความยาว / รอบ (ซม.)',
      'הערה': 'หมายเหตุ',
      'התחל עבודה': 'เริ่มงาน',
      'טווחי חוט כפול/בודד משמשים לתעדוף עבודות למכונה המתאימה.': 'ช่วงลวดเดี่ยว/คู่ใช้จัดลำดับงานให้เครื่องที่เหมาะสม',
      'הגדרות ייצור ותחנות עבודה': 'ตั้งค่าการผลิตและสถานีงาน',
      'מכונה חדשה': 'เครื่องใหม่',
      'שם מכונה *': 'ชื่อเครื่อง *',
      'הוסף מכונה': 'เพิ่มเครื่อง',
      'פתח מסך מכונה': 'เปิดหน้าจอเครื่อง',
      'משמרת פעילה': 'กะที่เปิด',
      'מפעיל': 'ผู้ควบคุม',
      'פריטים הושלמו': 'รายการเสร็จแล้ว',
      'טון היום': 'ตันวันนี้',
      'פתח משמרת': 'เปิดกะ',
      'סגור משמרת': 'ปิดกะ',
      'דיווח עצירה': 'แจ้งหยุด',
      'כל המכונות': 'ทุกเครื่อง',
      'פריטים ממתינים לייצור — ממוינים לפי עדיפות': 'รายการรอผลิต · เรียงตามความสำคัญ',
      'דשבורד איסוף': 'แดชบอร์ดเก็บบัตร',
      'רענן': 'รีเฟรช',
      'פתיחת משמרת': 'เปิดกะ',
      'סוג משמרת': 'ประเภทกะ',
      'בוקר (07:00-15:00)': 'เช้า (07:00-15:00)',
      'צהריים (15:00-23:00)': 'บ่าย (15:00-23:00)',
      'לילה (23:00-07:00)': 'กลางคืน (23:00-07:00)',
      '— בחר מפעיל —': '— เลือกผู้ควบคุม —',
      '— כל המכונות —': '— ทุกเครื่อง —',
      'דיווח עצירת מכונה': 'แจ้งเครื่องหยุด',
      '— בחר מכונה —': '— เลือกเครื่อง —',
      'סיבת עצירה': 'สาเหตุหยุด',
      'הערות': 'หมายเหตุ',
      'פרטים נוספים...': 'รายละเอียดเพิ่มเติม...',
      'דווח עצירה': 'แจ้งหยุด',
      'דיווח פחת': 'รายงานเศษเสีย',
      'כמות שיוצרה (יח\')': 'จำนวนที่ผลิต',
      'פחת בפועל (ס"מ)': 'เศษเสียจริง (ซม.)',
      'שמור דיווח': 'บันทึกรายงาน',
      'אין פריטים ממתינים לייצור': 'ไม่มีรายการรอผลิต',
      'אין פריטים': 'ไม่มีรายการ',
      'פריטים': 'รายการ',
      'פעיל': 'ทำงาน',
      'עצירה': 'หยุด',
      'התחל': 'เริ่ม',
      'פחת': 'เศษเสีย',
      'משקל': 'น้ำหนัก',
      'אורך': 'ความยาว',
      'מידות': 'ขนาด',
      'אספקה': 'ส่งมอบ',
      'ק״ג': 'กก.',
      'ק"ג': 'กก.',
      'מ״מ': 'มม.',
      'מ"מ': 'มม.',
      'יח׳': 'ชิ้น',
      'יח\'': 'ชิ้น',
      'ט': 'ตัน',
      'שגיאה': 'ข้อผิดพลาด',
      'נשמר': 'บันทึกแล้ว',
      'מכונה נמחקה': 'ลบเครื่องแล้ว',
      'שם מכונה חובה': 'ต้องใส่ชื่อเครื่อง',
      'הוספת מכונה נכשלה': 'เพิ่มเครื่องไม่สำเร็จ',
      'מכונה נוספה': 'เพิ่มเครื่องแล้ว',
      'בחר מכונה תחילה': 'เลือกเครื่องก่อน',
      'יש להזין אורך / פרימטר': 'ใส่ความยาว / รอบ',
      'עבודה ידנית הוקצתה למכונה': 'กำหนดงานกรอกเองให้เครื่องแล้ว',
      'שגיאת שרת:': 'ข้อผิดพลาดเซิร์ฟเวอร์:',
      'שגיאה בטעינה': 'โหลดไม่สำเร็จ',
      'לסגור את המשמרת?': 'ปิดกะนี้หรือไม่?',
      'בחר סיבת עצירה': 'เลือกสาเหตุหยุด',
      'עצירה דווחה בהצלחה': 'แจ้งหยุดสำเร็จ',
      'ממתין לאישור מהמערכת…': 'กำลังรอการยืนยันจากระบบ…',
      'ממתין לאישור': 'กำลังรอการยืนยัน',
      'אושר במערכת': 'ระบบยืนยันแล้ว',
      'לא התקבל אישור': 'ยังไม่ได้รับการยืนยัน',
      'אישור קליטה מהמערכת': 'การยืนยันว่าระบบบันทึกรายการแล้ว',
      'נסה שוב': 'ลองอีกครั้ง',
      'אישור ': 'เลขยืนยัน ',
      'סריקת כרטיס ': 'ผลการสแกนบัตร ',
      ' נקלטה במערכת.': ' ถูกบันทึกในระบบแล้ว.',
      'נתוני העבודה בכרטיס ': 'ข้อมูลงานของบัตร ',
      ' נשמרו במערכת.': ' ถูกบันทึกในระบบแล้ว.',
      'הסטטוס בכרטיס ': 'สถานะของบัตร ',
      ' עודכן ל־': ' เปลี่ยนเป็น ',
      'שומר במערכת — ממתין לאישור…': 'กำลังบันทึกในระบบ — รอการยืนยัน…',
      'הכרטיס זוהה. ממתין לאישור קליטה מהמערכת…': 'พบรหัสบัตรแล้ว กำลังรอการยืนยันว่าระบบบันทึกการสแกนแล้ว…',
      'לא התקבל אישור קליטה מהמערכת. בדוק את החיבור ונסה שוב.': 'ยังไม่ได้รับการยืนยันว่าระบบบันทึกการสแกนแล้ว ตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง.',
      'לא התקבל אישור שמירה. ייתכן שהעדכון נקלט; הנתונים נשארו במסך. לחץ נסה שוב כדי לקבל אישור.': 'ยังไม่ได้รับการยืนยันการบันทึก ข้อมูลอาจถูกบันทึกแล้ว ข้อมูลที่กรอกยังอยู่บนหน้าจอ กด ลองอีกครั้ง เพื่อรับการยืนยัน.',
      'לא התקבל אישור שמירה תקין.': 'ยังไม่ได้รับการยืนยันการบันทึกที่ถูกต้อง.',
      'לא התקבל אישור שהסריקה נרשמה. נסה שוב.': 'ยังไม่ได้รับการยืนยันว่าบันทึกการสแกนแล้ว กรุณาลองอีกครั้ง.',
      'לא התקבל אישור בזמן. ייתכן שהפעולה נקלטה; אפשר לבדוק ולנסות שוב.': 'ไม่ได้รับการยืนยันภายในเวลาที่กำหนด รายการอาจถูกบันทึกแล้ว ตรวจสอบแล้วลองอีกครั้ง.',
      'לא התקבל אישור תקין מהמערכת. יש לבדוק ולנסות שוב.': 'ยังไม่ได้รับการยืนยันที่ถูกต้องจากระบบ ตรวจสอบแล้วลองอีกครั้ง.',
      'אין חיבור למערכת ולא התקבל אישור קליטה.': 'ไม่มีการเชื่อมต่อกับระบบ และยังไม่ได้รับการยืนยันว่าบันทึกรายการแล้ว.',
      'לא התקבל אישור מהמערכת. הנתונים שהזנת נשארו במסך.': 'ยังไม่ได้รับการยืนยันจากระบบ ข้อมูลที่กรอกยังอยู่บนหน้าจอ.',
      'הנתונים במסך השתנו. לחץ שמור כדי לשלוח את הנתונים החדשים.': 'ข้อมูลบนหน้าจอเปลี่ยนแล้ว กด บันทึก เพื่อส่งข้อมูลใหม่.',
      'קוד הכרטיס אינו תקין. נסה לסרוק שוב.': 'รหัสบัตรไม่ถูกต้อง กรุณาสแกนบัตรอีกครั้ง.',
      'קוד הכרטיס אינו תקין.': 'รหัสบัตรไม่ถูกต้อง.',
      'הכרטיס לא נמצא במערכת.': 'ไม่พบบัตรนี้ในระบบ.',
      'המכשיר אינו מאושר לסריקה. פתח את מסך הסריקה להפעלתו.': 'อุปกรณ์นี้ยังไม่ได้รับอนุมัติให้สแกน เปิดหน้าสแกนเพื่อเปิดใช้งานอุปกรณ์.',
      'אין הרשאה לפעולה הזאת.': 'คุณไม่มีสิทธิ์ทำรายการนี้.',
      'הייצור בכרטיס נעצר בעקבות ביטול.': 'หยุดการผลิตของบัตรนี้แล้วเนื่องจากมีการยกเลิก.',
      'ההזמנה עדיין לא אושרה לייצור.': 'คำสั่งซื้อนี้ยังไม่ได้รับอนุมัติให้ผลิต.',
      'שינוי לאחור דורש תיקון מורשה במערכת.': 'การย้อนสถานะต้องให้ผู้มีสิทธิ์แก้ไขในระบบ.',
      'הקטנת כמות שבוצעה דורשת תיקון מורשה.': 'การลดจำนวนที่ผลิตแล้วต้องให้ผู้มีสิทธิ์แก้ไข.',
      'הכמות שהוזנה גדולה מהכמות בכרטיס.': 'จำนวนที่กรอกมากกว่าจำนวนในบัตร.',
      'הפעולה כבר נשלחה עם נתונים אחרים. רענן את הכרטיס לפני עדכון נוסף.': 'รายการนี้ถูกส่งด้วยข้อมูลอื่นแล้ว รีเฟรชบัตรก่อนแก้ไขอีกครั้ง.',
      'יש להזין משקל תקין שאינו שלילי.': 'กรอกน้ำหนักที่ถูกต้อง ตั้งแต่ศูนย์ขึ้นไป.',
      'יש להזין כמות שלמה שאינה שלילית.': 'กรอกจำนวนเต็ม ตั้งแต่ศูนย์ขึ้นไป.',
      'תור הייצור עודכן מהמערכת. אפשר לסרוק כרטיס.': 'คิวการผลิตเป็นข้อมูลล่าสุดจากระบบแล้ว สามารถสแกนบัตรได้.',
      'לא התקבל עדכון מהמערכת. בדוק את החיבור ונסה שוב.': 'ยังไม่ได้รับข้อมูลล่าสุดจากระบบ ตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง.',
      'הסריקה נרשמה במערכת.': 'ระบบบันทึกการสแกนแล้ว.',
      'כרטיס המקור אינו זמין. יש לבדוק את הקוד ולנסות שוב לפני תחילת ייצור.': 'ไม่สามารถแสดงบัตรต้นฉบับได้ ตรวจสอบรหัสแล้วลองอีกครั้งก่อนเริ่มผลิต.',
      'כרטיס המקור אינו זמין. יש לבדוק את הקוד — לא נוצר שרטוט חלופי.': 'ไม่สามารถแสดงบัตรต้นฉบับได้ กรุณาตรวจสอบรหัส ระบบไม่ได้สร้างแบบวาดทดแทน.',
      'כרטיס העבודה המקורי': 'บัตรงานต้นฉบับ',
      'סרוק QR או הקלד מספר כרטיס': 'สแกน QR หรือกรอกหมายเลขบัตร',
      'פתח כרטיס': 'เปิดบัตร',
      'סריקת QR מהכרטיס המודפס תפתח כאן ישירות את הכרטיס לעדכון סטטוס, משקל ועבודה נוכחית.': 'สแกน QR บนบัตรที่พิมพ์เพื่อเปิดบัตรที่นี่ แล้วแก้ไขสถานะ น้ำหนัก และข้อมูลงานปัจจุบัน.',
      'הכרטיס שנסרק לא נמצא בהזמנה הפתוחה': 'ไม่พบบัตรที่สแกนในคำสั่งซื้อที่เปิดอยู่',
      'התחל ייצור': 'เริ่มผลิต',
      'סיים כרטיס': 'ผลิตบัตรนี้เสร็จแล้ว',
      'עדכון עבודה': 'แก้ไขข้อมูลงาน',
      'ללא מכונה': 'ไม่ได้กำหนดเครื่องจักร',
      'יוצר': 'ผลิตแล้ว',
      'הערת ייצור': 'หมายเหตุการผลิต',
      'יחידות הושלמו': 'ชิ้นเสร็จแล้ว',
      'יחידה': 'ชิ้น',
    },
  };

  const selectorId = 'productionLanguageSwitcher';
  let observer = null;
  let scheduled = false;
  let activeLang = normalizeLang(localStorage.getItem(STORAGE_KEY) || document.documentElement.lang || 'he');

  function normalizeLang(lang) {
    const code = String(lang || 'he').slice(0, 2).toLowerCase();
    return SUPPORTED[code] ? code : 'he';
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function translateText(text, lang) {
    if (lang === 'he') return text;
    const dict = dictionary[lang] || {};
    let next = text;
    const sorted = Object.keys(dict).sort((a, b) => b.length - a.length);
    for (const source of sorted) {
      next = next.split(source).join(dict[source]);
    }
    return next;
  }

  function rememberOriginal(node, attr) {
    const key = attr ? 'i18nOriginal' + attr[0].toUpperCase() + attr.slice(1) : 'i18nOriginalText';
    const renderedKey = attr ? 'i18nRendered' + attr[0].toUpperCase() + attr.slice(1) : 'i18nRenderedText';
    const current = attr ? (node.getAttribute(attr) || '') : (node.textContent || '');
    if (!(key in node.dataset) || (renderedKey in node.dataset && current !== node.dataset[renderedKey])) {
      node.dataset[key] = current;
    }
    return node.dataset[key];
  }

  function translateElementText(el) {
    if (!el || el.closest('#' + selectorId) || el.matches('script,style,svg,[data-i18n-skip]')) return;
    const children = Array.from(el.childNodes);
    const hasElementChildren = children.some(node => node.nodeType === 1);
    if (!hasElementChildren) {
      const original = rememberOriginal(el);
      const translated = translateText(original, activeLang);
      el.dataset.i18nRenderedText = translated;
      if (el.textContent !== translated) el.textContent = translated;
    } else {
      children.forEach(node => {
        if (node.nodeType !== 3) return;
        if (!node.__i18nOriginalText || (node.__i18nRenderedText && node.textContent !== node.__i18nRenderedText)) {
          node.__i18nOriginalText = node.textContent;
        }
        const translated = translateText(node.__i18nOriginalText, activeLang);
        node.__i18nRenderedText = translated;
        if (node.textContent !== translated) node.textContent = translated;
      });
    }
  }

  function translateAttributes(el) {
    ['placeholder', 'title', 'aria-label', 'value'].forEach(attr => {
      if (!el.hasAttribute(attr)) return;
      if (attr === 'value' && !['INPUT', 'BUTTON'].includes(el.tagName)) return;
      if (attr === 'value' && el.tagName === 'INPUT' && !['button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) return;
      const original = rememberOriginal(el, attr);
      const translated = translateText(original, activeLang);
      const renderedKey = 'i18nRendered' + attr[0].toUpperCase() + attr.slice(1);
      el.dataset[renderedKey] = translated;
      if (el.getAttribute(attr) !== translated) el.setAttribute(attr, translated);
    });
  }

  function applyTranslations(root = document.body) {
    const meta = SUPPORTED[activeLang] || SUPPORTED.he;
    document.documentElement.lang = activeLang;
    document.documentElement.dir = meta.dir;
    document.body && document.body.setAttribute('dir', meta.dir);
    document.body && document.body.classList.toggle('production-ltr', meta.dir === 'ltr');
    document.body && document.body.classList.toggle('production-rtl', meta.dir === 'rtl');

    const nodes = [root, ...Array.from(root.querySelectorAll ? root.querySelectorAll('button,a,label,span,strong,b,small,div,h1,h2,h3,h4,th,td,option,p,input,textarea') : [])];
    nodes.forEach(el => {
      translateElementText(el);
      translateAttributes(el);
    });
  }

  function scheduleTranslate() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyTranslations();
    });
  }

  function setLanguage(lang) {
    activeLang = normalizeLang(lang);
    localStorage.setItem(STORAGE_KEY, activeLang);
    document.querySelectorAll('#' + selectorId + ' button').forEach(button => {
      button.classList.toggle('active', button.dataset.lang === activeLang);
    });
    applyTranslations();
  }

  function installSelector() {
    if (document.getElementById(selectorId)) return;
    const wrap = document.createElement('div');
    wrap.id = selectorId;
    wrap.className = 'production-lang-switcher';
    wrap.setAttribute('dir', 'ltr');
    wrap.innerHTML = Object.entries(SUPPORTED).map(([code, item]) =>
      '<button type="button" data-lang="' + code + '">' + item.label + '</button>'
    ).join('');
    wrap.addEventListener('click', event => {
      const button = event.target.closest('button[data-lang]');
      if (button) setLanguage(button.dataset.lang);
    });
    document.body.appendChild(wrap);
  }

  function installStyle() {
    if (document.getElementById('productionI18nStyle')) return;
    const style = document.createElement('style');
    style.id = 'productionI18nStyle';
    style.textContent = `
      .production-lang-switcher{position:fixed;top:10px;left:12px;z-index:10000;display:flex;gap:4px;padding:4px;background:rgba(255,255,255,.92);border:1px solid rgba(16,35,52,.18);border-radius:10px;box-shadow:0 8px 22px rgba(2,26,72,.12);backdrop-filter:blur(8px)}
      .production-lang-switcher button{border:0;background:transparent;color:#334155;border-radius:7px;padding:6px 9px;font:700 12px/1 Arial,sans-serif;cursor:pointer;white-space:nowrap}
      .production-lang-switcher button.active{background:#e07b39;color:#fff}
      body.production-ltr{direction:ltr}
      body.production-ltr .topnav,body.production-ltr header,body.production-ltr .shift-bar,body.production-ltr .page-header,body.production-ltr .machine-col-header,body.production-ltr .order-head,body.production-ltr .card-head,body.production-ltr .q-col-head{direction:ltr}
      body.production-ltr input,body.production-ltr textarea,body.production-ltr select{direction:ltr;text-align:left}
      body.production-ltr .machine-status-dot,body.production-ltr .item-status-badge,body.production-ltr .q-badge-pri,body.production-ltr .q-col-count,body.production-ltr .queue-weight{margin-right:0;margin-left:auto}
      body.production-ltr .header-actions{margin-right:0;margin-left:auto}
      @media(max-width:700px){.production-lang-switcher{top:auto;bottom:10px;left:10px;right:auto}}
    `;
    document.head.appendChild(style);
  }

  function boot() {
    installStyle();
    installSelector();
    document.querySelectorAll('#' + selectorId + ' button').forEach(button => {
      button.classList.toggle('active', button.dataset.lang === activeLang);
    });
    applyTranslations();
    observer = new MutationObserver(scheduleTranslate);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.IronBendProductionI18n = { setLanguage, getLanguage: () => activeLang, translate: scheduleTranslate };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
