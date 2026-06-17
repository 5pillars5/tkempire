// ── TK EMPIRE GLOBAL EFFECTS ──
// Gold flakes + electricity + smooth scroll on every page

// ── SMOOTH SCROLL ──
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', function(e){
      const id = this.getAttribute('href').slice(1);
      const el = document.getElementById(id);
      if(el){
        e.preventDefault();
        el.scrollIntoView({behavior:'smooth', block:'start'});
      }
    });
  });

  // Handle hash on load (e.g. index.html#performance)
  if(window.location.hash){
    setTimeout(() => {
      const el = document.getElementById(window.location.hash.slice(1));
      if(el) el.scrollIntoView({behavior:'smooth', block:'start'});
    }, 200);
  }
});

(function(){
  const canvas = document.createElement('canvas');
  canvas.id = 'empire-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;opacity:0.45;';
  document.body.prepend(canvas);

  const ctx = canvas.getContext('2d');
  let W, H, flakes = [];
  let mouse = { x: -999, y: -999 };

  function resize(){
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
  window.addEventListener('mouseleave', () => { mouse.x = -999; mouse.y = -999; });

  const GOLDS = [
    'rgba(245,158,11,','rgba(252,211,77,','rgba(180,112,9,',
    'rgba(255,236,153,','rgba(212,175,55,',
  ];

  function rGold(a){ return GOLDS[Math.floor(Math.random()*GOLDS.length)]+a+')'; }

  function mkFlake(){
    return {
      x: Math.random()*W, y: Math.random()*H,
      size: Math.random()*2.2+0.4,
      speedX: (Math.random()-0.5)*0.3,
      speedY: Math.random()*0.25+0.05,
      opacity: Math.random()*0.6+0.1,
      opDir: Math.random()>0.5?0.004:-0.004,
      rot: Math.random()*Math.PI*2,
      rotSpd: (Math.random()-0.5)*0.015,
      shape: Math.floor(Math.random()*3),
      color: rGold((Math.random()*0.5+0.2).toFixed(2)),
      twinkle: Math.random()>0.6,
      twSpd: Math.random()*0.04+0.01,
      twPhase: Math.random()*Math.PI*2,
    };
  }

  for(let i=0;i<55;i++) flakes.push(mkFlake());

  function drawFlake(f){
    ctx.save();
    ctx.translate(f.x,f.y);
    ctx.rotate(f.rot);
    let a = f.opacity;
    if(f.twinkle){ a = f.opacity*(0.5+0.5*Math.sin(f.twPhase)); f.twPhase+=f.twSpd; }
    const col = f.color.replace(/[\d.]+\)$/,a.toFixed(2)+')');
    ctx.fillStyle = col;
    const s = f.size;
    if(f.shape===0){ ctx.fillRect(-s,-s,s*2,s*2); }
    else if(f.shape===1){
      ctx.beginPath();ctx.moveTo(0,-s*1.4);ctx.lineTo(s*0.9,0);ctx.lineTo(0,s*1.4);ctx.lineTo(-s*0.9,0);ctx.closePath();ctx.fill();
    } else {
      ctx.beginPath();ctx.arc(0,0,s,0,Math.PI*2);ctx.fill();
      if(s>1.2){ctx.strokeStyle=col;ctx.lineWidth=0.4;ctx.globalAlpha=a*0.5;ctx.beginPath();ctx.moveTo(-s*2.5,0);ctx.lineTo(s*2.5,0);ctx.moveTo(0,-s*2.5);ctx.lineTo(0,s*2.5);ctx.stroke();}
    }
    ctx.restore();
  }

  function drawBolt(x1,y1,x2,y2,alpha,jag){
    const dx=x2-x1,dy=y2-y1;
    const segs=3+Math.floor(Math.random()*3);
    ctx.save();
    ctx.strokeStyle=`rgba(255,220,60,${alpha*0.35})`;ctx.lineWidth=2.5;
    ctx.shadowColor=`rgba(255,200,30,${alpha})`;ctx.shadowBlur=10;
    ctx.beginPath();ctx.moveTo(x1,y1);
    for(let s=1;s<segs;s++){const t=s/segs;ctx.lineTo(x1+dx*t+(Math.random()-0.5)*jag,y1+dy*t+(Math.random()-0.5)*jag);}
    ctx.lineTo(x2,y2);ctx.stroke();
    ctx.strokeStyle=`rgba(255,240,160,${alpha*0.9})`;ctx.lineWidth=0.8;ctx.shadowBlur=6;
    ctx.beginPath();ctx.moveTo(x1,y1);
    for(let s=1;s<segs;s++){const t=s/segs;ctx.lineTo(x1+dx*t+(Math.random()-0.5)*jag*0.5,y1+dy*t+(Math.random()-0.5)*jag*0.5);}
    ctx.lineTo(x2,y2);ctx.stroke();
    ctx.restore();
  }

  function animate(){
    ctx.clearRect(0,0,W,H);
    flakes.forEach(f=>{
      f.x+=f.speedX;f.y+=f.speedY;f.rot+=f.rotSpd;
      f.opacity+=f.opDir;
      if(f.opacity>0.75||f.opacity<0.05)f.opDir*=-1;
      if(f.y>H+10){f.y=-10;f.x=Math.random()*W;}
      if(f.x>W+10)f.x=-10;
      if(f.x<-10)f.x=W+10;
      drawFlake(f);
    });

    // Flake to flake electricity
    for(let i=0;i<flakes.length;i++){
      for(let j=i+1;j<flakes.length;j++){
        const dx=flakes[j].x-flakes[i].x,dy=flakes[j].y-flakes[i].y;
        const dist=Math.sqrt(dx*dx+dy*dy);
        if(dist<100&&Math.random()>0.55){
          const p=1-dist/100;
          drawBolt(flakes[i].x,flakes[i].y,flakes[j].x,flakes[j].y,p*0.65,14*p);
        }
      }
    }

    // Mouse electricity
    if(mouse.x>0){
      flakes.forEach(f=>{
        const dx=mouse.x-f.x,dy=mouse.y-f.y;
        const dist=Math.sqrt(dx*dx+dy*dy);
        if(dist<130&&Math.random()>0.4){
          const p=1-dist/130;
          drawBolt(f.x,f.y,mouse.x,mouse.y,p*0.85,18*p);
          ctx.save();
          ctx.beginPath();ctx.arc(mouse.x,mouse.y,3*p,0,Math.PI*2);
          ctx.fillStyle=`rgba(255,220,80,${p*0.7})`;
          ctx.shadowBlur=16;ctx.shadowColor=`rgba(255,180,0,${p})`;
          ctx.fill();ctx.restore();
        }
      });
    }

    requestAnimationFrame(animate);
  }
  animate();
})();
