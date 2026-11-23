// Intake module – Email, WhatsApp, OCR processing
// Reads orders from multiple channels and normalizes them for the DB
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ── OCR – Google Cloud Vision ─────────────────────────────────────
async function runOCR(imageBuffer, options = {}) {
  const apiKey = options.apiKey || process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_VISION_API_KEY לא מוגדר ב-.env');

  const b64 = imageBuffer.toString('base64');
  const res = await axios.post(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      requests: [{
        image: { content: b64 },
        features: [
          { type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 },
        ],
        imageContext: { languageHints: ['he', 'iw', 'en'] },
      }],
    },
    { timeout: 20000 }
  );

  const annotation = res.data.responses[0];
  return {
    fullText: annotation.fullTextAnnotation?.text || '',
    pages:    annotation.fullTextAnnotation?.pages || [],
    rawResponse: annotation,
  };
}

// ── Parse OCR text for order data ────────────────────────────────
// Returns a partial order object extracted from text
function parseOCRText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const result = {
    customerName:    null,
    customerPhone:   null,
    deliveryDate:    null,
    deliveryAddress: null,
    items:           [],
    rawLines:        lines,
  };

  // Phone: look for Israeli phone patterns
  const phoneMatch = text.match(/0[5-9][0-9\-\s]{8,12}/);
  if (phoneMatch) result.customerPhone = phoneMatch[0].replace(/[\s\-]/g, '').slice(0, 10);

  // Date: look for dates DD/MM/YYYY or DD.MM.YYYY
  const dateMatch = text.match(/(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](2\d{3})/);
  if (dateMatch) {
    const [, d, m, y] = dateMatch;
    result.deliveryDate = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // Iron items: look for patterns like "Ø12 × 6000 × 50" or "12mm 6m 100pcs"
  const itemPatterns = [
    // Pattern: diameter length quantity (all on one line)
    /(?:Ø|ø|קוטר\s*)?(\d{1,2})\s*(?:מ"מ|mm)?\s*[×x\*]\s*(\d{3,6})\s*(?:מ"מ|mm|מ'|m)?\s*[×x\*]\s*(\d+)/gi,
    // Pattern: number number number (might be diam/length/qty)
    /^[ \t]*(\d{1,2})[ \t]+(\d{3,6})[ \t]+(\d+)/gm,
  ];

  for (const pattern of itemPatterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const diameter = Number(match[1]);
      const length   = Number(match[2]);
      const qty      = Number(match[3]);
      if (diameter >= 6 && diameter <= 40 && length >= 100 && qty >= 1) {
        result.items.push({ diameter, length, qty });
      }
    }
  }

  return result;
}

// ── WhatsApp message parser ────────────────────────────────────────
function parseWhatsAppMessage(messageBody) {
  // Try to extract order info from a WhatsApp text message
  const text = messageBody.trim();
  const parsed = parseOCRText(text); // reuse same parser

  // Additional WhatsApp-specific patterns
  const addressMatch = text.match(/(?:כתובת|אתר|בניין)[:\s]+(.+?)(?:\n|$)/i);
  if (addressMatch) parsed.deliveryAddress = addressMatch[1].trim();

  const nameMatch = text.match(/(?:שם|לקוח|חברה)[:\s]+(.+?)(?:\n|$)/i);
  if (nameMatch) parsed.customerName = nameMatch[1].trim();

  return parsed;
}

// ── Send WhatsApp message ─────────────────────────────────────────
async function sendWhatsApp(toPhone, message) {
  const token   = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) {
    console.log('[WhatsApp] Not configured. Would send to', toPhone, ':', message);
    return null;
  }

  const res = await axios.post(
    `https://graph.facebook.com/v18.0/${phoneId}/messages`,
    {
      messaging_product: 'whatsapp',
      to: toPhone.replace(/[^0-9]/g, ''),
      type: 'text',
      text: { body: message },
    },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    }
  );
  return res.data;
}

// ── Send WhatsApp order status update ────────────────────────────
async function notifyOrderStatus(customerPhone, orderNum, status) {
  const messages = {
    'בייצור':                `✅ הזמנה ${orderNum} – הייצור החל!`,
    'הושלם – ממתין לאיסוף': `✅ הזמנה ${orderNum} – הייצור הסתיים, ממתין לאיסוף`,
    'בדרך ללקוח':            `🚚 הזמנה ${orderNum} – בדרך אליכם!`,
    'סופק – אושר':           `✅ הזמנה ${orderNum} – סופקה בהצלחה. תודה!`,
    'בוטל':                  `❌ הזמנה ${orderNum} – בוטלה. לפרטים צרו קשר.`,
  };
  const msg = messages[status];
  if (!msg || !customerPhone) return;
  return sendWhatsApp(customerPhone, msg);
}

