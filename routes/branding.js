const router = require('express').Router();

function required(name, value) {
  if (!value) throw new Error(`routes/branding missing dependency: ${name}`);
  return value;
}

module.exports = function createBrandingRouter(deps) {
  const branding = required('branding', deps.branding);

  // מיתוג ציבורי לפני התחברות: שם, לוגו, צבע וטלפון תמיכה.
  // נטען על ידי כל דף דרך public/brand-client.js לפני התחברות.
  router.get('/branding', (req, res) => {
    const { name, logoUrl, primaryColor, supportPhone } = branding.get();
    res.set('Cache-Control', 'public, max-age=60');
    // שליחה כ-JSON מוכן שומרת על גוף התגובה ללא מטא-נתונים של הבקשה.
    res.type('json').send(JSON.stringify({ name, logoUrl, primaryColor, supportPhone }));
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  id: 'branding',
  label: 'מיתוג',
  consumes: [{ table: 'settings' }],
  produces: [],
};
