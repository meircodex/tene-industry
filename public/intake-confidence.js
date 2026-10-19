(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.IronBendIntakeConfidence = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function ratio(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null;
    return value > 1 ? value / 100 : value;
  }
  function forPath(parsed = {}, path = '') {
    const parts = path.split('.');
    const field = parts.at(-1);
    const aliases = {
      total_length_mm: ['total_length_mm', 'length_mm', 'total_length_cm', 'length'],
      shape_name: ['shape_name', 'shape'], quantity: ['quantity', 'qty'],
    }[field] || [field];
    const item = parts[0] === 'items' ? parsed.items?.[Number(parts[1])] : null;
    const maps = item ? [item.field_confidence, item.confidence_map, item.confidenceByField, item.confidence] : [];
    for (const map of maps) {
      for (const key of aliases) {
        const score = ratio(map?.[key]);
        if (score !== null) return score;
      }
    }
    for (const key of aliases) {
      const score = ratio(item?.fields?.[key]?.confidence);
      if (score !== null) return score;
    }
    for (const map of [parsed.confidence, parsed.confidence_map, parsed.field_confidence, parsed.confidenceByField]) {
      const score = ratio(map?.[path] ?? (parts[0] === 'items' ? undefined : map?.[field]));
      if (score !== null) return score;
    }
    return null;
  }
  function itemScore(parsed, index) {
    const values = ['diameter', 'total_length_mm', 'quantity', 'shape_name'].map(field => forPath(parsed, `items.${index}.${field}`));
    // A partial set of confidence values is not an overall confidence score.
    return values.every(value => value !== null) ? Math.round(Math.min(...values) * 100) : null;
  }
  return { forPath, itemScore };
});
