(function exposeIronBendDisplayUnits(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IronBendDisplayUnits = api;
}(typeof window !== 'undefined' ? window : globalThis, function buildDisplayUnits() {
  'use strict';

  function finiteNumber(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function millimetersToCentimeters(value) {
    const number = finiteNumber(value);
    return number === null ? null : number / 10;
  }

  function centimetersToMillimeters(value) {
    const number = finiteNumber(value);
    return number === null ? null : number * 10;
  }

  // Presentation only: retain the stored 0..360 angle contract and direction.
  // Do not convert an interior angle into a different (180-angle) convention.
  function signedAngleDegrees(value) {
    const number = finiteNumber(value);
    if (number === null) return null;
    let signed = ((number % 360) + 360) % 360;
    if (signed > 180 || (signed === 180 && number < 0)) signed -= 360;
    return signed === 0 ? 0 : signed;
  }

  function formatSignedAngle(value) {
    const angle = signedAngleDegrees(value);
    if (angle === null) return '—';
    const rounded = Number(angle.toFixed(1));
    return `${rounded > 0 ? '+' : ''}${rounded}°`;
  }

  function formatNumber(value, options = {}) {
    const number = finiteNumber(value);
    if (number === null) return options.fallback ?? '—';
    return number.toLocaleString(options.locale || 'he-IL', {
      minimumFractionDigits: options.minimumFractionDigits ?? 0,
      maximumFractionDigits: options.maximumFractionDigits ?? 3,
      useGrouping: options.useGrouping !== false,
    });
  }

  function formatLengthCmFromMm(value, options = {}) {
    const centimeters = millimetersToCentimeters(value);
    if (centimeters === null) return options.fallback ?? '—';
    const number = formatNumber(centimeters, options);
    return options.withUnit === false ? number : `${number} ס״מ`;
  }

  function formatSteelDiameterMm(value, options = {}) {
    const number = finiteNumber(value);
    if (number === null) return options.fallback ?? '—';
    const formatted = formatNumber(number, { ...options, maximumFractionDigits: options.maximumFractionDigits ?? 1 });
    return options.withUnit === false ? formatted : `Ø${formatted} מ״מ`;
  }

  // Read-only diagram layout. These helpers never change manufacturing lengths
  // or bend angles; editor previews and saved/printed SVGs use the same rules.
  function diagramVisualSides(sides) {
    const clean = (Array.isArray(sides)?sides:[]).map(value=>Math.max(0,Number(value)||0));
    const longest=Math.max(...clean,0);
    return clean.map(value=>value && longest/value>=6 ? Math.max(value,longest*0.14) : value);
  }
  function diagramBaseSegment(points) {
    const edges = points.slice(1).map((point, index) => {
      const dx = point[0] - points[index][0], dy = point[1] - points[index][1];
      return { index, length: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
    });
    if (!edges.length) return { index:0,length:0,angle:0 };
    const middle = Math.floor(edges.length / 2);
    if (edges.length >= 5 && edges.length % 2 === 1 && edges.every((edge,i) => Math.abs(edge.length - edges[edges.length-1-i].length) < Math.max(0.01,edge.length*0.001))) return edges[middle];
    const candidates = edges.map(edge => ({ ...edge, score: edges.reduce((sum,other) => sum + (Math.abs(Math.sin(other.angle-edge.angle)) < 0.001 ? other.length : 0),0) }));
    candidates.sort((a,b) => b.score-a.score || b.length-a.length || Math.abs(a.index-middle)-Math.abs(b.index-middle));
    return candidates[0];
  }

  function diagramDimensionPositions(points, texts, distance = 20) {
    if (!points.length) return [];
    const xs = points.map(p=>p[0]), ys = points.map(p=>p[1]);
    const bounds = { left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys) };
    const center = [xs.reduce((a,b)=>a+b,0)/xs.length,ys.reduce((a,b)=>a+b,0)/ys.length];
    const horizontal = points.slice(1).map((p,i)=>Math.abs(p[1]-points[i][1])<0.1 ? Math.abs(p[0]-points[i][0]) : 0);
    const maxHorizontal = Math.max(...horizontal,0);
    const result = [];
    const intersects = (box,a,b) => {
      let lo=0,hi=1;
      const dx=b[0]-a[0],dy=b[1]-a[1];
      const pairs=[[-dx,a[0]-box.left],[dx,box.right-a[0]],[-dy,a[1]-box.top],[dy,box.bottom-a[1]]];
      for (const [p,q] of pairs) {
        if (Math.abs(p)<1e-9) { if(q<0)return false; }
        else { const t=q/p; if(p<0)lo=Math.max(lo,t);else hi=Math.min(hi,t); if(lo>hi)return false; }
      }
      return true;
    };
    for(let i=0;i<points.length-1;i++) {
      const start=points[i],end=points[i+1],mid=[(start[0]+end[0])/2,(start[1]+end[1])/2];
      const dx=end[0]-start[0],dy=end[1]-start[1],length=Math.hypot(dx,dy)||1;
      let nx=-dy/length,ny=dx/length;
      if((mid[0]-center[0])*nx+(mid[1]-center[1])*ny<0){nx=-nx;ny=-ny;}
      let x=mid[0]+nx*distance,y=mid[1]+ny*distance;
      if(Math.abs(dy)<0.1) {
        // A short collinear continuation (100,16,9) is labelled above the
        // upright, not squeezed between the two labels along the base.
        const shortContinuation=horizontal[i]<maxHorizontal*0.35 && (horizontal[i-1]===maxHorizontal || horizontal[i+1]===maxHorizontal);
        ny=shortContinuation?-1:ny>=0?1:-1;nx=0;
        y=ny<0?bounds.top-distance:bounds.bottom+distance;
      } else if(Math.abs(dx)<0.1){nx=nx>=0?1:-1;ny=0;x=nx<0?bounds.left-distance:bounds.right+distance;}
      // Keep the label on the perpendicular through its own side's midpoint.
      // Return bends use the same rule; never move a side's value to a corner.
      const halfWidth=Math.max(9,String(texts[i]??'').length*3.7+3),halfHeight=9;
      const boxAt=(px,py)=>({left:px-halfWidth,right:px+halfWidth,top:py-halfHeight,bottom:py+halfHeight});
      for(let attempt=0;attempt<8;attempt++) {
        const box=boxAt(x,y);
        const clashes=result.some(row=>box.left<row.box.right+3 && box.right>row.box.left-3 && box.top<row.box.bottom+3 && box.bottom>row.box.top-3)
          || points.slice(1).some((p,j)=>intersects(box,points[j],p));
        if(!clashes)break;
        x+=nx*9;y+=ny*9;
      }
      result.push({ index:i,x,y,mid,nx,ny,box:boxAt(x,y) });
    }
    return result;
  }

  return Object.freeze({
    finiteNumber,
    millimetersToCentimeters,
    centimetersToMillimeters,
    signedAngleDegrees,
    formatSignedAngle,
    formatNumber,
    formatLengthCmFromMm,
    formatSteelDiameterMm,
    diagramBaseSegment,
    diagramDimensionPositions,
    diagramVisualSides,
  });
}));