// ── Gemini email classifier ───────────────────────────────────────
// Returns { is_order, customer_name, customer_phone, delivery_date,
//           delivery_address, notes, items: [{diameter,length,qty,shape,notes}] }
async function classifyEmailWithGemini(text, apiKey) {
  if (!apiKey) return null;
  const prompt = `אתה מערכת ניהול הזמנות למפעל כיפוף ברזל.
קרא את המייל הבא וענה ב-JSON בלבד (ללא הסבר, ללא markdown).

קבע:
1. is_order: האם זו הזמנת ברזל? (true/false)
2. אם כן, חלץ את השדות:
   - customer_name: שם הלקוח / חברה
   - customer_phone: טלפון (ספרות בלבד, ללא מקפים)
   - delivery_date: תאריך אספקה בפורמט YYYY-MM-DD (null אם אין)
   - delivery_address: כתובת אספקה
   - notes: הערות כלליות
   - items: מערך פריטים. כל פריט:
       { "diameter": קוטר במ"מ (מספר), "length": אורך במ"מ (מספר),
         "qty": כמות (מספר), "shape": שם צורה (string, יכול להיות null), "notes": "" }

דוגמה לתגובה תקינה:
{"is_order":true,"customer_name":"אבי כהן","customer_phone":"0521234567",
 "delivery_date":"2025-06-01","delivery_address":"רחוב הרצל 5 תל אביב",
 "notes":"","items":[{"diameter":12,"length":6000,"qty":50,"shape":"U","notes":""}]}

אם אינה הזמנה: {"is_order":false}

המייל:
${text.slice(0, 3000)}`;

  try {
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,
      { contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    let raw = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error('[Gemini] שגיאת סיווג מייל:', err.message);
    return null;
  }
}

// ── Email polling ─────────────────────────────────────────────────
// cfg: { host, user, pass, port, geminiKey }
async function pollEmail(db, cfg = {}) {
  const host = cfg.host || process.env.EMAIL_IMAP_HOST;
  const user = cfg.user || process.env.EMAIL_IMAP_USER;
  const pass = cfg.pass || process.env.EMAIL_IMAP_PASS;
  const port = Number(cfg.port || process.env.EMAIL_IMAP_PORT || 993);
  const geminiKey = cfg.geminiKey || process.env.GEMINI_API_KEY;

  if (!host || !user || !pass) {
    console.log('[Email] IMAP לא מוגדר');
    return [];
  }

  let ImapFlow;
  try { ImapFlow = require('imapflow'); } catch { console.log('[Email] imapflow לא מותקן'); return []; }

  const client = new ImapFlow.ImapFlow({
    host, port, secure: true, auth: { user, pass }, logger: false,
  });

  const results = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - 86400000); // last 24h
      const msgs  = await client.search({ seen: false, since });

      for (const uid of msgs.slice(0, 10)) {
        const msg    = await client.fetchOne(uid, { source: true, envelope: true });
        const source = msg.source.toString('utf-8');

        // Extract plain text body
        const textMatch = source.match(/Content-Type: text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)(?:\r\n--|\r\n\r\n--)/i);
        const bodyText  = (textMatch ? textMatch[1] : source).slice(0, 3000);

        const from    = msg.envelope?.from?.[0]?.address || '';
        const subject = msg.envelope?.subject || '';

        // Classify with Gemini
        const gemini = await classifyEmailWithGemini(`נושא: ${subject}\n\n${bodyText}`, geminiKey);

        if (!gemini || !gemini.is_order) {
          // Not an order — mark as seen and skip
          await client.messageFlagsAdd(uid, ['\\Seen']);
          console.log(`[Email] לא הזמנה: "${subject}" מ-${from}`);
          continue;
        }

        // It's an order → save to intake_log as pending_review
        const parsed = { ...gemini, from, subject, source: 'email' };
        db.prepare(`INSERT INTO intake_log (source, raw_content, parsed_data, status) VALUES (?,?,?,?)`)
          .run('email', bodyText, JSON.stringify(parsed), 'pending_review');

        results.push(parsed);
        await client.messageFlagsAdd(uid, ['\\Seen']);
        console.log(`[Email] הזמנה זוהתה: "${subject}" מ-${from}`);
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.error('[Email] שגיאה:', err.message);
  }
  return results;
}

module.exports = { runOCR, parseOCRText, parseWhatsAppMessage, sendWhatsApp, notifyOrderStatus, pollEmail };
