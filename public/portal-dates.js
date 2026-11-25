'use strict';

(function (root) {
  // Use the calendar date recorded by the API in every display timezone.
  function formatPortalDate(value, { withTime = false } = {}) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(String(value ?? '').trim());
    if (!parts) return '';
    const [, year, month, day, time] = parts;
    const date = `${day}/${month}/${year}`;
    return withTime && time ? `${date} ${time}` : date;
  }

  function withoutPlaceholderDate(value) {
    return value && !/^2020-01-01(?:$|[ T])/.test(String(value)) ? value : null;
  }

  function maskPortalDate(input) {
    input.setCustomValidity('');
    const previous = input.value;
    const localized = formatPortalDate(previous) || previous;
    const digits = localized.replace(/\D/g, '').slice(0, 8);
    const value = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/');
    if (value === previous) return;

    const digitsBeforeCaret = previous.slice(0, input.selectionStart).replace(/\D/g, '').length;
    const caret = digitsBeforeCaret + Number(digitsBeforeCaret > 2) + Number(digitsBeforeCaret > 4);
    input.value = value;
    input.setSelectionRange(caret, caret);
  }

  function parsePortalDate(value) {
    const localized = value.trim().replace(/^(\d{2})(\d{2})(\d{4})$/, '$1/$2/$3');
    if (!localized) return '';
    const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(localized);
    if (!parts || parts[3] === '0000') return null;
    const iso = `${parts[3]}-${parts[2]}-${parts[1]}`;
    const date = new Date(iso + 'T00:00:00Z');
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
  }

  function readPortalDate(input) {
    const iso = parsePortalDate(input.value);
    if (iso === null) {
      input.setCustomValidity('יש להזין תאריך תקין בפורמט יום/חודש/שנה.');
      input.reportValidity();
    }
    return iso;
  }

  const dates = { formatPortalDate, withoutPlaceholderDate, maskPortalDate, parsePortalDate, readPortalDate };
  if (typeof module === 'object' && module.exports) module.exports = dates;
  else root.IronBendPortalDates = dates;
})(typeof window === 'undefined' ? globalThis : window);
