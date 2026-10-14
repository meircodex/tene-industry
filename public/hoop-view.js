(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IronBendHoopView = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';
  const equal = (a, b) => Math.abs(a - b) < 0.01;
  const right = a => [90, 270, -90].some(n => Math.abs(Number(a) - n) < 0.1);
  function parts(sides, angles = [], explicit = false) {
    const s = (sides || []).map(Number);
    if (![4, 5, 6].includes(s.length) || s.some(n => !Number.isFinite(n) || n <= 0)) return null;
    if (s.length >= 5) {
      // Walk the bar, never sort dimensions: end, side, side, side, side, end.
      if (!equal(s[1], s[3]) || !equal(s[2], s[4])) return null;
      if (!explicit && (angles.length < s.length-1 || !angles.slice(0,s.length-1).every(right))) return null;
      if (explicit && angles.length >= 4 && !angles.slice(1, 4).every(right)) return null;
      return { top:s[2], right:s[1], bottom:s[4], left:s[3], tailStart:s[0], tailEnd:s[5] || 0,
        sideMap:[2,1,4,3], tailMap:[0,5], closure: right(angles[0]) ? 'orthogonal' : 'diagonal' };
    }
    if (!equal(s[0], s[2]) || !equal(s[1], s[3]) || angles.length < 3 || !angles.slice(0,3).every(right)) return null;
    return { top:s[0], right:s[1], bottom:s[2], left:s[3], tailStart:0, tailEnd:0,
      sideMap:[0,1,2,3], tailMap:[], closure:'none' };
  }
  function render(p, width = 300, height = 200) {
    if (!p) return '';
    // One uniform scale, including closure ends. No minimum leg enlargement.
    const scale = Math.min((width - 84) / p.top, (height - 84) / p.right);
    const bw = p.top * scale, bh = p.right * scale;
    const x = (width-bw)/2, y = (height-bh)/2, r=x+bw, b=y+bh;
    const f = n => Number(n).toFixed(3);
    let body = `<path data-hoop-body="1" d="M ${f(x)},${f(y)} L ${f(r)},${f(y)} L ${f(r)},${f(b)} L ${f(x)},${f(b)} Z" fill="none" stroke="#173b6b" stroke-width="3.5" stroke-linejoin="miter"/>`;
    const label = (index,value,lx,ly) => `<text data-dimension-label="1" data-dimension-segment="${index}" data-seg-click="${index}" x="${f(lx)}" y="${f(ly)}" text-anchor="middle" dominant-baseline="middle" font-family="Arial,Heebo" font-weight="800" font-size="14" fill="#173b6b">${Number((value/10).toFixed(2))}</text>`;
    body += label(p.sideMap[0],p.top,(x+r)/2,y-22) + label(p.sideMap[1],p.right,r+27,(y+b)/2)
      + label(p.sideMap[2],p.bottom,(x+r)/2,b+22) + label(p.sideMap[3],p.left,x-27,(y+b)/2);
    if (p.tailStart > 0 || p.tailEnd > 0) {
      const a=p.tailStart*scale, z=p.tailEnd*scale;
      if(!z) {
        body += `<path data-hoop-closure="single-end" d="M ${f(r-Math.min(bw/4,8))},${f(y)} L ${f(r-Math.min(bw/4,8))},${f(y+a)}" fill="none" stroke="#173b6b" stroke-width="3"/>`;
      } else if(p.closure==='orthogonal') {
        // Catalogue: perpendicular closure strokes at the upper-right corner.
        body += `<path data-hoop-closure="orthogonal" d="M ${f(r)},${f(y+a*.3)} L ${f(r-z)},${f(y+a*.3)} M ${f(r-z*.3)},${f(y)} L ${f(r-z*.3)},${f(y+a)}" fill="none" stroke="#173b6b" stroke-width="3"/>`;
      } else {
        body += `<path data-hoop-closure="diagonal" d="M ${f(r)},${f(y)} L ${f(r-a/Math.SQRT2)},${f(y+a/Math.SQRT2)} M ${f(r)},${f(y+3)} L ${f(r-z/Math.SQRT2)},${f(y+3+z/Math.SQRT2)}" fill="none" stroke="#173b6b" stroke-width="3"/>`;
      }
      // End labels have their own rows: they cannot hide the closure strokes.
      const ends = p.tailEnd > 0 ? `עודפי סגירה: ${Number((p.tailStart/10).toFixed(2))} + ${Number((p.tailEnd/10).toFixed(2))}` : `עודף סגירה: ${Number((p.tailStart/10).toFixed(2))}`;
      body += `<text x="${width/2}" y="${height-6}" text-anchor="middle" font-family="Arial,Heebo" font-weight="800" font-size="13" fill="#173b6b">${ends} ס״מ</text>`;
    }
    return `<svg data-shape-kind="closed-stirrup" data-canonical-hoop="1" data-scale-mode="proportional" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;overflow:visible" role="img" aria-label="חישוק — צלעות ועודפי סגירה נפרדים">${body}</svg>`;
  }
  return { parts, render };
});
