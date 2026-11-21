// Map tiles draped on the orthographic globe with WebGL.
//
// The globe's d3 projection stays the single source of truth. Each tile is a small grid of points that is
// projected on the CPU, in double precision, every frame, so tiles line up with the vector layer (borders,
// markers, labels) at every zoom, from the whole globe down to a street.
//
// A source is { id, url(z, x, y) | url: 'https://…/{z}/{x}/{y}.png', scheme: 'xyz' (Web Mercator, default)
// | 'geo' (lon/lat, two tiles across at level 0), tileSize, minZoom, maxZoom, load(url, tile) }.
// `load` is optional: a Promise of an image, canvas or ImageBitmap (elevation tiles are coloured in a worker).

const D2R = Math.PI / 180;
const MERC_LAT = 85.0511287798;
const MAX_TEXTURES = 360;
const MAX_LOADS = 10;

const VS = `
attribute vec2 a_pos; attribute vec2 a_uv; attribute float a_front;
uniform vec2 u_size;
varying vec2 v_uv; varying float v_front;
void main() {
  v_uv = a_uv; v_front = a_front;
  vec2 c = a_pos / u_size * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;
const FS = `
precision mediump float;
uniform sampler2D u_tex; uniform float u_alpha;
varying vec2 v_uv; varying float v_front;
void main() {
  if (v_front < 0.0) discard;
  gl_FragColor = texture2D(u_tex, v_uv) * u_alpha;
}`;
// The sea under the tiles: a disc, so the poles (outside Web Mercator) and tiles still loading are not holes.
const DISC_VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const DISC_FS = `
precision mediump float;
uniform vec2 u_center; uniform float u_radius; uniform vec4 u_color;
void main() {
  float d = distance(gl_FragCoord.xy, u_center);
  float a = 1.0 - smoothstep(u_radius - 1.0, u_radius + 0.5, d);
  if (a <= 0.0) discard;
  gl_FragColor = vec4(u_color.rgb * u_color.a * a, u_color.a * a);
}`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

const mercLat = t => Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) / D2R;
const mercY = lat => { const s = Math.sin(Math.max(-MERC_LAT, Math.min(MERC_LAT, lat)) * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };

// Tile grids: columns and rows at a level, and a tile's bounds as [west, east, north, south] in degrees.
export const SCHEMES = {
  xyz: {
    cols: z => 2 ** z, rows: z => 2 ** z,
    bounds: (z, x, y) => { const n = 2 ** z; return [x / n * 360 - 180, (x + 1) / n * 360 - 180, mercLat(y / n), mercLat((y + 1) / n)]; },
    lat: (z, y, f) => mercLat((y + f) / 2 ** z),
    rowOf: (z, lat) => Math.floor(mercY(lat) * 2 ** z),
    maxLat: MERC_LAT
  },
  geo: {
    cols: z => 2 * 2 ** z, rows: z => 2 ** z,
    bounds: (z, x, y) => { const w = 180 / 2 ** z; return [-180 + x * w, -180 + (x + 1) * w, 90 - y * w, 90 - (y + 1) * w]; },
    lat: (z, y, f) => 90 - (y + f) * 180 / 2 ** z,
    rowOf: (z, lat) => Math.floor((90 - lat) / (180 / 2 ** z)),
    maxLat: 90
  }
};

// The tile (and the pixel inside it) that holds a point, for point queries on elevation tiles.
export function tileAt(scheme, z, lon, lat, size = 256) {
  const sc = SCHEMES[scheme || 'xyz'];
  const fx = (lon + 180) / 360 * sc.cols(z);
  const fy = scheme === 'geo' ? (90 - lat) / (180 / 2 ** z) : mercY(lat) * 2 ** z;
  const x = Math.floor(fx), y = Math.floor(fy);
  return { x, y, px: Math.min(size - 1, Math.floor((fx - x) * size)), py: Math.min(size - 1, Math.floor((fy - y) * size)) };
}

// Great-circle distance in radians.
function dist(lon1, lat1, lon2, lat2) {
  const s1 = Math.sin((lat2 - lat1) * D2R / 2), s2 = Math.sin((lon2 - lon1) * D2R / 2);
  return 2 * Math.asin(Math.min(1, Math.sqrt(s1 * s1 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * s2 * s2)));
}

export function tileLayer(canvas, { onChange = () => {} } = {}) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
  if (!gl) return null;

  let prog, disc, buf, discBuf;
  const loc = {}, dloc = {};
  const cache = new Map(); // key -> { tex, state, used, src, z, x, y, priority }
  const queue = [];
  const meshes = new Map();
  let loads = 0, frame = 0, size = { w: 0, h: 0, dpr: 1 }, lost = false;

  function setup() {
    prog = compile(gl, VS, FS);
    disc = compile(gl, DISC_VS, DISC_FS);
    for (const n of ['a_pos', 'a_uv', 'a_front']) loc[n] = gl.getAttribLocation(prog, n);
    for (const n of ['u_size', 'u_tex', 'u_alpha']) loc[n] = gl.getUniformLocation(prog, n);
    dloc.a_pos = gl.getAttribLocation(disc, 'a_pos');
    for (const n of ['u_center', 'u_radius', 'u_color']) dloc[n] = gl.getUniformLocation(disc, n);
    buf = gl.createBuffer(); discBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, discBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    meshes.clear();
  }

  // One index buffer and one uv buffer per grid size (n cells a side), shared by every tile of that size.
  function mesh(n) {
    if (!meshes.has(n)) {
      const uv = new Float32Array((n + 1) * (n + 1) * 2), ix = new Uint16Array(n * n * 6);
      for (let j = 0, k = 0; j <= n; j++) for (let i = 0; i <= n; i++) { uv[k++] = i / n; uv[k++] = j / n; }
      for (let j = 0, k = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        ix[k++] = a; ix[k++] = c; ix[k++] = b; ix[k++] = b; ix[k++] = c; ix[k++] = d;
      }
      const u = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, u); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
      const e = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, e); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ix, gl.STATIC_DRAW);
      meshes.set(n, { uv: u, ix: e, count: ix.length });
    }
    return meshes.get(n);
  }

  try { setup(); } catch (e) { console.error(e); return null; }
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; cache.clear(); queue.length = 0; loads = 0; });
  canvas.addEventListener('webglcontextrestored', () => { lost = false; setup(); onChange(); });

  const keyOf = (src, z, x, y) => `${src.id}/${z}/${x}/${y}`;
  const urlOf = (src, z, x, y) => (typeof src.url === 'function' ? src.url(z, x, y)
    : src.url.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', (src.subdomains || 'abc')[(x + y) % (src.subdomains || 'abc').length]));

  // A tile that failed is asked for again while it is still wanted: after 10, 20, 40 and 80 seconds, then left blank.
  const RETRIES = 4;
  const failed = t => {
    t.state = 'error'; t.failedAt = performance.now(); t.tries = (t.tries || 0) + 1;
    if (t.tries < RETRIES) setTimeout(onChange, 10000 * 2 ** (t.tries - 1) + 50); // a frame then, even if nothing else draws one
  };
  function request(src, z, x, y, priority) {
    const key = keyOf(src, z, x, y);
    let t = cache.get(key);
    if (!t) { t = { state: 'queued', src, z, x, y, used: frame, priority }; cache.set(key, t); queue.push(t); }
    else if (t.state === 'error' && t.tries < RETRIES && performance.now() - t.failedAt > 10000 * 2 ** (t.tries - 1)) { t.state = 'queued'; queue.push(t); }
    t.used = frame;
    t.priority = Math.min(t.priority, priority);
    return t;
  }

  function pump() {
    if (lost) return;
    queue.sort((a, b) => a.priority - b.priority);
    while (loads < MAX_LOADS && queue.length) {
      const t = queue.shift();
      // Wanted only for a frame long gone (the view moved on): forget it rather than fetch it.
      if (frame - t.used > 2) { cache.delete(keyOf(t.src, t.z, t.x, t.y)); continue; }
      t.state = 'loading'; loads++;
      const url = urlOf(t.src, t.z, t.x, t.y);
      // A source can bring its own loader (elevation tiles are fetched and coloured in a worker).
      const got = t.src.load ? t.src.load(url, t) : new Promise((ok, fail) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = () => ok(img);
        img.onerror = fail;
        img.src = url;
      });
      got.then(pixels => {
        loads--;
        if (lost) return;
        try {
          t.tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, t.tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const pot = t.src.scheme !== 'geo' && (pixels.width & (pixels.width - 1)) === 0 && (pixels.height & (pixels.height - 1)) === 0;
          if (pot) gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, pot ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          t.state = 'ready';
          if (pixels.close) pixels.close(); // an ImageBitmap is no longer needed once uploaded
        } catch (e) { console.warn('tile', e); failed(t); }
        pump(); onChange();
      }, () => { loads--; failed(t); pump(); onChange(); });
    }
  }

  // Only loaded textures count towards the limit, and nothing drawn this frame is dropped: counting tiles still
  // waiting in the queue made a fast zoom throw away the coarse tiles that stand in for the rest, then fetch them again.
  function evict() {
    let ready = 0;
    for (const t of cache.values()) if (t.tex) ready++;
    if (ready <= MAX_TEXTURES) return;
    const old = [...cache.entries()].filter(([, t]) => t.tex && t.used < frame).sort((a, b) => a[1].used - b[1].used);
    for (const [k, t] of old.slice(0, ready - MAX_TEXTURES)) { gl.deleteTexture(t.tex); cache.delete(k); }
  }
  // Tiles queued for a view the globe has already left (zooming through levels) are dropped before they are fetched.
  function prune() {
    for (let i = queue.length - 1; i >= 0; i--) {
      const t = queue[i];
      if (frame - t.used > 1) { queue.splice(i, 1); cache.delete(keyOf(t.src, t.z, t.x, t.y)); }
    }
  }

  // The tiles of one level that can be on screen: a lon/lat box around the visible cap, then each tile's own
  // cap is checked against it.
  function visibleTiles(src, z, v) {
    const sc = SCHEMES[src.scheme || 'xyz'];
    const [clon, clat] = v.center, R = v.radius, Rd = R / D2R;
    const cols = sc.cols(z), rows = sc.rows(z);
    const latN = Math.min(sc.maxLat, clat + Rd), latS = Math.max(-sc.maxLat, clat - Rd);
    if (latS > latN) return [];
    const allLon = clat + Rd >= 90 || clat - Rd <= -90 || Math.sin(R) >= Math.cos(clat * D2R);
    const dLon = allLon ? 180 : Math.asin(Math.sin(R) / Math.cos(clat * D2R)) / D2R;
    const lonW = 360 / cols;
    const x0 = allLon ? 0 : Math.floor((clon - dLon + 180) / lonW), x1 = allLon ? cols - 1 : Math.floor((clon + dLon + 180) / lonW);
    const y0 = Math.max(0, sc.rowOf(z, latN)), y1 = Math.min(rows - 1, sc.rowOf(z, latS));
    const out = [];
    for (let xx = x0; xx <= x1 && out.length < 600; xx++) {
      const x = ((xx % cols) + cols) % cols;
      for (let y = y0; y <= y1; y++) {
        const [w, e, n, s] = sc.bounds(z, x, y), mlon = (w + e) / 2, mlat = (n + s) / 2;
        const r = Math.max(dist(mlon, mlat, w, n), dist(mlon, mlat, w, s), dist(mlon, mlat, e, n), dist(mlon, mlat, e, s));
        const d = dist(clon, clat, mlon, mlat);
        if (d - r < R + 0.01) out.push({ z, x, y, d });
      }
    }
    return out;
  }

  // The level whose texels are about one screen pixel at the centre of the view.
  function levelFor(src, v) {
    const sc = SCHEMES[src.scheme || 'xyz'];
    const texels = 2 * Math.PI * v.scale * v.dpr * Math.max(0.15, Math.cos(v.center[1] * D2R)) / (sc.cols(0) * (src.tileSize || 256));
    const z = Math.round(Math.log2(Math.max(1, texels)) + (src.bias || 0));
    return Math.max(src.minZoom || 0, Math.min(src.maxZoom ?? 18, z));
  }

  // Vertex positions for one tile, in CSS pixels, and how far each point is in front of the horizon.
  let posArr = new Float32Array(0);
  function project(src, z, x, y, n, v) {
    const sc = SCHEMES[src.scheme || 'xyz'];
    const [w, e] = sc.bounds(z, x, y);
    const { s, tx, ty, dl, cp, sp, cg, sg } = v.rot;
    const verts = (n + 1) * (n + 1);
    if (posArr.length < verts * 3) posArr = new Float32Array(verts * 3);
    const cosL = new Float64Array(n + 1), sinL = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) { const l = (w + (e - w) * i / n) * D2R + dl; cosL[i] = Math.cos(l); sinL[i] = Math.sin(l); }
    let k = 0;
    for (let j = 0; j <= n; j++) {
      const lat = sc.lat(z, y, j / n) * D2R, cf = Math.cos(lat), sf = Math.sin(lat);
      for (let i = 0; i <= n; i++) {
        // d3.geoRotation followed by the orthographic projection, written out.
        const X = cosL[i] * cf, Y = sinL[i] * cf, Z = sf;
        const kk = Z * cp + X * sp;
        const front = X * cp - Z * sp;
        let px = Y * cg - kk * sg, py = kk * cg + Y * sg;
        // Past the horizon: push the point outwards from the rim, so edge triangles do not fold back over the disc.
        if (front < 0) { const m = Math.hypot(px, py) || 1, r = 2 - m; px = px / m * r; py = py / m * r; }
        posArr[k++] = tx + s * px; posArr[k++] = ty - s * py; posArr[k++] = front;
      }
    }
    return posArr.subarray(0, verts * 3);
  }

  function drawTile(t, n, v, alpha) {
    const m = mesh(n);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, project(t.src, t.z, t.x, t.y, n, v), gl.STREAM_DRAW);
    gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 12, 0);
    gl.vertexAttribPointer(loc.a_front, 1, gl.FLOAT, false, 12, 8);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.uv);
    gl.vertexAttribPointer(loc.a_uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ix);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1f(loc.u_alpha, alpha);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
  }

  // Coarse tiles covering the whole world are always kept, so there is never a hole while finer ones load.
  function coarse(src) {
    const sc = SCHEMES[src.scheme || 'xyz'];
    const z = Math.max(src.minZoom || 0, Math.min(src.maxZoom ?? 18, src.scheme === 'geo' ? 1 : 2));
    const out = [];
    for (let x = 0; x < sc.cols(z); x++) for (let y = 0; y < sc.rows(z); y++) out.push({ z, x, y });
    return out;
  }

  return {
    resize(w, h, dpr) {
      size = { w, h, dpr };
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    },
    // layers: [{ src, opacity }], bottom first. view: { rotate, scale, translate, sea: [r, g, b, a] in 0-1 }.
    render(layers, view) {
      if (lost) return { loading: 0, failed: 0 };
      frame++;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!layers.length) return { loading: 0, failed: 0 };
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      const [tx, ty] = view.translate, s = view.scale, [rl, rp, rg = 0] = view.rotate;
      const corner = Math.max(Math.hypot(tx, ty), Math.hypot(size.w - tx, ty), Math.hypot(tx, size.h - ty), Math.hypot(size.w - tx, size.h - ty));
      const v = {
        scale: s, dpr: size.dpr, center: [-rl, -rp],
        radius: corner >= s ? Math.PI / 2 : Math.asin(corner / s),
        rot: { s, tx, ty, dl: rl * D2R, cp: Math.cos(rp * D2R), sp: Math.sin(rp * D2R), cg: Math.cos(rg * D2R), sg: Math.sin(rg * D2R) }
      };

      if (view.sea) {
        gl.useProgram(disc);
        gl.bindBuffer(gl.ARRAY_BUFFER, discBuf);
        gl.enableVertexAttribArray(dloc.a_pos);
        gl.vertexAttribPointer(dloc.a_pos, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(dloc.u_center, tx * size.dpr, canvas.height - ty * size.dpr);
        gl.uniform1f(dloc.u_radius, s * size.dpr);
        gl.uniform4f(dloc.u_color, ...view.sea);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.disableVertexAttribArray(dloc.a_pos);
      }

      gl.useProgram(prog);
      gl.uniform2f(loc.u_size, size.w, size.h);
      gl.uniform1i(loc.u_tex, 0);
      gl.activeTexture(gl.TEXTURE0);
      for (const n of ['a_pos', 'a_uv', 'a_front']) gl.enableVertexAttribArray(loc[n]);

      let loading = 0, failing = 0; // failing: wanted tiles that failed and will be asked for again
      for (const { src, opacity = 1 } of layers) {
        if (opacity <= 0) continue;
        const z = levelFor(src, v);
        let want = visibleTiles(src, z, v);
        // Too many tiles (a very large window): one level coarser.
        if (want.length > 160 && z > (src.minZoom || 0)) want = visibleTiles(src, z - 1, v);
        for (const b of coarse(src)) request(src, b.z, b.x, b.y, -1);
        const under = new Map(), top = [];
        for (const w of want) {
          const t = request(src, w.z, w.x, w.y, w.d);
          if (t.state === 'ready') { top.push(t); continue; }
          if (t.state !== 'error') loading++;
          else if (t.tries < RETRIES) failing++;
          // Not loaded yet: the nearest loaded coarser tile stands in.
          for (let d = 1; d <= w.z; d++) {
            const a = cache.get(keyOf(src, w.z - d, w.x >> d, w.y >> d));
            if (a?.state === 'ready') { a.used = frame; under.set(keyOf(src, a.z, a.x, a.y), a); break; }
          }
        }
        for (const t of [...[...under.values()].sort((a, b) => a.z - b.z), ...top]) drawTile(t, t.z < 3 ? 32 : t.z < 6 ? 16 : 6, v, opacity);
      }
      for (const n of ['a_pos', 'a_uv', 'a_front']) gl.disableVertexAttribArray(loc[n]);
      prune();
      pump();
      evict();
      return { loading, failed: failing };
    },
    // Drops one source's tiles (its colours changed, e.g. with the theme).
    forget(id) { for (const [k, t] of cache) if (t.src.id === id) { if (t.tex) gl.deleteTexture(t.tex); cache.delete(k); } }
  };
}
