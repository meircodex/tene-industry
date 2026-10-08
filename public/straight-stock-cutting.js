(function attachStraightStockCutting(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IronBendStraightStock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildStraightStockCutting() {
  'use strict';

  const MAX_EXACT_PIECES = 60;
  const MAX_EXACT_NODES = 350000;

  function positiveNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function nonNegativeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function normalizedGroupKey(piece) {
    if (piece.groupKey != null && String(piece.groupKey).trim()) return String(piece.groupKey).trim();
    const diameter = String(piece.diameter ?? '').trim() || 'לא ידוע';
    const material = String(piece.material ?? '').trim();
    return material ? `${diameter}|${material}` : diameter;
  }

  function expandPieces(specs, stockLengthMm, kerfMm) {
    const pieces = [];
    const rejected = [];
    for (const spec of specs || []) {
      const lengthMm = Math.round(positiveNumber(spec.lengthMm));
      const quantity = Math.max(0, Math.floor(nonNegativeNumber(spec.quantity)));
      if (!lengthMm || !quantity) continue;
      if (lengthMm > stockLengthMm) {
        rejected.push({ ...spec, lengthMm, quantity, reason: 'longer-than-stock' });
        continue;
      }
      const groupKey = normalizedGroupKey(spec);
      for (let copy = 0; copy < quantity; copy += 1) {
        pieces.push({
          ...spec,
          lengthMm,
          quantity: 1,
          copy: copy + 1,
          groupKey,
          packingLengthMm: lengthMm + kerfMm,
        });
      }
    }
    return { pieces, rejected };
  }

  function bestFitDecreasing(pieces, capacityMm) {
    const sorted = pieces.slice().sort((a, b) => (
      b.packingLengthMm - a.packingLengthMm
      || String(a.itemId ?? a.id ?? '').localeCompare(String(b.itemId ?? b.id ?? ''))
      || a.copy - b.copy
    ));
    const bins = [];
    for (const piece of sorted) {
      let bestIndex = -1;
      let smallestRemainder = Infinity;
      for (let index = 0; index < bins.length; index += 1) {
        const remainder = bins[index].remainingMm - piece.packingLengthMm;
        if (remainder >= 0 && remainder < smallestRemainder) {
          smallestRemainder = remainder;
          bestIndex = index;
        }
      }
      if (bestIndex < 0) {
        bins.push({ remainingMm: capacityMm - piece.packingLengthMm, pieces: [piece] });
      } else {
        bins[bestIndex].pieces.push(piece);
        bins[bestIndex].remainingMm -= piece.packingLengthMm;
      }
    }
    return bins;
  }

  function exactPack(pieces, capacityMm, targetBins, nodeBudget) {
    const sorted = pieces.slice().sort((a, b) => b.packingLengthMm - a.packingLengthMm);
    const remaining = Array(targetBins).fill(capacityMm);
    const assignments = Array.from({ length: targetBins }, () => []);
    let nodes = 0;
    let aborted = false;

    function search(index) {
      nodes += 1;
      if (nodes > nodeBudget) {
        aborted = true;
        return false;
      }
      if (index >= sorted.length) return true;
      const piece = sorted[index];
      const seenRemainders = new Set();
      for (let bin = 0; bin < targetBins; bin += 1) {
        if (remaining[bin] < piece.packingLengthMm || seenRemainders.has(remaining[bin])) continue;
        seenRemainders.add(remaining[bin]);
        const wasEmpty = remaining[bin] === capacityMm;
        remaining[bin] -= piece.packingLengthMm;
        assignments[bin].push(piece);
        if (search(index + 1)) return true;
        assignments[bin].pop();
        remaining[bin] += piece.packingLengthMm;
        if (aborted || wasEmpty) break;
      }
      return false;
    }

    const found = search(0);
    return {
      found,
      aborted,
      bins: found
        ? assignments.filter(bin => bin.length).map((bin, index) => ({ pieces: bin, remainingMm: remaining[index] }))
        : null,
      nodes,
    };
  }

  function packGroup(groupPieces, stockLengthMm, kerfMm) {
    const capacityMm = stockLengthMm + kerfMm;
    const totalPackingMm = groupPieces.reduce((sum, piece) => sum + piece.packingLengthMm, 0);
    const lowerBound = Math.ceil(totalPackingMm / capacityMm);
    let bins = bestFitDecreasing(groupPieces, capacityMm);
    let exact = bins.length === lowerBound;
    let exactSearchAborted = false;

    if (!exact && groupPieces.length <= MAX_EXACT_PIECES) {
      for (let target = lowerBound; target < bins.length; target += 1) {
        const result = exactPack(groupPieces, capacityMm, target, MAX_EXACT_NODES);
        if (result.found) {
          bins = result.bins;
          exact = true;
          break;
        }
        if (result.aborted) {
          exactSearchAborted = true;
          break;
        }
      }
      if (!exactSearchAborted && bins.length > lowerBound) exact = true;
    }

    const normalizedBins = bins.map((bin, index) => {
      const cutLengthMm = bin.pieces.reduce((sum, piece) => sum + piece.lengthMm, 0);
      const kerfLossMm = Math.max(0, bin.pieces.length - 1) * kerfMm;
      return {
        index: index + 1,
        pieces: bin.pieces,
        cutLengthMm,
        kerfLossMm,
        usedMm: cutLengthMm + kerfLossMm,
        wasteMm: Math.max(0, stockLengthMm - cutLengthMm - kerfLossMm),
      };
    });

    return {
      bins: normalizedBins,
      exact,
      lowerBound,
      stockLengthMm,
      totalStockLengthMm: normalizedBins.length * stockLengthMm,
      totalWasteMm: normalizedBins.reduce((sum, bin) => sum + bin.wasteMm, 0),
    };
  }

  function mixedStockPack(groupPieces, stockLengthsMm, kerfMm) {
    const candidates = stockLengthsMm.slice().sort((a, b) => a - b);
    const bins = [];
    const sorted = groupPieces.slice().sort((a, b) => b.packingLengthMm - a.packingLengthMm);
    for (const piece of sorted) {
      let best = null;
      for (let index = 0; index < bins.length; index += 1) {
        const remainingAfter = bins[index].remainingPackingMm - piece.packingLengthMm;
        if (remainingAfter >= 0 && (!best || remainingAfter < best.remainingAfter)) best = { index, remainingAfter };
      }
      if (best) {
        bins[best.index].pieces.push(piece);
        bins[best.index].remainingPackingMm -= piece.packingLengthMm;
        continue;
      }
      const stockLengthMm = candidates.find(length => length + kerfMm >= piece.packingLengthMm);
      if (!stockLengthMm) continue;
      bins.push({
        stockLengthMm,
        remainingPackingMm: stockLengthMm + kerfMm - piece.packingLengthMm,
        pieces: [piece],
      });
    }

    const normalizedBins = bins.map((bin, index) => {
      const cutLengthMm = bin.pieces.reduce((sum, piece) => sum + piece.lengthMm, 0);
      const kerfLossMm = Math.max(0, bin.pieces.length - 1) * kerfMm;
      return {
        index: index + 1,
        stockLengthMm: bin.stockLengthMm,
        pieces: bin.pieces,
        cutLengthMm,
        kerfLossMm,
        usedMm: cutLengthMm + kerfLossMm,
        wasteMm: Math.max(0, bin.stockLengthMm - cutLengthMm - kerfLossMm),
      };
    });
    return {
      bins: normalizedBins,
      exact: false,
      stockLengthMm: null,
      totalStockLengthMm: normalizedBins.reduce((sum, bin) => sum + bin.stockLengthMm, 0),
      totalWasteMm: normalizedBins.reduce((sum, bin) => sum + bin.wasteMm, 0),
    };
  }

  function pickPreferredPlan(plans) {
    return plans.slice().sort((a, b) => (
      a.totalWasteMm - b.totalWasteMm
      || a.totalStockLengthMm - b.totalStockLengthMm
      || a.bins.length - b.bins.length
      || Number(b.stockLengthMm || 0) - Number(a.stockLengthMm || 0)
    ))[0];
  }

  function planCutting({ stockLengthMm, stockLengthsMm, allowMixedStockLengths = false, groupPolicies = {}, kerfMm = 0, pieces = [] } = {}) {
    const availableStocks = [...new Set(
      (Array.isArray(stockLengthsMm) && stockLengthsMm.length ? stockLengthsMm : [stockLengthMm])
        .map(value => Math.round(positiveNumber(value)))
        .filter(Boolean)
    )].sort((a, b) => a - b);
    const stock = availableStocks[availableStocks.length - 1];
    const kerf = Math.round(nonNegativeNumber(kerfMm));
    if (!stock) throw new Error('At least one stock length must be a positive number');

    const expanded = expandPieces(pieces, stock, kerf);
    const grouped = new Map();
    for (const piece of expanded.pieces) {
      if (!grouped.has(piece.groupKey)) grouped.set(piece.groupKey, []);
      grouped.get(piece.groupKey).push(piece);
    }

    const groups = [];
    const policyRejected = [];
    for (const [key, groupPieces] of grouped.entries()) {
      const policy = groupPolicies && typeof groupPolicies === 'object' ? groupPolicies[key] : null;
      const policyStocks = policy?.stockLengthsMm?.length
        ? availableStocks.filter(length => policy.stockLengthsMm.map(Number).includes(length))
        : availableStocks;
      const maxPolicyStock = Math.max(0, ...policyStocks);
      const eligibleGroupPieces = groupPieces.filter(piece => {
        if (piece.lengthMm <= maxPolicyStock) return true;
        policyRejected.push({ ...piece, reason: 'longer-than-selected-stock-policy' });
        return false;
      });
      if (!eligibleGroupPieces.length) continue;
      const uniformPlans = policyStocks
        .filter(length => eligibleGroupPieces.every(piece => piece.lengthMm <= length))
        .map(length => packGroup(eligibleGroupPieces, length, kerf));
      const plans = uniformPlans.slice();
      const groupAllowsMixed = policy?.allowMixedStockLengths == null
        ? allowMixedStockLengths
        : Boolean(policy.allowMixedStockLengths);
      if (groupAllowsMixed && policyStocks.length > 1) {
        const mixed = mixedStockPack(eligibleGroupPieces, policyStocks, kerf);
        if (new Set(mixed.bins.map(bin => bin.stockLengthMm)).size > 1) plans.push(mixed);
      }
      const packed = pickPreferredPlan(plans);
      if (!packed) continue;
      groups.push({
        key,
        diameter: eligibleGroupPieces[0]?.diameter ?? '',
        material: eligibleGroupPieces[0]?.material ?? '',
        pieceCount: eligibleGroupPieces.length,
        policy: {
          stockLengthsMm: policyStocks,
          allowMixedStockLengths: groupAllowsMixed,
        },
        ...packed,
      });
    }
    groups.sort((a, b) => Number(a.diameter) - Number(b.diameter) || String(a.key).localeCompare(String(b.key)));

    const bars = groups.flatMap(group => group.bins.map(bin => ({
      ...bin,
      stockLengthMm: bin.stockLengthMm || group.stockLengthMm,
      groupKey: group.key,
      diameter: group.diameter,
      material: group.material,
    })));
    const acceptedPieces = bars.flatMap(bar => bar.pieces);
    const totalCutLengthMm = acceptedPieces.reduce((sum, piece) => sum + piece.lengthMm, 0);
    const totalKerfLossMm = bars.reduce((sum, bar) => sum + bar.kerfLossMm, 0);
    const totalStockLengthMm = bars.reduce((sum, bar) => sum + bar.stockLengthMm, 0);
    const totalWasteMm = Math.max(0, totalStockLengthMm - totalCutLengthMm - totalKerfLossMm);

    return {
      stockLengthMm: availableStocks.length === 1 ? stock : null,
      stockLengthsMm: availableStocks,
      allowMixedStockLengths: Boolean(allowMixedStockLengths),
      kerfMm: kerf,
      groups,
      bars,
      rejected: [...expanded.rejected, ...policyRejected],
      pieceCount: acceptedPieces.length,
      totalCutLengthMm,
      totalKerfLossMm,
      totalStockLengthMm,
      totalWasteMm,
      wastePercent: totalStockLengthMm ? (totalWasteMm / totalStockLengthMm) * 100 : 0,
      exact: groups.every(group => group.exact),
    };
  }

  return { planCutting, bestFitDecreasing, exactPack };
});
