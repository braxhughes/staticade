// CRT post-process: the dot scene renders into a texture, then one pass bends it onto a quad
// (full screen, or any perspective quad such as a cabinet's tube) with curvature, scanlines,
// RGB fringe, vignette, glare and a rounded bezel. With CRT off the texture is drawn flat.

export function createCrt(gfx) {
  const gl = gfx.gl, W = gfx.W, H = gfx.H;
  const CVS = `attribute vec4 aPos; attribute vec2 aUv; varying vec2 vUv; void main(){ vUv=aUv; gl_Position=aPos; }`;
  const CFS = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv; uniform sampler2D uTex; uniform float uCrt, uTime;
void main(){
  if(uCrt<0.5){ gl_FragColor=vec4(texture2D(uTex,vUv).rgb,1.0); return; }
  vec2 c=vUv*2.0-1.0;
  c*=1.0+vec2(c.y*c.y*0.04,c.x*c.x*0.055);
  c*=1.1;
  vec2 uv=c*0.5+0.5;
  vec2 q=abs(c)-vec2(0.92);
  float edge=length(max(q,0.0))-0.08;
  float mask=1.0-smoothstep(-0.012,0.004,edge);
  float fr=0.0004+0.001*dot(c,c);
  vec3 col=vec3(texture2D(uTex,uv+vec2(fr,0.0)).r,texture2D(uTex,uv).g,texture2D(uTex,uv-vec2(fr,0.0)).b);
  float s=sin(uv.y*${H}.0*3.14159265);
  col*=mix(0.8,1.45,s*s);
  col*=1.0-0.12*dot(c,c);
  col*=0.985+0.015*sin(uTime*110.0);
  float g=smoothstep(1.0,0.0,length((c-vec2(-0.5,0.62))*vec2(0.75,1.7)));
  col+=vec3(0.75,0.85,1.0)*(g*g*0.07+0.012);
  vec3 bez=vec3(0.03,0.028,0.036)*(0.75+0.25*vUv.y);
  bez+=texture2D(uTex,clamp(uv,0.0,1.0)).rgb*0.1*smoothstep(0.1,0.0,edge);
  bez+=vec3(0.05)*smoothstep(0.02,0.0,abs(edge-0.014));
  gl_FragColor=vec4(mix(bez,col,mask),1.0);
}`;
  const qData = new Float32Array(24);
  let cprog = null, cPos = -1, cUv = -1, uCrt = null, uTime = null, qBuf = null, fbTex = null, fbo = null;

  function init() {
    cprog = gfx.link(CVS, CFS);
    cPos = gl.getAttribLocation(cprog, 'aPos'); cUv = gl.getAttribLocation(cprog, 'aUv');
    uCrt = gl.getUniformLocation(cprog, 'uCrt'); uTime = gl.getUniformLocation(cprog, 'uTime');
    gl.useProgram(cprog); gl.uniform1i(gl.getUniformLocation(cprog, 'uTex'), 0);
    qBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qBuf); gl.bufferData(gl.ARRAY_BUFFER, qData.byteLength, gl.DYNAMIC_DRAW);
    fbTex = gl.createTexture(); fbo = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, fbTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  function resize(view) {
    gl.bindTexture(gl.TEXTURE_2D, fbTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, view.w, view.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function unbind() { gl.disableVertexAttribArray(cPos); gl.disableVertexAttribArray(cUv); }

  function dotsToTexture(splitAt, ox, oy) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, gfx.view.w, gfx.view.h); gl.clear(gl.COLOR_BUFFER_BIT);
    gfx.drawDots(splitAt, ox, oy);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  // quad corner i (strip order BL, BR, TL, TR) at playfield x,y with view depth w (perspective-correct uv)
  function quadCorner(i, x, y, w, u, v) {
    const o = i * 6;
    qData[o] = (x / W * 2 - 1) * w; qData[o + 1] = (1 - y / H * 2) * w; qData[o + 2] = 0; qData[o + 3] = w; qData[o + 4] = u; qData[o + 5] = v;
  }
  function fullQuad() { quadCorner(0, 0, H, 1, 0, 0); quadCorner(1, W, H, 1, 1, 0); quadCorner(2, 0, 0, 1, 0, 1); quadCorner(3, W, 0, 1, 1, 1); }
  function composite(on, time) {
    gfx.toViewport(); gl.disable(gl.BLEND);
    gl.useProgram(cprog); gl.bindBuffer(gl.ARRAY_BUFFER, qBuf);
    gfx.unbindDots();
    gl.enableVertexAttribArray(cPos); gl.vertexAttribPointer(cPos, 4, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(cUv); gl.vertexAttribPointer(cUv, 2, gl.FLOAT, false, 24, 16);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, qData);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fbTex);
    gl.uniform1f(uCrt, on ? 1 : 0); gl.uniform1f(uTime, time);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // present the current dot buffer, with or without the CRT pass
  function flush(splitAt, ox, oy, on, time) {
    gfx.clearCanvas();
    if (on) { dotsToTexture(splitAt, ox, oy); fullQuad(); composite(true, time); }
    else { gfx.toViewport(); gfx.drawDots(splitAt, ox, oy); }
  }

  init();
  gfx.onRestore(init);
  gfx.onResize(resize);
  gfx.onBindDots(unbind);
  return { dotsToTexture, quadCorner, fullQuad, composite, flush };
}
