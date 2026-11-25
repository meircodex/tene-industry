'use strict';

const { formatPortalDate, withoutPlaceholderDate } = require('../public/portal-dates');

const businessDateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem' });

function portalBusinessDate(now = new Date()) {
  return businessDateFormatter.format(now);
}

function isPortalDeliveryDateValid(value, today = portalBusinessDate()) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < today) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

module.exports = { formatPortalDate, isPortalDeliveryDateValid, withoutPlaceholderDate };
