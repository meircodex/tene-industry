# בדיקת אמינות מדדי המלאי — 9.11.2026

## הגדרת המשתמש הקובעת — התיקון הסופי

המשתמש הבהיר שהספירה שמסר היא מה שיש במפעל ושאינו רוצה מדדים לא מאומתים במסך. בהתאם, ההמלצה המוקדמת להציג כרטיס „לא מאומת” בוטלה. המסך הראשי מציג **מלאי נוכחי** ו־**קוטרים במלאי** בלבד. כרטיסי צריכה ורשומות אצוות הוסרו, וגם הודעת פערי העבר. דוח המחקר ובדיקות הכיסוי נשמרו לצורך טיפול פנימי; המסך אינו טוען את ממשק האבחון.

הספירה שאושרה היא בסיס מלאי הפתיחה. המלאי הנוכחי הוא בסיס הספירה ועוד כניסות שאושרו, פחות צריכות וגרוטאות שנרשמו, לרבות התאמות ספירה מאושרות בהמשך. שריון להזמנה מוצג בנפרד ואינו יציאת חומר. אין שחזור או ניכוי גורף של היסטוריית הזמנות ממלאי הפתיחה. ההיסטוריה נשמרת בלי להפוך אותה למדד צריכת מפעל.

האימות הסופי של המסך כולל בדפדפן: הצגת יתרת הספירה, ספירת קוטרים בעלי יתרה חיובית, היעדר כרטיסי צריכה/אצוות/אזהרות לא מאומתות, תאריך בסיס לפי שעון ישראל, ועצמאות היתרה מכשל בבדיקת תאריך. אין קריאה ל־/inventory/metrics מהמסך הראשי. בדיקות לקוח/עשן/ממשל מודולים: 146 עברו לאחר ההבהרה. אין שינוי נוסף בשרת או בנתוני המלאי.

## ממצאים מאומתים בשרת הפעיל

- ספירה מספר 1 אושרה ב־8.11.2026 בשעה 20:56:41 UTC (22:56:41 בישראל). היא כוללת 24 רשומות מלאי. יתרת הפתיחה שנרשמה היא 135,300 ק״ג משוערים: 44 גלילים ו־22 חבילות, לפי אומדן 2,050 ק״ג ליחידה. 21 רשומות חדשות מייצגות את המלאי שנספר; שלוש הרשומות הישנות נספרו לאפס. לכן רשומת מלאי אינה גליל או חבילה בודדים.
- המסך הקודם הציג סכום `raw_material.weight_used` של 9,363.715 ק״ג ללא תקופה, ורק ברשומות פעילות ומאושרות. זהו מונה ישן, לא מדד לצריכה בפועל מתחילת המפעל או מאז הספירה.
- נמצאו 152 תנועות `auto_fifo`, בסך 9,363.722 ק״ג, מ־25.6 עד 7.10.2026. המסלול הישן יכול היה לייחס חומר כבר ביצירת הזמנה. סטטוס הזמנה כשלעצמו אינו אסמכתת צריכת חומר.
- נמצאו 1,163 שריונים שסומנו כנצרכים; ל־1,029 מהם אין תנועת שימוש עם אותו צמד הזמנה/פריט. זהו פער בקישור ובכיסוי, לא הוכחה לכמות חומר חסרה. אין להכפיל או להשלים אוטומטית משקלים על סמך מספר הרשומות.
- קיימים 310 שריונים פתוחים במסלול הישן, גם בהזמנות בשלבים מתקדמים. במסלול זה סיום עבודה אינו מבטיח יצירת הפחתת חומר חדשה. לא נמצאו אירועי צריכה V2 או רשומות צריכה במסלול ההשלמה החדש בזמן הבדיקה. מאז הספירה לא נמצאו תנועות צריכה חדשות. אין להסיק מכך שלא נעשתה עבודה או שלא יצאו הזמנות.

## המלצה ותיקון

