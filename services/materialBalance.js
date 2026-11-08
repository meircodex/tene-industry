'use strict';

const kg = value => Number(Number(value || 0).toFixed(3));
function materialOnHand(row) {
  return kg(Number(row.weight_received || 0) + Number(row.stock_adjustment_kg || 0)
    - Number(row.weight_used || 0) - Number(row.weight_scrapped || 0));
}
// SQL consumers use the same formula. The optional-column fallback is for old
// read-only diagnostic fixtures; production startup installs the additive column.
function materialOnHandSql(db, alias = '') {
  if (!/^[a-z_]*$/i.test(alias)) throw new Error('invalid_material_alias');
  const p = alias ? `${alias}.` : '';
  const adjustment = db.pragma('table_info(raw_material)').some(c => c.name === 'stock_adjustment_kg')
    ? ` + COALESCE(${p}stock_adjustment_kg,0)` : '';
  return `(COALESCE(${p}weight_received,0)${adjustment} - COALESCE(${p}weight_used,0) - COALESCE(${p}weight_scrapped,0))`;
}
module.exports = { kg, materialOnHand, materialOnHandSql };
