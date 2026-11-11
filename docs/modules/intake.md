# מודול: intake — קליטת הזמנות חיצוניות

## מה הוא עושה
קולט הזמנות ממקורות חיצוניים — WhatsApp, מייל, תמונה/PDF — ומעביר אותן לתור אישור לפני יצירה.

---

## מקורות קלט

| מקור | endpoint | מופעל בתנאי |
|------|----------|------------|
| WhatsApp (Meta webhook) | `POST /api/intake/whatsapp` | תמיד |
| תמונה / PDF (OCR) | `POST /api/analyze-image` | `INTAKE_AI_ENABLED=true` |
| מייל (IMAP) | `POST /api/intake/email/poll` | `INTAKE_AI_ENABLED=true` |
| טקסט ידני | `POST /api/intake/parse-text` | תמיד |

---

## זרימה

```
מקור חיצוני
    ↓
intake_log (status: pending_review)
    ↓
צוות משרד מאשר / דוחה
    ↓
POST /api/intake/:id/approve
    ↓
createOrderFromPayload() → orders + pallets + items
    ↓
wsBroadcast('new_order')
```

---

## פלט — מה הוא נותן

| יעד | מה | דרך |
|-----|----|-----|
| מודול orders | הזמנה חדשה | `createOrderFromPayload()` |
| frontend | תור ממתין לאישור | `GET /api/intake/log` |
| מפעל | broadcast הזמנה חדשה | `wsBroadcast('new_order')` |

---

## טבלאות שבבעלותו

| טבלה | תוכן |
|------|------|
| `intake_log` | כל הקלטים — מקור, תוכן גולמי, parsed, סטטוס |
| `intake_training_examples` | דוגמאות תיקון ל-OCR |

---

## AI — analyze-image

### מודל: OpenAI GPT (ממשק responses)
### קלט: תמונה/PDF של טופס הזמנה
### פלט: JSON מובנה עם פריטים (קוטר, צלעות, כמות)
### הגדרה: `OPENAI_API_KEY` ב-settings (לא .env)

---

## WhatsApp webhook

### אימות: `verifyWhatsAppSignature` — HMAC-SHA256 מ-`WHATSAPP_APP_SECRET`
### אימות Meta: `GET /api/intake/whatsapp` עם `hub.verify_token`
### תגובה מיידית: 200 לפני כל עיבוד (Meta דורש תגובה תוך 20 שניות)

---

## קבצים

| קובץ | תוכן |
|------|------|
| `routes/intake.js` | analyze-image and OCR image intake |
| `routes/intakeChannels.js` | WhatsApp webhook and email polling intake |
| `routes/intakeReview.js` | review queue, approve/reject, manual parse |
| `routes/intakeTraining.js` | OCR/AI correction examples and training guidance management |
| `intake.js` | שירות WhatsApp/OCR/Email (module קיים) |
| `services/intakeWorkflow.js` | לוגיקת buildIntakeOrderPayload |

---

## הרשאות

| פעולה | תפקיד מינימלי |
|-------|--------------|
| צפייה בתור | office |
| אישור/דחייה | office |
| הגדרת training | manager |
| analyze-image | office |

---

## סיכונים פתוחים

| # | תיאור | חומרה |
|---|-------|-------|
| BUG-46 | OCR/AI מושבת עד `INTAKE_AI_ENABLED=true` | ידוע |
| — | WhatsApp media (תמונות) מסומנות pending_review ולא מנותחות אוטומטית | בינונית |
