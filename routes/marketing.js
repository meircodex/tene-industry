'use strict';

const { Router } = require('express');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { normalizeWebBaseUrl } = require('../services/publicScanLinks');

const template = readFileSync(path.join(__dirname, '../views/marketing/tene.html'), 'utf8');
const css = readFileSync(path.join(__dirname, '../views/marketing/tene.css'), 'utf8');
const title = 'כיפוף ברזל לבנייה לפי תכנית | טנא תעשיות ברזל';
const description = 'טנא תעשיות ברזל, מפעל לחיתוך וכיפוף ברזל לבנייה לפי תכנית. מזמינים בפורטל, מצרפים שרטוט, מקבלים הצעת מחיר ובוחרים אספקה או איסוף עצמי.';
const legalName = 'טנא תעשיות ברזל בע"מ';
const englishName = 'TENE TAASIOT BARZEL LTD';
const logo = '/brand/tene-pdf-logo.jpg';
const socialImage = '/brand/tene-social.png';

const faq = [
  ['איך מזמינים ברזל לפי תכנית?', 'פותחים הזמנה בפורטל, בונים את הפריטים בעורך הצורות או מצרפים את התכנית להזמנה לבדיקה במשרד.'],
  ['אפשר לצרף תכנית ב-PDF?', 'כן. אפשר לצרף להזמנה קובץ PDF או תמונה של התכנית. צוות המשרד בודק את המסמך.'],
  ['אפשר לקבל הצעת מחיר לפני ההזמנה?', 'כן. הפורטל מציג הצעת מחיר לפי המחירון המאושר ללקוח, כללי או אישי, לפני מע״מ.'],
  ['איך מקבלים גישה לפורטל?', 'נכנסים באמצעות קישור מאובטח או קוד מטנא. לקוחות חדשים יכולים להירשם.'],
  ['אפשר לבחור באיסוף עצמי?', 'כן. בטופס ההזמנה בוחרים אספקה או איסוף עצמי ומציינים תאריך להזמנה.'],
  ['איך עוקבים אחר ההזמנה?', 'בפורטל אפשר לעקוב אחר מצב ההזמנה משליחת הפרטים לבדיקה ועד לאספקה, ולהוריד את ההזמנה כקובץ PDF או להדפיס אותה.'],
];

function required(name, value) {
  if (!value) throw new Error(`routes/marketing missing dependency: ${name}`);
  return value;
}

function escapeMarkup(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, character => entities[character]);
}

function renderLanding(canonical, phone) {
  const business = {
    '@type': 'LocalBusiness',
    name: legalName,
    alternateName: ['Tene Iron Industries', englishName],
    identifier: '517312872',
    taxID: '517312872',
    address: {
      '@type': 'PostalAddress',
      streetAddress: 'רכסים 1',
      addressLocality: 'טנא',
      postalCode: '9040800',
      addressCountry: 'IL',
    },
    image: new URL(socialImage, canonical).href,
    logo: new URL(logo, canonical).href,
    url: canonical,
  };
  const dialNumber = /^[+\d().\s-]+$/.test(phone) ? phone.replace(/[^+\d]/g, '') : '';
  const phoneText = `<bdi>${escapeMarkup(phone)}</bdi>`;
  const phoneLink = /^\+?\d+$/.test(dialNumber)
    ? `<a href="tel:${dialNumber}">${phoneText}</a>`
    : phoneText;
  if (phone) business.telephone = phone;

  const faqSchema = {
    '@type': 'FAQPage',
    mainEntity: faq.map(([name, text]) => ({
      '@type': 'Question',
      name,
      acceptedAnswer: { '@type': 'Answer', text },
    })),
  };
  const values = {
    TITLE: escapeMarkup(title),
    DESCRIPTION: escapeMarkup(description),
    CANONICAL: escapeMarkup(canonical),
    SOCIAL_IMAGE: escapeMarkup(business.image),
    SCHEMA: JSON.stringify({ '@context': 'https://schema.org', '@graph': [business, faqSchema] })
      .replace(/</g, '\\u003c'),
    CSS: css,
    FAQ_LINKS: faq.map(([question], index) =>
      `<li><a href="#faq-${index + 1}">${escapeMarkup(question)}</a></li>`).join('\n'),
    FAQ: faq.map(([question, answer], index) =>
      `<div id="faq-${index + 1}"><dt>${escapeMarkup(question)}</dt><dd>${escapeMarkup(answer)}</dd></div>`).join('\n'),
    HEADER_PHONE: phone ? phoneLink : '',
    FOOTER_PHONE: phone ? `<div>${phoneLink}</div>` : '',
    LEGAL_NAME: escapeMarkup(legalName),
    ENGLISH_NAME: englishName,
    YEAR: new Date().getUTCFullYear(),
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => values[key]);
}

