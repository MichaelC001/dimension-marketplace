import{n as e,t}from"./ask-Bj_p24dx.js";/* empty css                */import{t as n}from"./canvas-box-C1GduXmW.js";import{n as r}from"./dom-C1sYDz5-.js";import{n as i,t as a}from"./motion-BWv0cGR_.js";import{t as o}from"./frame-driver-DUgtmZVf.js";import{c as s,l as c,s as l}from"./index-CYwP8Y-9.js";var u=c(s(),1),d=`
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`,f={amp:.28,freq:1.1,speed:.35},p=1.6,m=1.035+f.amp*1.3,h=1.05,g=`
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`,_=`
precision highp float;
uniform float uRes;
uniform float uTime;
uniform float uBreath;
uniform float uSpin;
uniform float uEnergy;
uniform float uAsk;
uniform vec3 uHueA;
uniform vec3 uHueB;
uniform vec3 uTint;

#define AMP ${f.amp.toFixed(3)}
#define FREQ ${f.freq.toFixed(3)}
#define SPEED ${f.speed.toFixed(3)}
#define VIEW ${p.toFixed(3)}
#define RMAX ${m.toFixed(3)}
#define EXPOSURE ${h.toFixed(3)}
${d}

// r(d) is the displaced radius in direction d. Returns |p| - r, i.e. how far p is
// outside the surface along its own ray from the centre, and the noise there.
float surface(vec3 p, float breath, float amp, float cs, float sn, out float n) {
  float len = max(length(p), 1.0e-4);
  vec3 v = p / len;
  // The body spins about Y; the noise lives in the body's own frame.
  vec3 o = vec3(cs * v.x - sn * v.z, v.y, sn * v.x + cs * v.z);
  n = snoise(o * FREQ + vec3(uTime * SPEED));
  return len - (breath + n * amp);
}

// three's ACESFilmicToneMapping (tonemapping_pars_fragment), verbatim maths.
vec3 aces(vec3 color) {
  const mat3 inMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 outMat = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602)
  );
  color *= EXPOSURE / 0.6;
  color = inMat * color;
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = outMat * (a / b);
  return clamp(color, 0.0, 1.0);
}

vec3 encodeSrgb(vec3 c) {
  return mix(pow(c, vec3(0.41666)) * 1.055 - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}

void main() {
  vec2 q = (gl_FragCoord.xy / uRes * 2.0 - 1.0) * VIEW;
  float px = 2.0 * VIEW / uRes;
  float e = uEnergy;
  float breath = 1.0 + 0.035 * sin(uBreath);
  float amp = AMP * (0.7 + 0.6 * e);
  float cs = cos(uSpin);
  float sn = sin(uSpin);
  float rq = length(q);

  // THE TRACE. March down -Z from the bounding sphere. The field is radial and its
  // slope stays under ~1.4, so 0.62 of the distance is a safe step; the closest
  // approach is kept so a near miss still knows where the silhouette is.
  float eps = px * 0.4;
  float minf = 1.0e3;
  vec3 pb = vec3(q, 0.0);
  float nb = 0.0;
  if (rq < RMAX) {
    float z0 = sqrt(RMAX * RMAX - rq * rq);
    float t = 0.0;
    for (int i = 0; i < 48; i++) {
      vec3 p = vec3(q, z0 - t);
      float n;
      float f = surface(p, breath, amp, cs, sn, n);
      if (f < minf) { minf = f; pb = p; nb = n; }
      if (f < eps) break;
      t += max(f * 0.62, max(px, 0.015));
      if (t > 2.0 * z0) break;
    }
  } else {
    // Outside the bounding sphere nothing can hit: one sample at the ray's closest
    // approach gives the distance and the rim colour for the halo.
    float n;
    minf = surface(pb, breath, amp, cs, sn, n);
    nb = n;
  }

  float d = max(minf - eps, 0.0);
  float cov = 1.0 - smoothstep(0.0, px * 1.5, d);

  // THE BODY — the Forge's fragment shader, term for term.
  vec3 nrm = normalize(pb);
  float fres = pow(1.0 - max(nrm.z, 0.0), 2.4);
  float mixN = smoothstep(-0.6, 0.8, nb);
  vec3 body = mix(uHueA, uHueB, mixN);
  float veins = smoothstep(0.55, 0.9, abs(sin(nb * 6.0 + uTime * 0.6)));
  vec3 col = body * (0.18 + 0.2 * e) + body * veins * 0.24 + mix(uHueB, vec3(1.0), 0.15) * fres * (0.32 + e * 0.5);

  // THE HALO — the bloom, analytically. Wider and hotter with energy; an ask
  // swells it and pulls it to the warning tint, which is what a still frame can
  // still say when there is no motion left to spend.
  float reach = 1.0 + 0.9 * uAsk;
  float glow = 0.6 * exp(-d / (0.06 * reach)) + 0.4 * exp(-d / (0.3 * reach));
  float edge = 1.0 - smoothstep(VIEW * 0.72, VIEW, rq);
  // Bloom is bright pixels blurred. Sampling the rim's own colour would draw hard
  // seams wherever the nearest silhouette point jumps between lobes, so the halo
  // takes a smooth field of the pixel's own direction instead.
  vec3 hv = normalize(vec3(q, 0.6));
  vec3 ho = vec3(cs * hv.x - sn * hv.z, hv.y, sn * hv.x + cs * hv.z);
  float nh = snoise(ho * FREQ * 0.7 + vec3(uTime * SPEED));
  vec3 haloHue = mix(mix(uHueA, uHueB, 0.3 + 0.45 * smoothstep(-0.6, 0.8, nh)), uTint, 0.85 * uAsk);
  float haloAmt = (0.3 + 0.35 * e) * (0.8 + 0.4 * nh) * (1.0 + 2.2 * uAsk);
  vec3 halo = haloHue * glow * haloAmt * edge;

  // A gate also draws a thin contour ring off the silhouette: a SHAPE, which reads
  // with every bit of motion switched off.
  float ringAt = max(0.2 + 0.03 * sin(uBreath), px * 4.0);
  float ringW = max(0.03, px * 1.4);
  float ringK = (d - ringAt) / ringW;
  float ring = smoothstep(0.8, 1.0, uAsk) * exp(-ringK * ringK) * edge;

  vec3 hdr = col * cov + halo * mix(1.0, 0.08, cov) + uTint * ring * 1.3 * (1.0 - cov);

  vec3 rgb = encodeSrgb(aces(hdr));
  float a = max(cov, max(rgb.r, max(rgb.g, rgb.b)));
  gl_FragColor = vec4(rgb, a);
}`,v={idle:.35,typing:.5,thinking:.6},y=e=>e<0?0:e>1?1:e;function b(e,t){let n=v[e??`idle`]??v.idle;return Math.max(n,y(typeof t==`number`&&Number.isFinite(t)?t:0))}var x={question:.7,gate:1};function S(e){return e===null?0:x[e]}var C=.12,w=.75;function ee(e,t,n){return{t:e,breath:e*1.7,spin:e*.31,energy:t,ask:n}}var T={t:4.2,breath:.9,spin:.7};function E(e,t){return{...T,energy:e,ask:t}}function te(e,t,n,r){let i=1-Math.exp(-5*t);e.energy+=(n-e.energy)*i,e.ask+=(r-e.ask)*i,e.t+=t,e.breath+=t*(1.2+e.energy*3),e.spin+=C*t*(.6+e.energy*1.2)*(1-w*e.ask)}function D(e,t,n){return{a:e,b:t,tint:n,lin:{a:M(e),b:M(t),tint:M(n)}}}var O=[160/255,96/255,192/255],k=`#7a60c1`,A=`#e0b15b`;function j(e){let t=e.trim().toLowerCase(),n=/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);if(n){let e=n[1],t=e.length<=4?[...e].map(e=>e+e).join(``):e;return[Number.parseInt(t.slice(0,2),16)/255,Number.parseInt(t.slice(2,4),16)/255,Number.parseInt(t.slice(4,6),16)/255]}let r=/^rgba?\(\s*([^)]+)\)$/.exec(t);if(!r)return null;let i=r[1].split(/[\s,/]+/).filter(Boolean);if(i.length<3)return null;let a=[];for(let e of i.slice(0,3)){let t=Number.parseFloat(e);if(!Number.isFinite(t))return null;a.push(y(e.endsWith(`%`)?t/100:t/255))}return a}function M(e){let t=e=>e<=.04045?e/12.92:((e+.055)/1.055)**2.4;return[t(e[0]),t(e[1]),t(e[2])]}var N=(e,t=1)=>`rgba(${Math.round(e[0]*255)},${Math.round(e[1]*255)},${Math.round(e[2]*255)},${t})`,P=(e,t,n)=>[e[0]+(t[0]-e[0])*n,e[1]+(t[1]-e[1])*n,e[2]+(t[2]-e[2])*n];function ne(e,t,n,r){let i=t/2,a=t/(2*p),o=1+.035*Math.sin(n.breath),s=n.energy,c=n.ask;e.clearRect(0,0,t,t);let l=P(P(r.a,r.b,.5),r.tint,.85*c),u=Math.min(1,(.32+.3*s)*(1+1.2*c)),d=(1.3+.35*c)*a*1.12,f=e.createRadialGradient(i,i,a*.7,i,i,Math.min(d+a,i));f.addColorStop(0,N(l,u)),f.addColorStop(.45,N(l,u*.32)),f.addColorStop(1,N(l,0)),e.fillStyle=f,e.fillRect(0,0,t,t);let m=a*o,h=.18+.2*s,g=e.createRadialGradient(i-m*.3,i-m*.35,m*.05,i,i,m);g.addColorStop(0,N(P(r.a,[1,1,1],.12),.95)),g.addColorStop(.6,N(P(r.a,r.b,.55),.7+h)),g.addColorStop(1,N(P(r.b,[1,1,1],.15),1)),e.fillStyle=g,e.beginPath(),e.arc(i,i,m,0,Math.PI*2),e.fill(),e.lineWidth=Math.max(1,a*.05),e.strokeStyle=N(P(r.b,[1,1,1],.4),.35+.4*s),e.stroke(),c>=.8&&(e.lineWidth=Math.max(1,a*.06),e.strokeStyle=N(r.tint,.9),e.beginPath(),e.arc(i,i,Math.min(m+Math.max(a*.22,3),i-1),0,Math.PI*2),e.stroke())}var F=64,re=4e3,I=[`uRes`,`uTime`,`uBreath`,`uSpin`,`uEnergy`,`uAsk`,`uHueA`,`uHueB`,`uTint`],L=null,R=!1,z=0,B=null;function V(e,t,n){let r=e.createShader(t);return r?(e.shaderSource(r,n),e.compileShader(r),e.getShaderParameter(r,e.COMPILE_STATUS)?r:(console.warn(`[vibr orb] shader compile failed:`,e.getShaderInfoLog(r)),e.deleteShader(r),null)):null}function H(e){let{gl:t}=e,n=V(t,t.VERTEX_SHADER,g),r=V(t,t.FRAGMENT_SHADER,_),i=t.createProgram();if(!n||!r||!i)return!1;if(t.attachShader(i,n),t.attachShader(i,r),t.linkProgram(i),t.deleteShader(n),t.deleteShader(r),!t.getProgramParameter(i,t.LINK_STATUS))return console.warn(`[vibr orb] program link failed:`,t.getProgramInfoLog(i)),t.deleteProgram(i),!1;e.program=i,t.useProgram(i);let a=t.createBuffer();t.bindBuffer(t.ARRAY_BUFFER,a),t.bufferData(t.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),t.STATIC_DRAW);let o=t.getAttribLocation(i,`position`);t.enableVertexAttribArray(o),t.vertexAttribPointer(o,2,t.FLOAT,!1,0,0);for(let n of I)e.locations[n]=t.getUniformLocation(i,n);return t.disable(t.BLEND),t.disable(t.DEPTH_TEST),t.disable(t.CULL_FACE),!0}function ie(){if(typeof document>`u`)return null;let e=document.createElement(`canvas`);e.width=F,e.height=F;let t=e.getContext(`webgl`,{alpha:!0,premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:`low-power`});if(!t)return null;let n={canvas:e,gl:t,locations:Object.fromEntries(I.map(e=>[e,null])),program:null,edge:F,onLost:e=>{e.preventDefault(),n.program=null},onRestored:()=>{n.program=null,!H(n)&&(U(n),L=null,R=!0)}};return e.addEventListener(`webglcontextlost`,n.onLost),e.addEventListener(`webglcontextrestored`,n.onRestored),H(n)?n:(U(n),null)}function U(e){e.canvas.removeEventListener(`webglcontextlost`,e.onLost),e.canvas.removeEventListener(`webglcontextrestored`,e.onRestored),e.gl.getExtension(`WEBGL_lose_context`)?.loseContext()}function W(){return L||(R?null:(L=ie(),L||(R=!0),L))}function ae(){z++,B!==null&&(window.clearTimeout(B),B=null);let e=!0;return{paint(e,t,n,r){let i=W();if(!i||i.gl.isContextLost()||!i.program)return!1;let{gl:a}=i;return t>i.edge&&(i.edge=Math.ceil(t/F)*F,i.canvas.width=i.edge,i.canvas.height=i.edge),a.viewport(0,0,t,t),a.uniform1f(i.locations.uRes,t),a.uniform1f(i.locations.uTime,n.t),a.uniform1f(i.locations.uBreath,n.breath),a.uniform1f(i.locations.uSpin,n.spin),a.uniform1f(i.locations.uEnergy,n.energy),a.uniform1f(i.locations.uAsk,n.ask),a.uniform3f(i.locations.uHueA,r.lin.a[0],r.lin.a[1],r.lin.a[2]),a.uniform3f(i.locations.uHueB,r.lin.b[0],r.lin.b[1],r.lin.b[2]),a.uniform3f(i.locations.uTint,r.lin.tint[0],r.lin.tint[1],r.lin.tint[2]),a.drawArrays(a.TRIANGLES,0,3),e.clearRect(0,0,t,t),e.drawImage(i.canvas,0,i.canvas.height-t,t,t,0,0,t,t),!0},release(){e&&(e=!1,z--,!(z>0||!L)&&(typeof window>`u`?G():B=window.setTimeout(G,re)))}}}function G(){B!==null&&(window.clearTimeout(B),B=null),L&&U(L),L=null,R=!1}var K=l(),q=30,oe=30,se=120,J;function Y(e,t){let n=j(e);if(n)return n;if(J===void 0&&(J=typeof document>`u`?null:document.createElement(`canvas`).getContext(`2d`,{willReadFrequently:!0})),J){J.fillStyle=`#010203`,J.fillStyle=e;let t=J.fillStyle;if(J.fillStyle=`#030201`,J.fillStyle=e,t===J.fillStyle){J.clearRect(0,0,1,1),J.fillRect(0,0,1,1);let e=J.getImageData(0,0,1,1).data;return[(e[0]??0)/255,(e[1]??0)/255,(e[2]??0)/255]}}return j(t)??[1,1,1]}function X(e){return D(Y(r(e,`--fr-accent`,``)||r(e,`--accent`,`#7a60c1`),k),O,Y(r(e,`--vibr-ask-tint`,A),A))}var Z=new Set,Q=null;function $(e){return Z.add(e),!Q&&typeof MutationObserver<`u`&&typeof document<`u`&&(Q=new MutationObserver(()=>{for(let e of Z)e()}),Q.observe(document.documentElement,{attributes:!0,attributeFilter:[`data-theme`,`data-accent`,`class`,`style`]})),()=>{Z.delete(e),Z.size===0&&(Q?.disconnect(),Q=null)}}function ce({state:r=`idle`,mode:s=``,energy:c=0,size:l,signals:d,motion:f,fpsCap:p,gpu:m,className:h}){let g=n(l,q,q),{store:_}=g,v=t(d),y=(0,u.useRef)(null),x=(0,u.useRef)(null),C=(0,u.useRef)({state:r,energy:c,ask:v});C.current={state:r,energy:c,ask:v};let w=(0,u.useRef)(void 0);w.current=p??oe;let T=(0,u.useRef)(null),D=m===`still`?`still`:i(f,r,s),O=m===`off`;return(0,u.useEffect)(()=>{let e=x.current,t=e?.getContext(`2d`);if(!e||!t)return;e.width=_,e.height=_;let n=O?null:ae(),r=X(y.current),i=e=>{n?.paint(t,_,e,r)||ne(t,_,e,r)},s=C.current;T.current??=ee(Math.random()*se,b(s.state,s.energy),S(s.ask));let c=T.current;if(D===`still`){let e=()=>{r=X(y.current);let{state:e,energy:t,ask:n}=C.current;c.energy=b(e,t),c.ask=S(n),i(E(c.energy,c.ask))};e();let t=$(e);return()=>{t(),n?.release()}}let l=a(w),u=performance.now(),d=C.current.ask,f=typeof document>`u`||document.visibilityState!==`hidden`,p=!0,m=null;function h(e){if(!l(e))return;let t=Math.min((e-u)/1e3,.1);u=e;let{state:n,energy:a,ask:o}=C.current;o!==d&&(d=o,r=X(y.current)),te(c,t,b(n,a),S(o)),i(c)}let g=()=>{if(f&&p){if(m)return;u=performance.now(),m=o(h)}else m&&=(m(),null)},v=()=>{f=document.visibilityState!==`hidden`,g()},k=typeof IntersectionObserver>`u`?null:new IntersectionObserver(e=>{p=e.some(e=>e.isIntersecting),g()});k?.observe(e),document.addEventListener(`visibilitychange`,v);let A=$(()=>{r=X(y.current)});return i(c),g(),()=>{m?.(),k?.disconnect(),document.removeEventListener(`visibilitychange`,v),A(),n?.release()}},[D,_,D===`still`?`${r}|${c}|${v}`:``,O]),(0,K.jsx)(`span`,{ref:y,className:`orb${h?` ${h}`:``}`,"data-slot":`vibr-orb`,"data-state":r,"data-mode":s,...e(d),style:g.style,"aria-hidden":`true`,children:(0,K.jsx)(`canvas`,{ref:x,style:g.canvasStyle})})}export{ce as Orb};