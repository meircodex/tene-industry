'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FaultAnnotation=api;})(typeof window!=='undefined'?window:this,function(){
  const clamp=(v,max)=>Math.max(0,Math.min(max,v));
  function point(event,rect,width,height){return{x:clamp((event.clientX-rect.left)*width/rect.width,width),y:clamp((event.clientY-rect.top)*height/rect.height,height)};}
  function arrowHead(a,b,size){const angle=Math.atan2(b.y-a.y,b.x-a.x);return[1,-1].map(sign=>({x:b.x-size*Math.cos(angle+sign*Math.PI/6),y:b.y-size*Math.sin(angle+sign*Math.PI/6)}));}
  function create(canvas,image){
    const scale=Math.min(1,1600/Math.max(image.naturalWidth||image.width,image.naturalHeight||image.height));
    canvas.width=Math.round((image.naturalWidth||image.width)*scale);canvas.height=Math.round((image.naturalHeight||image.height)*scale);
    const ctx=canvas.getContext('2d'),commands=[];let tool='pen',color='#ef4444',current=null,pointer=null;
    function draw(c){
      const a=c.points[0],b=c.points[c.points.length-1];ctx.strokeStyle=c.color;ctx.lineWidth=Math.max(3,canvas.width/250);ctx.lineCap='round';ctx.lineJoin='round';
      if(c.tool==='rect'){ctx.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y);return;}
      ctx.beginPath();ctx.moveTo(a.x,a.y);for(const p of c.points.slice(1))ctx.lineTo(p.x,p.y);
      if(c.points.length===1)ctx.lineTo(a.x+.1,a.y+.1);
      if(c.tool==='arrow')for(const p of arrowHead(a,b,ctx.lineWidth*5)){ctx.moveTo(b.x,b.y);ctx.lineTo(p.x,p.y);}
      ctx.stroke();
    }
    function render(){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);commands.forEach(draw);if(current)draw(current);}
    const pos=e=>point(e,canvas.getBoundingClientRect(),canvas.width,canvas.height);
    function down(e){if(e.button!==undefined&&e.button!==0)return;if(pointer!==null)return;e.preventDefault();pointer=e.pointerId;canvas.setPointerCapture(pointer);current={tool,color,points:[pos(e)]};render();}
    function move(e){if(pointer!==e.pointerId||!current)return;e.preventDefault();const p=pos(e);if(current.tool==='pen'){if(current.points.length<4000)current.points.push(p);}else current.points=[current.points[0],p];render();}
    function up(e){if(pointer!==e.pointerId)return;move(e);if(commands.length>=60)commands.shift();commands.push(current);current=null;pointer=null;render();}
    function cancel(e){if(pointer!==e.pointerId)return;current=null;pointer=null;render();}
    canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',cancel);render();
    return{tool:v=>{if(['pen','arrow','rect'].includes(v))tool=v;},color:v=>{if(/^#[0-9a-f]{6}$/i.test(v))color=v;},undo:()=>{commands.pop();render();},clear:()=>{commands.length=0;render();},dispose:()=>{canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',cancel);},count:()=>commands.length};
  }
  return{point,arrowHead,create};
});
