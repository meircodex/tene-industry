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

  function planInventoryCutting({sources=[],pieces=[],kerfMm=0,groupPolicies={},separateOrders=false,_sourcePreference=null}={}){
    if(!_sourcePreference){
      const variants=['shortest','longest'].map(preference=>planInventoryCutting({sources,pieces,kerfMm,groupPolicies,separateOrders,_sourcePreference:preference}));
      variants.sort((a,b)=>b.pieceCount-a.pieceCount||b.totalCutLengthMm-a.totalCutLengthMm||a.totalWasteMm-b.totalWasteMm||a.bars.length-b.bars.length);
      return variants[0];
    }
    const kerf=nonNegativeNumber(kerfMm),stock=sources.map(source=>({...source,remaining:Math.max(0,Math.floor(Number(source.count)||0))}));
    if(stock.some(source=>!Number.isFinite(source.stockLengthMm)||source.stockLengthMm<=0||!Number.isSafeInteger(source.count)||source.count<0)||new Set(stock.map(source=>String(source.id))).size!==stock.length)throw new Error('רשימת מלאי המוטות אינה תקינה');
    const policies={...groupPolicies};
    for(const diameter of new Set(pieces.map(piece=>piece.diameter))){
      const policy=policies[diameter];if(!policy||policy.allowMixedStockLengths!==false||policy.stockLengthsMm?.length===1)continue;
      const subset=pieces.filter(piece=>piece.diameter===diameter),available=stock.filter(source=>Number(source.diameter)===Number(diameter)&&source.count>0);
      const lengths=[...new Set(available.map(source=>source.stockLengthMm))].filter(length=>!policy.stockLengthsMm?.length||policy.stockLengthsMm.includes(length));
      const variants=lengths.map(length=>({length,plan:planInventoryCutting({sources:available,pieces:subset,kerfMm:kerf,separateOrders,groupPolicies:{[diameter]:{stockLengthsMm:[length]}},_sourcePreference})}));
      variants.sort((a,b)=>b.plan.pieceCount-a.plan.pieceCount||a.plan.totalWasteMm-b.plan.totalWasteMm||a.plan.totalStockLengthMm-b.plan.totalStockLengthMm);
      if(variants.length)policies[diameter]={stockLengthsMm:[variants[0].length]};
    }
    const demand=[],rejected=[];
    for(const piece of pieces){
      const quantity=Number(piece.quantity),lengthMm=Number(piece.lengthMm);
      if(!Number.isSafeInteger(quantity)||quantity<=0||!Number.isFinite(lengthMm)||lengthMm<=0)throw new Error('יש להזין אורכים חיוביים וכמויות שלמות לתוכנית');
      if(demand.length+quantity>100000)throw new Error('התוכנית כוללת יותר מ־100,000 חלקים. יש לפצל את הבחירה לכמה תוכניות.');
      for(let copy=1;copy<=quantity;copy++)demand.push({...piece,quantity:1,copy});
    }
    demand.sort((a,b)=>b.lengthMm-a.lengthMm||String(a.itemId).localeCompare(String(b.itemId))||a.copy-b.copy);
    const groups=new Map(),pools=new Map();
    function insert(pool,bin){let lo=0,hi=pool.length;while(lo<hi){const mid=(lo+hi)>>1;if(pool[mid].wasteMm<=bin.wasteMm)lo=mid+1;else hi=mid;}pool.splice(lo,0,bin);}
    function fit(length,total,count){const endLoss=(count-1)*kerf,remainder=length-total-endLoss;if(Math.abs(remainder)<1e-7)return {kerfLossMm:endLoss,wasteMm:0};if(remainder+1e-7<kerf)return null;return {kerfLossMm:count*kerf,wasteMm:Math.max(0,length-total-count*kerf)};}
    function groupFor(piece){
      const key=piece.groupKey||`${piece.diameter}|${piece.material||'ribbed'}`;
      if(!groups.has(key))groups.set(key,{key,diameter:piece.diameter,material:piece.material,materialLabel:piece.materialLabel||'',bins:[],exact:false});
      return groups.get(key);
    }
    for(const piece of demand){
      const group=groupFor(piece),policy=policies[piece.diameter]||{},poolKey=group.key+(separateOrders?'|order:'+piece.orderId:'');
      if(!pools.has(poolKey))pools.set(poolKey,[]);const pool=pools.get(poolKey);
      const allowed=source=>source.remaining>0&&Number(source.diameter)===Number(piece.diameter)&&(source.material||'ribbed')===(piece.material||'ribbed')&&source.stockLengthMm>=piece.lengthMm
        &&(!piece.grade||piece.grade===source.grade)&&(!piece.standard||piece.standard===source.standard)
        &&(!policy.stockLengthsMm?.length||policy.stockLengthsMm.includes(source.stockLengthMm))&&fit(source.stockLengthMm,piece.lengthMm,1);
      let best=null;
      let lo=0,hi=pool.length;while(lo<hi){const mid=(lo+hi)>>1;if(pool[mid].wasteMm+1e-7<piece.lengthMm)lo=mid+1;else hi=mid;}
      for(let index=lo;index<pool.length;index++){const bin=pool[index];
        if((piece.grade&&piece.grade!==bin.grade)||(piece.standard&&piece.standard!==bin.standard))continue;
        const fitted=fit(bin.stockLengthMm,bin.cutLengthMm+piece.lengthMm,bin.pieces.length+1);
        if(fitted){best={bin,index,...fitted};break;}
      }
      if(best){pool.splice(best.index,1);best.bin.pieces.push(piece);best.bin.cutLengthMm+=piece.lengthMm;best.bin.kerfLossMm=best.kerfLossMm;best.bin.usedMm=best.bin.cutLengthMm+best.kerfLossMm;best.bin.wasteMm=best.wasteMm;insert(pool,best.bin);continue;}
      const source=stock.filter(allowed).sort((a,b)=>(_sourcePreference==='longest'?-1:1)*(a.stockLengthMm-b.stockLengthMm)||String(a.id).localeCompare(String(b.id)))[0];
      if(!source){rejected.push({...piece,reason:'inventory-shortage',quantity:1});continue;}
      source.remaining--;
      const fitted=fit(source.stockLengthMm,piece.lengthMm,1),bin={index:group.bins.length+1,sourceId:source.id,sourceLot:source.lot_number||String(source.id),stockLengthMm:source.stockLengthMm,
        grade:source.grade,standard:source.standard,pieces:[piece],cutLengthMm:piece.lengthMm,kerfLossMm:fitted.kerfLossMm,usedMm:piece.lengthMm+fitted.kerfLossMm,wasteMm:fitted.wasteMm};
      group.bins.push(bin);insert(pool,bin);
    }
    const resultGroups=[...groups.values()].filter(group=>group.bins.length);
    const bars=resultGroups.flatMap(group=>group.bins.map(bin=>({...bin,diameter:group.diameter,material:group.material,groupKey:group.key})));
    const totalStockLengthMm=bars.reduce((s,b)=>s+b.stockLengthMm,0),totalCutLengthMm=bars.reduce((s,b)=>s+b.cutLengthMm,0),totalKerfLossMm=bars.reduce((s,b)=>s+b.kerfLossMm,0),totalWasteMm=bars.reduce((s,b)=>s+b.wasteMm,0);
    const failures=new Map();for(const piece of rejected){const key=String(piece.itemId),old=failures.get(key);if(old)old.quantity++;else failures.set(key,{...piece});}
    return {inventoryConstrained:true,exact:false,complete:!rejected.length,groups:resultGroups,bars,rejected:[...failures.values()],kerfMm:kerf,
      pieceCount:demand.length-rejected.length,totalStockLengthMm,totalCutLengthMm,totalKerfLossMm,totalWasteMm,wastePercent:totalStockLengthMm?100*totalWasteMm/totalStockLengthMm:0,
      sourceUsage:stock.map(source=>({...source,barsUsed:source.count-source.remaining}))};
  }
  return { planCutting, planInventoryCutting, bestFitDecreasing, exactPack };
});