module.exports = function createMarketingRouter(deps) {
  const env = required('env', deps.env);
  const getSupportPhone = required('getSupportPhone', deps.getSupportPhone);
  const router = Router({ caseSensitive: true, strict: true });

  function isMarketingHost(req) {
    const host = req.get('host')?.toLowerCase();
    return (env.MARKETING_HOSTS || '').toLowerCase().split(',').some(entry => entry.trim() === host);
  }

  function canonicalUrl(req, pathname) {
    const host = req.get('host') || 'localhost';
    const requestOrigin = /^[a-z0-9.[\]:-]+$/i.test(host)
      ? normalizeWebBaseUrl(`${req.protocol}://${host}`)
      : '';
    const base = normalizeWebBaseUrl(env.PUBLIC_SITE_URL)
      || normalizeWebBaseUrl(env.BASE_URL)
      || requestOrigin
      || 'http://localhost';
    return new URL(pathname, new URL(base).origin).href;
  }

  function sendLanding(req, res) {
    const canonical = canonicalUrl(req, req.path);
    const phone = String(getSupportPhone() || '').trim();
    const html = renderLanding(canonical, phone);
    res.locals.indexableMarketingPage = true;
    res.set('Cache-Control', 'public, max-age=300').type('html').send(html);
  }

  // Inspect the final type so static HTML, extensionless print routes and HTML errors
  // are all covered, including HTML errors emitted while serving the landing.
  router.use((_req, res, next) => {
    const writeHead = res.writeHead;
    res.writeHead = function writeNonMarketingHead(statusCode, ...args) {
      const type = String(this.getHeader('Content-Type') || '');
      if (!this.locals.indexableMarketingPage && /^text\/html(?:;|$)/i.test(type)) {
        this.setHeader('X-Robots-Tag', 'noindex, nofollow');
      }
      return writeHead.call(this, statusCode, ...args);
    };
    next();
  });

  router.get('/tene', sendLanding);
  router.get('/', (req, res, next) => {
    if (isMarketingHost(req)) return sendLanding(req, res);
    next();
  });
  router.get('/robots.txt', (req, res) => {
    const marketingHost = isMarketingHost(req);
    const sitemap = canonicalUrl(req, '/sitemap.xml');
    res.type('text').send([
      'User-agent: *', 'Allow: /tene', ...(marketingHost ? ['Allow: /'] : []),
      'Disallow: /api/', `Sitemap: ${sitemap}`, '',
    ].join('\n'));
  });
  router.get('/sitemap.xml', (req, res) => {
    const canonical = escapeMarkup(canonicalUrl(req, isMarketingHost(req) ? '/' : '/tene'));
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${canonical}</loc></url></urlset>\n`,
    );
  });

  return router;
};

module.exports.manifest = {
  id: 'marketing',
  label: 'אתר טנא',
  screens: [{ id: 'tene', path: '/tene', label: 'טנא תעשיות ברזל', group: 'external' }],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  consumes: [{ table: 'settings' }],
  produces: [],
};
