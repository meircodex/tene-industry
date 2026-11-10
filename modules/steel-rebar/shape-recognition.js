(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.IronBendShapeRecognition=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const EPS=1e-7;
  const add=(a,b)=>a.map((v,i)=>v+b[i]);
  const sub=(a,b)=>a.map((v,i)=>v-b[i]);
  const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm=a=>Math.hypot(...a);
  const scale=(a,k)=>a.map(v=>v*k);
  const rounded=v=>Math.abs(v)<EPS?0:Math.round(v*1e7)/1e7;
  function normalizeRules(value){
    if(value===undefined||value===null)return {version:1,enabled:true,allowReverse:true,allowMirror:false};
    if(!value||value.version!==1||['enabled','allowReverse','allowMirror'].some(key=>typeof value[key]!=='boolean'))return null;
    return {version:1,enabled:value.enabled,allowReverse:value.allowReverse,allowMirror:value.allowMirror};
  }
  function shapeData(value={}){return {...value.data,...value,family:value.family||value.data?.family||'bars'};}
  function pointsFor(shape){
    const lengths=shape.sides,angles=shape.angles;
    if(!Array.isArray(lengths)||!lengths.length||lengths.length>100||lengths.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<=0))return null;
    const real3D=shape.is3d===true||shape.is3d===1;
    if(real3D){
      if(['azAngles','elAngles'].some(key=>!Array.isArray(shape[key])||shape[key].length!==lengths.length||shape[key].some(v=>!Number.isFinite(v))))return null;
    }else if(!Array.isArray(angles)||![lengths.length-1,lengths.length].includes(angles.length)||angles.some(v=>!Number.isFinite(v)||Math.abs(v)>360))return null;
    const points=[[0,0,0]];let direction=0;
    for(let i=0;i<lengths.length;i++){
      if(real3D)direction+=shape.azAngles[i];
      const a=direction*Math.PI/180,e=(real3D?shape.elAngles[i]:0)*Math.PI/180;
      points.push(add(points.at(-1),[lengths[i]*Math.cos(a)*Math.cos(e),lengths[i]*Math.sin(a)*Math.cos(e),lengths[i]*Math.sin(e)]));
      if(!real3D&&i<lengths.length-1)direction-=180-angles[i];
    }
    return points;
  }
  function pathTraits(points,real3D){
    const vectors=points.slice(1).map((point,i)=>sub(point,points[i]));
    const total=vectors.reduce((s,v)=>s+norm(v),0),tol=Math.max(1,total)*EPS;
    const unit=vectors.map(v=>scale(v,1/norm(v)));
    const pairs=[];
    for(let i=0;i<vectors.length;i++)for(let j=i+1;j<vectors.length;j++){
      const len=norm(vectors[i]),u=unit[i],offset=sub(points[j],points[i]);
      if(norm(cross(u,unit[j]))>EPS||norm(cross(u,offset))>tol)continue;
      const a=dot(offset,u),b=dot(sub(points[j+1],points[i]),u);
      if(Math.min(len,Math.max(a,b))-Math.max(0,Math.min(a,b))>tol)pairs.push([i,j]);
    }
    const normal=unit.slice(1).map(u=>cross(unit[0],u)).find(n=>norm(n)>EPS);
    const nonPlanar=Boolean(normal&&unit.some(u=>Math.abs(dot(normal,u))>EPS));
    // Pairwise directions preserve 3D bend order. Signed volume distinguishes
    // handedness; reflecting a product is an explicit catalogue rule.
    const directions=real3D?unit.map(a=>unit.map(b=>rounded(dot(a,b)))):unit.slice(1).map((u,i)=>rounded(Math.atan2(cross(unit[i],u)[2],dot(unit[i],u))));
    const handedness=real3D&&normal?unit.map(u=>rounded(dot(normal,u))):[];
    return {segments:vectors.length,closed:norm(sub(points.at(-1),points[0]))<=tol,overlaps:pairs,nonPlanar,directions,handedness};
  }
  function describe(value){
    const shape=shapeData(value);
    if(!['bars','mesh','spirals','piles','lifts'].includes(shape.family))return {valid:false,error:'משפחת המוצר אינה מוכרת'};
    if(shape.family!=='bars'){
      const kind=shape.family==='spirals'?(shape.shapeType==='ring'||shape.specialty==='ring'?'ring':'spiral'):shape.family;
      const required={mesh:['length','width','longitudinalDiameter','transverseDiameter'],piles:['pileDiameter','pileLength','longitudinalBars','longitudinalDiameter'],lifts:['diameter','barLength'],ring:['barDiameter','ringDiameter'],spiral:['barDiameter','spiralDiameter','turns']}[kind];
      if(required.some(key=>!Number.isFinite(shape[key])||shape[key]<=0))return {valid:false,error:'יש להשלים את מידות המוצר לפני הזיהוי'};
      return {valid:true,family:shape.family,kind,real3D:false,summary:[{mesh:'רשת',piles:'כלוב זיון',lifts:'חבילת מוטות',ring:'טבעת עגולה',spiral:'ספיראלה'}[kind]],fingerprint:JSON.stringify([kind,required.map(key=>shape[key])])};
    }
    const points=pointsFor(shape);
    if(!points)return {valid:false,error:'יש להשלים אורכים וזוויות תקינים לפני הזיהוי'};
    const real3D=shape.is3d===true||shape.is3d===1;
    const kind=shape.roundedBends===true||shape.shapeType==='rounded_end_bar'?'rounded_bar':'polyline_bar';
    const traits=pathTraits(points,real3D);
    const bends=real3D?traits.directions.slice(1).filter((row,i)=>row[i]<1-EPS).length:traits.directions.filter(v=>Math.abs(v)>EPS).length;
    return {valid:true,family:'bars',kind,real3D,...traits,summary:[traits.segments+' צלעות',bends+' כיפופים',traits.closed?'סגורה':'פתוחה',traits.nonPlanar?'יוצאת מהמישור':real3D?'מישורית עם נתוני XYZ':'מישורית',traits.overlaps.length?traits.overlaps.length+' חפיפות':'ללא חפיפות',...(kind==='rounded_bar'?['קצוות מעוגלים']:[])],fingerprint:JSON.stringify([kind,real3D,points.map(p=>p.map(rounded))]),_points:points};
  }
  function same(a,b){
    if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i]));
    return typeof a==='number'&&typeof b==='number'?Math.abs(a-b)<1e-6:a===b;
  }
  function comparePath(a,b){return ['segments','closed','overlaps','nonPlanar','directions','handedness'].every(key=>same(a[key],b[key]));}
  function matches(input,template){
    const rules=normalizeRules(shapeData(template).recognitionRules);
    if(!rules?.enabled)return false;
    const a=describe(input),b=describe(template);
    if(!a.valid||!b.valid||a.family!==b.family||a.kind!==b.kind||a.real3D!==b.real3D)return false;
    if(a.family!=='bars')return true;
    const variants=[a._points];
    if(rules.allowReverse)variants.push([...a._points].reverse());
    if(rules.allowMirror)variants.push(...variants.map(points=>points.map(([x,y,z])=>[x,-y,z])));
    return variants.some(points=>comparePath(pathTraits(points,a.real3D),b));
  }
  function recognize(input,entries=[]){
    const traits=describe(input);
    if(!traits.valid)return {status:'incomplete',traits,candidates:[]};
    const candidates=entries.filter(entry=>entry.code&&entry.source!=='local'&&matches(input,entry.shape));
    return {status:candidates.length===1?'unique':candidates.length?'ambiguous':'unmatched',traits,candidates};
  }
  function publicTraits(shape){const {_points,fingerprint,...traits}=describe(shape);return traits;}
  return {normalizeRules,describe,publicTraits,matches,recognize};
});
