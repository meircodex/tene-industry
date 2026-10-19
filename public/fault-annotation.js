'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FaultAnnotation=api;})(typeof window!=='undefined'?window:this,function(){
  const clamp=(v,max)=>Math.max(0,Math.min(max,v));
  function point(e,rect,width,height){return{x:clamp((e.clientX-rect.left)*width/rect.width,width),y:clamp((e.clientY-rect.top)*height/rect.height,height)};}
  function arrowHead(a,b,size){const angle=Math.atan2(b.y-a.y,b.x-a.x);return[1,-1].map(sign=>({x:b.x-size*Math.cos(angle+sign*Math.PI/6),y:b.y-size*Math.sin(angle+sign*Math.PI/6)}));}
  function create(canvas,image,initial=[],options={}){
    const scale=Math.min(1,1600/Math.max(image.naturalWidth||image.width,image.naturalHeight||image.height));
    canvas.width=Math.round((image.naturalWidth||image.width)*scale);canvas.height=Math.round((image.naturalHeight||image.height)*scale);
    const ctx=canvas.getContext('2d'),commands=JSON.parse(JSON.stringify(initial)),undo=[];let tool='pen',color='#ef4444',width=3,current=null,pointer=null,moving=null,pan=null;
    function draw(c){const a=c.points[0],b=c.points[c.points.length-1];ctx.strokeStyle=c.color;ctx.fillStyle=c.color;ctx.lineWidth=c.width||3;ctx.lineCap='round';ctx.lineJoin='round';
      if(c.tool==='text'){ctx.font=`bold ${(c.width||3)*8}px Arial`;ctx.textAlign='right';ctx.textBaseline='top';ctx.direction='rtl';String(c.text||'').split('\n').forEach((line,i)=>ctx.fillText(line,a.x,a.y+i*(c.width||3)*10));return;}
      if(c.tool==='rect'){ctx.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y);return;}
      ctx.beginPath();ctx.moveTo(a.x,a.y);for(const p of c.points.slice(1))ctx.lineTo(p.x,p.y);if(c.points.length===1)ctx.lineTo(a.x+.1,a.y+.1);
      if(c.tool==='arrow')for(const p of arrowHead(a,b,ctx.lineWidth*5)){ctx.moveTo(b.x,b.y);ctx.lineTo(p.x,p.y);}ctx.stroke();
    }
    function render(){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);commands.forEach(draw);if(current)draw(current);}
    const pos=e=>point(e,canvas.getBoundingClientRect(),canvas.width,canvas.height),remember=()=>{undo.push(JSON.stringify(commands));if(undo.length>100)undo.shift();};
    function down(e){if(options.readOnly||e.button!==undefined&&e.button!==0||pointer!==null)return;e.preventDefault();pointer=e.pointerId;canvas.setPointerCapture(pointer);const p=pos(e);
      if(tool==='pan'){pan={x:e.clientX,y:e.clientY,left:canvas.parentElement.scrollLeft,top:canvas.parentElement.scrollTop};return;}
      if(tool==='text'){const existing=[...commands].reverse().find(c=>c.tool==='text'&&p.x<=c.points[0].x&&p.x>=c.points[0].x-Math.max(...c.text.split('\n').map(l=>l.length))*c.width*8&&p.y>=c.points[0].y&&p.y<=c.points[0].y+c.text.split('\n').length*c.width*10);remember();if(existing){moving={command:existing,dx:p.x-existing.points[0].x,dy:p.y-existing.points[0].y};return;}const text=String(options.text?.()||'').trim().slice(0,500);if(text&&commands.length<100)commands.push({tool,color,width,text,points:[p]});render();return;}
      remember();current={tool,color,width,points:[p]};render();
    }
    function move(e){if(pointer!==e.pointerId)return;e.preventDefault();if(pan){canvas.parentElement.scrollLeft=pan.left-(e.clientX-pan.x);canvas.parentElement.scrollTop=pan.top-(e.clientY-pan.y);return;}const p=pos(e);if(moving){moving.command.points=[{x:clamp(p.x-moving.dx,canvas.width),y:clamp(p.y-moving.dy,canvas.height)}];render();return;}if(!current)return;if(tool==='pen'){if(current.points.length<4000)current.points.push(p);}else current.points=[current.points[0],p];render();}
    function up(e){if(pointer!==e.pointerId)return;move(e);if(current){if(commands.length<100)commands.push(current);current=null;}pointer=null;moving=null;pan=null;render();}
    function cancel(e){if(pointer!==e.pointerId)return;current=null;pointer=null;moving=null;pan=null;render();}
    canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',cancel);render();
    return{tool:v=>{if(['pen','arrow','rect','text','pan'].includes(v))tool=v;},color:v=>{if(/^#[0-9a-f]{6}$/i.test(v))color=v;},width:v=>{width=Math.max(1,Math.min(12,Number(v)||3));},undo:()=>{const previous=undo.pop();if(previous){commands.splice(0,commands.length,...JSON.parse(previous));render();}},clear:()=>{remember();commands.length=0;render();},commands:()=>JSON.parse(JSON.stringify(commands)),dispose:()=>{canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',cancel);},count:()=>commands.length};
  }
  return{point,arrowHead,create};
});
