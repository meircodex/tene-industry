'use strict';
window.createWorkerPortalScanner=function({onCode,onError}){
 let stream=null,timer=null,detector=null,busy=false,generation=0;
 const video=document.getElementById('camera'),shell=document.getElementById('cameraShell');
 function stop(){generation++;clearTimeout(timer);timer=null;if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;detector=null;shell.classList.remove('active');document.getElementById('stopCamera').hidden=true;document.getElementById('startCamera').hidden=false;}
 async function frame(){
  if(!stream||document.hidden)return;
  const frameGeneration=generation;
  try{
   let value='';
   if(detector)value=(await detector.detect(video))?.[0]?.rawValue||'';
   else if(window.jsQR&&video.videoWidth){const canvas=document.getElementById('scanCanvas');canvas.width=Math.min(720,video.videoWidth);canvas.height=Math.round(canvas.width*video.videoHeight/video.videoWidth);const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(video,0,0,canvas.width,canvas.height);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);value=window.jsQR(pixels.data,canvas.width,canvas.height,{inversionAttempts:'attemptBoth'})?.data||'';}
   if(frameGeneration!==generation)return;
   if(value){stop();onCode(value);return;}
  }catch{}
  timer=setTimeout(frame,220);
 }
 async function start(){
  if(busy||stream)return;busy=true;const startedGeneration=generation;
  try{if(!navigator.mediaDevices?.getUserMedia||(!('BarcodeDetector' in window)&&!window.jsQR))throw Error('camera');
   detector='BarcodeDetector' in window?new BarcodeDetector({formats:['qr_code']}):null;
   const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});if(startedGeneration!==generation){acquired.getTracks().forEach(t=>t.stop());return;}stream=acquired;video.srcObject=stream;await video.play();if(startedGeneration!==generation)return;shell.classList.add('active');document.getElementById('startCamera').hidden=true;document.getElementById('stopCamera').hidden=false;frame();
  }catch{const cancelled=startedGeneration!==generation;stop();if(!cancelled)onError();}finally{busy=false;}
 }
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});window.addEventListener('pagehide',stop);
 return{start,stop};
};