1. להסיר את „שימוש מצטבר” מהמדד הראשי. אין בסיס לתת לו כותרת של צריכת מפעל.
2. להציג „צריכה מתועדת מאז אישור ספירה”, עם מספר הספירה, תאריך ושעת האישור. תקופת המדד היא ממועד אישור הספירה במערכת; אין הבטחה לשחזור תנועות בין ספירה פיזית מוקדמת ובין אישורה.
3. לצרף צריכה מתועדת במסלול השלמת ייצור ואירועים מאושרים ב־V2, לאחר קיזוז ביטולי צריכה. שריונים, הזמנות, התאמות ספירה וקבלות חומר אינם נחשבים צריכת ייצור. אין סינון לפי פעילות האצווה בעת חישוב התנועות.
4. כאשר יש שריוני עבר פתוחים, תנועות FIFO לא מאומתות בתקופה, פער בין שינוי המונים ליומן, ספירה חלקית או תמונת בסיס פגומה — להציג „לא מאומת” במקום מספר שמשתמע כצריכה בפועל. פירוט המסך מסביר מה כן נרשם ולמה אין להסיק ממנו צריכה בפועל. גם יומן תקין מתואר כרישומים בלבד; המדד אינו מכסה עבודה שלא דווחה.
5. „מנות מלאי עם יתרה” סופר רשומות מאושרות ופעילות שהיתרה שלהן חיובית. אינו סופר אצוות ריקות ואינו מוצג כמספר גלילים או חבילות. גם מדד הקוטרים נשען על רשומות עם יתרה.
6. נדרש המשך טיפול תפעולי בהזמנות העבר: התאמה פרטנית בין מה שנמשך בפועל, הפחתות שכבר נרשמו ומקור החומר. רק לאחר בירור ניתן לרשום תנועות מתקנות או להעביר הזמנה למסלול צריכה חדש. אין בסיס בטוח לניכוי גורף נוסף מהספירה; הוא עלול להכפיל ניכוי או לנכות עבודה שכבר נכללה בספירה. לקליטות ולעבודות חדשות יש להשתמש בדיווחי צריכה מקושרים לאצווה ולהזמנה ובביטול מתועד במקום עריכת מונים.

## Engineering handoff

Owner: Inventory. D0 reporting/read-only; no schema, stored stock, legacy reservation, order status or machine changes. Scope: `inventoryMetrics`, Inventory GET route, inventory KPI UI, tests and contracts. Existing `/inventory/summary` array remains compatible. New authenticated `GET /api/inventory/metrics` uses warehouse/office/manager/admin roles. A read transaction keeps the counter/journal comparison internally consistent. No period-wide actual-consumption value is claimed (`verified_consumption_kg` remains null).

Latest approved stocktake is a **reporting-period boundary**, not an automatic reset of history and not necessarily a full physical count. Missing snapshots for older lots flag a partial baseline. Comparison includes new lots after the boundary and deactivated lots; adjustments do not become consumption. Existing pre-count historic mismatches remain diagnostics, not invented current-period deductions. A ledger/counter tolerance of 0.01 kg avoids declaring rounding noise a meaningful discrepancy; structural gaps remain explicit.

Rollback: revert reporting code and UI; no data restoration is needed. Do not restore a whole historical DB over later transactions or reset weight_used to zero. Research SQL was read-only. No production order, inventory balance or reservation was edited.

Validation: isolated service tests cover historic counters, stale FIFO, net reversals, inactive lots, zero/pending lots, missing and partial baseline, unexplained counter change, ISO/SQLite timestamps, later receipts and byte-for-byte DB immutability. HTTP authorization and browser checks cover unknown versus recorded zero, explicit local period, no baseline, metrics failure and summary failure. Evidence/screenshots are outside Git under `outputs/inventory-metric-research-20261109/`.

Final complete serial suite: 1,157 passed, 0 failed, 0 skipped. Browser scenarios passed. Summary failures display unknown instead of a fabricated zero. The balance heading now explicitly says recorded inventory, since count estimates and missing movements limit claims about actual physical stock.
