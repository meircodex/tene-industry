'use strict';

// Server-side budget decision for portal order creation.  This deliberately
// has no approval bypass: an over-budget order is rejected until a separate,
// auditable overrun workflow exists.
function evaluatePortalBudget({ db, customerId, siteId, amount = 0, kg = 0, exposeFinancialDetails = false }) {
  if (!siteId) return { ok: true, overBudget: false };
  const site = db.prepare(`
    SELECT id,budget_amount,budget_kg,block_over_budget
    FROM customer_sites WHERE id=? AND customer_id=?
  `).get(siteId, customerId);
  if (!site) return { ok: false, status: 403, error: 'האתר לא נמצא אצל הלקוח' };
  const used = db.prepare(`
    SELECT COALESCE(SUM(billing_weight),0) AS kg,
           COALESCE(SUM(portal_price),0) AS amount
    FROM orders
    WHERE customer_id=? AND site_id=?
      AND COALESCE(status,'') NOT LIKE '%בוטל%'
      AND COALESCE(status,'') NOT IN ('ביטול','cancelled','cancelled_by_customer')
  `).get(customerId, siteId);
  const projectedKg = Number(used.kg || 0) + Number(kg || 0);
  const projectedAmount = Number(used.amount || 0) + Number(amount || 0);
  const amountExceeded = Number(site.budget_amount || 0) > 0 && projectedAmount > Number(site.budget_amount);
  const kgExceeded = Number(site.budget_kg || 0) > 0 && projectedKg > Number(site.budget_kg);
  if (site.block_over_budget && (amountExceeded || kgExceeded)) {
    const result = { ok: false, status: 409, error: 'ההזמנה חורגת מתקציב האתר', code: 'over_budget' };
    if (exposeFinancialDetails) {
      result.budget = { amount: Number(site.budget_amount || 0), kg: Number(site.budget_kg || 0) };
      result.projected = { amount: projectedAmount, kg: projectedKg };
    } else {
      result.projected = { kg: projectedKg };
    }
    return result;
  }
  return { ok: true, overBudget: amountExceeded || kgExceeded, projected: { amount: projectedAmount, kg: projectedKg } };
}

module.exports = { evaluatePortalBudget };
