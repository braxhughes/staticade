// Soft additive point-sprite renderer: everything on screen is a glowing dot.
// createGfx owns the WebGL context, the letterboxed view, the dot buffer and context-loss recovery.
// Other GL users (crt.js) register onRestore / onResize so every resource is rebuilt after a loss.

export function createGfx(canvas, { W, H, maxDots = 30000, maxDpr = 2 } = {}) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
  if (!gl) return null;
  const STRIDE = 7, buf = new Float32Array(maxDots * STRIDE);
  let n = 0, lost = false;
  let prog = null, glBuf = null, aP = -1, aS = -1, aC = -1, uOff = null, uScale = null, uHalo = null;
  const view = { dpr: 1, scale: 1, x: 0, y: 0, w: 1, h: 1 };
  const restoreFns = [], resizeFns = [], unbindFns = [];

  const VS = `attribute vec2 p; attribute float s; attribute vec4 c;
uniform vec2 uOff; uniform float uScale; uniform mediump float uHalo; varying mediump vec4 v;
void main(){ vec2 q=(p+uOff)/vec2(${W}.0,${H}.0);
  gl_Position=vec4(q.x*2.0-1.0,1.0-q.y*2.0,0.0,1.0);
  gl_PointSize=max(1.0,s*uScale*mix(1.0,3.4,uHalo)); v=c; }`;
  const FS = `precision mediump float; varying vec4 v; uniform float uHalo;
void main(){ float d=length(gl_PointCoord-0.5)*2.0; float a;
  if(uHalo>0.5){ a=exp(-d*d*3.2)*0.2; } else { a=1.0-smoothstep(0.3,1.0,d); }
  gl_FragColor=vec4(v.rgb*v.a*a,1.0); }`;

  function shader(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function link(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  function init() {
    prog = link(VS, FS);
    glBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
    aP = gl.getAttribLocation(prog, 'p'); aS = gl.getAttribLocation(prog, 's'); aC = gl.getAttribLocation(prog, 'c');
    uOff = gl.getUniformLocation(prog, 'uOff'); uScale = gl.getUniformLocation(prog, 'uScale'); uHalo = gl.getUniformLocation(prog, 'uHalo');
    gl.blendFunc(gl.ONE, gl.ONE);
  }

  function resize() {
    view.dpr = Math.min(maxDpr, devicePixelRatio || 1);
    canvas.width = Math.floor(innerWidth * view.dpr); canvas.height = Math.floor(innerHeight * view.dpr);
    view.scale = Math.min(canvas.width / W, canvas.height / H);
    view.w = Math.max(1, Math.floor(W * view.scale)); view.h = Math.max(1, Math.floor(H * view.scale));
    view.x = Math.floor((canvas.width - view.w) / 2); view.y = Math.floor((canvas.height - view.h) / 2);
    if (lost) return;
    for (const fn of resizeFns) fn(view);
  }

  function dot(x, y, s, r, g, b, a) {
    if (n >= maxDots) return;
    const o = n * STRIDE;
    buf[o] = x; buf[o + 1] = y; buf[o + 2] = s; buf[o + 3] = r; buf[o + 4] = g; buf[o + 5] = b; buf[o + 6] = a;
    n++;
  }
  function bindDots() {
    gl.useProgram(prog); gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
    for (const fn of unbindFns) fn();
    gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(aS); gl.vertexAttribPointer(aS, 1, gl.FLOAT, false, 28, 8);
    gl.enableVertexAttribArray(aC); gl.vertexAttribPointer(aC, 4, gl.FLOAT, false, 28, 12);
  }
  function unbindDots() { gl.disableVertexAttribArray(aP); gl.disableVertexAttribArray(aS); gl.disableVertexAttribArray(aC); }
  function dotPass(first, count, x, y) {
    if (count <= 0) return;
    gl.uniform2f(uOff, x, y);
    gl.uniform1f(uHalo, 1); gl.drawArrays(gl.POINTS, first, count);
    gl.uniform1f(uHalo, 0); gl.drawArrays(gl.POINTS, first, count);
  }
  // draw all dots; the first splitAt are offset by (ox, oy) (screen shake), the rest are not (HUD)
  function drawDots(splitAt, ox, oy) {
    bindDots(); gl.enable(gl.BLEND);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf.subarray(0, n * STRIDE));
    gl.uniform1f(uScale, view.scale);
    dotPass(0, splitAt, ox, oy);
    dotPass(splitAt, n - splitAt, 0, 0);
  }
  function clearCanvas() {
    gl.disable(gl.SCISSOR_TEST); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  }
  function toViewport() { gl.viewport(view.x, view.y, view.w, view.h); gl.enable(gl.SCISSOR_TEST); gl.scissor(view.x, view.y, view.w, view.h); }

  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    lost = false; init();
    for (const fn of restoreFns) fn();
    resize();
  }, false);
  addEventListener('resize', resize);
  init();

  return {
    gl, W, H, view, dot, drawDots, clearCanvas, toViewport, resize, link,
    reset() { n = 0; }, count() { return n; },
    get lost() { return lost || gl.isContextLost(); },
    onRestore(fn) { restoreFns.push(fn); },
    onResize(fn) { resizeFns.push(fn); },
    onBindDots(fn) { unbindFns.push(fn); },
    unbindDots,
    // client (CSS px) x to playfield x
    toFieldX(clientX) { return (clientX * view.dpr - view.x) / view.scale; }
  };
}
