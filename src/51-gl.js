// ── GPU viewport: WebGL2, no library ────────────────────────────────────────
// The 2D canvas path shades triangles in JavaScript; it is honest but it cannot
// do what a product render needs: a shadow map, per-pixel specular with a real
// roughness term, image-based ambient from a sky/ground gradient, and MSAA. All
// of that is available in the browser itself, so this file talks to WebGL2
// directly — no three.js, which a plugin is not allowed to import anyway.
//
// What it draws: the same triangles the STL exporter writes, flat-shaded (a
// machined part has facets; smoothing them is what made it look like clay),
// lit by a three-point rig plus a hemisphere, with a cast shadow on a studio
// floor. If the context cannot be created the caller keeps the 2D renderer.

const GL_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aMat;   // albedo rgb + glow
layout(location=3) in vec3 aSurf;  // roughness, metalness, printed flag
layout(location=4) in float aAO;   // baked vertex occlusion, 1 = open sky

uniform mat4 uViewProj;
uniform mat4 uLightViewProj;
uniform float uExplode;

out vec3 vWorld;
out vec3 vNormal;
out vec4 vMat;
out vec3 vSurf;
out float vAO;
out vec4 vLightPos;

void main() {
  vec3 p = aPos;
  vWorld = p;
  vNormal = aNormal;
  vMat = aMat;
  vSurf = aSurf;
  vAO = aAO;
  vLightPos = uLightViewProj * vec4(p, 1.0);
  gl_Position = uViewProj * vec4(p, 1.0);
}`

const GL_FS = `#version 300 es
precision highp float;

in vec3 vWorld;
in vec3 vNormal;
in vec4 vMat;
in vec3 vSurf;
in float vAO;
in vec4 vLightPos;

uniform vec3 uEye;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uFillDir;
uniform vec3 uFillColor;
uniform vec3 uRimDir;
uniform vec3 uRimColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform sampler2D uShadow;
uniform sampler2D uEnv;
uniform float uUseEnv;
uniform float uShadowTexel;
uniform float uHasShadow;

out vec4 fragColor;

vec3 aces(vec3 x) {
  float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
// cheap value noise: three octaves is enough to break up a perfectly flat
// surface without looking like sandpaper
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
}

float shadowFactor(vec3 n) {
  if (uHasShadow < 0.5) return 1.0;
  vec3 proj = vLightPos.xyz / vLightPos.w;
  proj = proj * 0.5 + 0.5;
  if (proj.z > 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) return 1.0;
  float bias = max(0.0015 * (1.0 - dot(n, uKeyDir)), 0.0004);
  // Three rings of taps: a studio key has a real penumbra, and a 5x5 grid at
  // this map resolution reads as a stencil.
  // Nine taps in two rings, rotated per pixel so the pattern does not read as a
  // grid, and stretched along the shadow texel so the penumbra stays wide. The
  // earlier 5x5 version cost 25 texture fetches per fragment: on a software GL
  // stack that is 4 fps, which is not a renderer anyone can use.
  float ang = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
  float ca = cos(ang);
  float sa = sin(ang);
  mat2 rot = mat2(ca, -sa, sa, ca);
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    // ring 0 = centre, 1..4 inner ring, 5..8 outer ring (Vogel-ish spacing)
    float rad = i == 0 ? 0.0 : (i < 5 ? 1.9 : 4.4);
    float th = i == 0 ? 0.0 : (fi * 2.3999632) + ang;
    vec2 off = (rot * vec2(cos(th), sin(th))) * rad * uShadowTexel * 1.35;
    float d = texture(uShadow, proj.xy + off).r;
    float w = rad < 1.0 ? 1.0 : (rad < 2.0 ? 0.85 : 0.55);
    sum += ((proj.z - bias * 1.6) > d ? 0.0 : 1.0) * w;
    wsum += w;
  }
  return sum / wsum;
}

// GGX-ish specular: tight enough to read as a machined highlight, loose enough
// to survive a low-poly facet
float spec(vec3 n, vec3 l, vec3 v, float rough) {
  vec3 h = normalize(l + v);
  float a = max(0.04, rough * rough);
  float nh = max(dot(n, h), 0.0);
  float d = a / (3.14159 * pow(nh * nh * (a - 1.0) + 1.0, 2.0));
  float vh = max(dot(v, h), 0.0);
  float f = mix(0.04, 1.0, pow(1.0 - vh, 5.0));
  return d * f * (0.9 + 0.5 * rough);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  vec3 albedo = vMat.rgb;
  float rough = clamp(vSurf.x, 0.06, 1.0);

  // FDM layer lines: a 0.2 mm sawtooth on world Z, faded out where the stripes
  // fall below a pixel (fwidth) so a zoomed-out view never turns to moiré. This
  // is the single strongest cue that a part was printed rather than cast.
  if (vSurf.z > 0.5) {
    float lh = 0.2;
    float zz = vWorld.z / lh;
    float f = abs(fract(zz) - 0.5) * 2.0;
    float w = fwidth(zz);
    float vis = clamp(1.0 - w * 1.6, 0.0, 1.0);
    albedo *= 1.0 + (f - 0.5) * 0.22 * vis;

    // macro surface: a printed wall is never perfectly flat. A slow noise term
    // tilts the normal a couple of degrees and lifts the roughness slightly, so
    // the part reads as a moulded object rather than a flat-shaded solid.
    float grain = vnoise(vWorld * 0.35) - 0.5;
    vec3 jitter = vec3(
      vnoise(vWorld * 0.35 + vec3(11.0, 0.0, 0.0)) - 0.5,
      vnoise(vWorld * 0.35 + vec3(0.0, 13.0, 0.0)) - 0.5,
      vnoise(vWorld * 0.35 + vec3(0.0, 0.0, 17.0)) - 0.5
    );
    n = normalize(n + jitter * 0.10);
    rough = clamp(rough + grain * 0.06, 0.05, 1.0);
  }
  float metal = clamp(vSurf.y, 0.0, 1.0);
  float glow = vMat.a;

  float shade = shadowFactor(n);

  // three-point rig
  float key = max(dot(n, uKeyDir), 0.0) * shade;
  float fill = max(dot(n, uFillDir), 0.0) * 0.45;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.4) * max(dot(n, uRimDir), 0.0);

  vec3 diffuse = albedo * (uKeyColor * key + uFillColor * fill) * (1.0 - metal * 0.65);

  // hemisphere ambient: sky above, floor bounce below, tinted by albedo
  // Ambient is a fill, not the light: too much of it desaturates every filament
  // toward white and the machine reads as clay again.
  float up = n.z * 0.5 + 0.5;
  vec3 skyTerm = mix(uGroundColor, uSkyColor, up);
  if (uUseEnv > 0.5) {
    vec2 auv = vec2(atan(n.y, n.x) / 6.2831853 + 0.5, acos(clamp(n.z, -1.0, 1.0)) / 3.1415927);
    skyTerm = textureLod(uEnv, auv, 7.0).rgb;
  }
  vec3 ambient = skyTerm * albedo * (0.22 + 0.26 * shade);

  float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
  vec3 sheen = mix(uSkyColor, vec3(0.8), 0.35) * fres * (0.55 - 0.35 * rough) * (1.0 - metal);

  vec3 specular =
      sheen +
      uKeyColor * spec(n, uKeyDir, v, rough) * key * (0.35 + 0.65 * metal) * 1.6
    + uFillColor * spec(n, uFillDir, v, rough) * fill * (0.25 + 0.4 * metal)
    + uRimColor * rim * (0.25 + 0.75 * metal) * 0.9;

  // environment: an equirectangular studio probe, sampled along the reflection
  // vector with a mip chosen from roughness. That is what makes a rough plastic
  // pick up a soft sheen and a polished bolt pick up the softbox as a shape,
  // instead of both getting the same analytic blob.
  vec3 R = reflect(-v, n);
  vec2 ruv = vec2(atan(R.y, R.x) / 6.2831853 + 0.5, acos(clamp(R.z, -1.0, 1.0)) / 3.1415927);
  float lod = clamp(rough * 7.0, 0.0, 7.0);
  vec3 env = textureLod(uEnv, ruv, lod).rgb;
  if (uUseEnv < 0.5) {
    float sky = smoothstep(-0.55, 0.75, R.z);
    env = mix(uGroundColor * 1.7, uSkyColor * 3.4, sky);
  }
  // a small analytic kicker on top of the probe: the probe is 256 px wide, so a
  // crisp highlight on a bolt has to be added rather than sampled
  env += uKeyColor * pow(max(dot(R, uKeyDir), 0.0), 120.0) * 1.6;
  // The probe is painted in sRGB and it is a *light source*, so decode it and
  // give it radiance. Dielectrics reflect through Fresnel (almost nothing head
  // on, a lot at grazing angles), metals reflect everything — that curve is what
  // puts a real edge highlight on a silhouette.
  vec3 envLin = pow(max(env, vec3(0.0)), vec3(2.2)) * 6.0;
  float fresnelEnv = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 reflection = envLin * mix(fresnelEnv, 1.0, metal) * (1.0 - rough * 0.55);

  // Bounce: the floor throws light back up at everything, tinted by what the
  // machine is made of. Without it the underside of every part is dead black and
  // the assembly reads as separate floating blocks.
  float underside = clamp(-n.z * 0.5 + 0.5, 0.0, 1.0);
  vec3 bounce = uGroundColor * albedo * underside * 1.4;

  // Baked occlusion: a crevice between a servo and a plate is dark because it
  // sees less of the sky, not because a screen-space pass guessed it. The bake
  // is per-vertex, done once per build on the CPU, and cached by mesh identity.
  // It damps the diffuse/ambient terms only — reflections and the key stay crisp.
  float occ = mix(1.0, clamp(vAO, 0.0, 1.0), 0.8);
  vec3 color = diffuse * (0.42 + 0.58 * occ) + ambient * occ + specular + reflection + bounce + albedo * glow;
  color = aces(color * 1.0);
  fragColor = vec4(toSRGB(color), 1.0);
}`

// Floor: a large quad that fades out radially, receives the shadow, and draws a
// faint 50mm grid — the studio plate a product photograph sits on.
const FLOOR_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
uniform mat4 uLightViewProj;
out vec3 vWorld;
out vec4 vLightPos;
void main() {
  vWorld = aPos;
  vLightPos = uLightViewProj * vec4(aPos, 1.0);
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`

const FLOOR_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec4 vLightPos;
uniform vec3 uEye;
uniform sampler2D uShadow;
uniform sampler2D uEnv;
uniform float uUseEnv;
uniform float uShadowTexel;
uniform float uHasShadow;
uniform vec3 uPlateColor;
uniform float uExtent;
uniform float uGridMm;
uniform float uContactMm;
uniform float uShowGrid;
out vec4 fragColor;

// cheap value noise: three octaves is enough to break up a perfectly flat
// surface without looking like sandpaper
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
}
float shadowFactor() {
  if (uHasShadow < 0.5) return 1.0;
  vec3 proj = vLightPos.xyz / vLightPos.w * 0.5 + 0.5;
  if (proj.z > 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) return 1.0;
  float sum = 0.0;
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      float d = texture(uShadow, proj.xy + vec2(float(x), float(y)) * uShadowTexel).r;
      sum += (proj.z - 0.0012) > d ? 0.0 : 1.0;
    }
  }
  return sum / 25.0;
}

void main() {
  float r = length(vWorld.xy);
  float fade = 1.0 - smoothstep(uExtent * 0.42, uExtent, r);
  if (fade <= 0.001) discard;

  // 50 mm grid, fading with distance so it reads as a plate, not graph paper
  vec2 g = abs(fract(vWorld.xy / uGridMm + 0.5) - 0.5) * uGridMm;
  float line = 1.0 - smoothstep(0.0, 1.2, min(g.x, g.y));
  float gridFade = 1.0 - smoothstep(uExtent * 0.15, uExtent * 0.55, r);

  float shade = shadowFactor();
  vec3 base = uPlateColor * (0.35 + 0.65 * shade);
  base += vec3(0.05, 0.07, 0.09) * line * gridFade * 0.35 * uShowGrid;

  // contact darkening right under the machine — sized to the subject, not the course
  float contact = 1.0 - smoothstep(0.0, uContactMm, r);
  base *= 1.0 - 0.45 * contact;

  base = toSRGB(base);
  fragColor = vec4(base, fade);
}`

// Screen-space ambient occlusion. Twelve taps on a spiral inside a hemisphere,
// compared in view space: this is what puts dark contact in the corners where a
// servo meets a plate, which flat shading cannot fake at any light count.
const DEPTH_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uLightViewProj;
void main() { gl_Position = uLightViewProj * vec4(aPos, 1.0); }`

const DEPTH_FS = `#version 300 es
precision highp float;
void main() {}`

// Overlay lines: support polygon, CoM plumb, reticles — world-space GL_LINES
// with per-vertex colour, drawn after the mesh with the same viewProj.
const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aCol;
uniform mat4 uViewProj;
out vec3 vCol;
void main() { vCol = aCol; gl_Position = uViewProj * vec4(aPos, 1.0); }`

const LINE_FS = `#version 300 es
precision highp float;
in vec3 vCol;
out vec4 fragColor;
vec3 aces(vec3 x) {
  float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
}
void main() { fragColor = vec4(toSRGB(aces(vCol * 1.5)), 0.9); }`

/**
 * A studio environment probe, painted once into an equirectangular canvas and
 * uploaded with mipmaps. Two soft boxes, a cool rim strip, a warm floor bounce
 * and a gradient sky: enough that reflections carry a *shape*, which is the
 * difference between "shiny" and "reflective". No external HDRI to download,
 * which also keeps the plugin offline.
 */
function studioEnv(gl) {
  const W = 256
  const H = 128
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d')

  // sky → horizon → floor
  const sky = g.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0.0, '#8fa2b8')
  sky.addColorStop(0.45, '#5b6b80')
  sky.addColorStop(0.52, '#2a3543')
  sky.addColorStop(1.0, '#12171d')
  g.fillStyle = sky
  g.fillRect(0, 0, W, H)

  // key soft box: broad, warm, upper left
  const key = g.createRadialGradient(W * 0.30, H * 0.22, 2, W * 0.30, H * 0.22, W * 0.24)
  key.addColorStop(0, 'rgba(255,246,232,1)')
  key.addColorStop(0.45, 'rgba(255,238,214,0.55)')
  key.addColorStop(1, 'rgba(255,236,210,0)')
  g.fillStyle = key
  g.fillRect(0, 0, W, H)

  // fill soft box: cooler, wider, right
  const fill = g.createRadialGradient(W * 0.72, H * 0.30, 2, W * 0.72, H * 0.30, W * 0.28)
  fill.addColorStop(0, 'rgba(198,224,255,0.85)')
  fill.addColorStop(0.5, 'rgba(170,205,240,0.30)')
  fill.addColorStop(1, 'rgba(160,200,240,0)')
  g.fillStyle = fill
  g.fillRect(0, 0, W, H)

  // rim strip behind the machine: a thin cool band, which is what draws an edge
  // highlight along a silhouette
  const strip = g.createLinearGradient(W * 0.44, 0, W * 0.52, 0)
  strip.addColorStop(0, 'rgba(120,200,230,0)')
  strip.addColorStop(0.5, 'rgba(140,215,240,0.75)')
  strip.addColorStop(1, 'rgba(120,200,230,0)')
  g.fillStyle = strip
  g.fillRect(W * 0.44, H * 0.22, W * 0.08, H * 0.30)

  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error('shader: ' + log)
  }
  return sh
}

function program(gl, vs, fs) {
  const p = gl.createProgram()
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p))
  return p
}

const M4 = {
  ident: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  mul(a, b) {
    const o = new Float32Array(16)
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        o[i * 4 + j] = a[0 * 4 + j] * b[i * 4 + 0] + a[1 * 4 + j] * b[i * 4 + 1] + a[2 * 4 + j] * b[i * 4 + 2] + a[3 * 4 + j] * b[i * 4 + 3]
      }
    }
    return o
  },
  persp(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2)
    const o = new Float32Array(16)
    o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1
    o[14] = (2 * far * near) / (near - far)
    return o
  },
  ortho(l, r, b, t, n, f) {
    const o = new Float32Array(16)
    o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n)
    o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n); o[15] = 1
    return o
  },
  lookAt(eye, centre, up) {
    const z = norm(sub(eye, centre))
    const x = norm(cross(up, z))
    const y = cross(z, x)
    const o = new Float32Array(16)
    o[0] = x[0]; o[4] = x[1]; o[8] = x[2]; o[12] = -dot(x, eye)
    o[1] = y[0]; o[5] = y[1]; o[9] = y[2]; o[13] = -dot(y, eye)
    o[2] = z[0]; o[6] = z[1]; o[10] = z[2]; o[14] = -dot(z, eye)
    o[15] = 1
    return o
  },
}
M4.inverse = (m) => {
  const o = new Float32Array(16)
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3]
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7]
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11]
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15]
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) return M4.ident()
  det = 1 / det
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
  return o
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

/** Linear colour for a material, mirroring the 2D table but as floats. */
/** FILAMENT tints are 0-255 sRGB; MAT albedo is already linear. */
function toLin(rgb) {
  const big = rgb[0] > 1.01 || rgb[1] > 1.01 || rgb[2] > 1.01
  if (!big) return [rgb[0], rgb[1], rgb[2]]
  return rgb.map((c) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
}

function matParams(m) {
  return {
    alb: toLin(m.alb),
    rough: m.rough != null ? m.rough : 0.5,
    metal: m.metal || 0,
    glow: m.glow || 0,
    printed: m.printed != null ? m.printed : (m.metal || 0) < 0.5,
  }
}

function createGLRenderer(canvas) {
  let gl = null
  try {
    gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' })
  } catch (e) {
    gl = null
  }
  if (!gl) { globalThis.__rfGL = 'no webgl2 context'; return { ok: false, draw() {}, dispose() {} } }

  let meshProg
  let floorProg
  let depthProg
  let lineProg
  try {
    meshProg = program(gl, GL_VS, GL_FS)
    floorProg = program(gl, FLOOR_VS, FLOOR_FS)
    depthProg = program(gl, DEPTH_VS, DEPTH_FS)
    lineProg = program(gl, LINE_VS, LINE_FS)
  } catch (e) {
    globalThis.__rfGL = e.message
    return { ok: false, draw() {}, dispose() {}, error: e.message }
  }
  globalThis.__rfGL = 'ok'

  let envTex = null
  try { envTex = studioEnv(gl) } catch (e) { envTex = null }

  const vao = gl.createVertexArray()
  const vbo = gl.createBuffer()
  const ibo = gl.createBuffer()
  const floorVao = gl.createVertexArray()
  const floorVbo = gl.createBuffer()
  const floorIbo = gl.createBuffer()
  const lineVao = gl.createVertexArray()
  const lineVbo = gl.createBuffer()

  // shadow map
  const SHADOW = 2048
  const shadowTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, shadowTex)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW, SHADOW)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const shadowFbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTex, 0)
  gl.drawBuffers([gl.NONE])
  gl.readBuffer(gl.NONE)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  const uni = (p, name) => gl.getUniformLocation(p, name)

  let aoMesh = null
  let aoData = null
  let baseDist = 0
  let uniqueAlbedos = 0
  let floorReady = false
  let lastKey = ''

  function buildFloor(extent) {
    const v = new Float32Array([
      -extent, -extent, 0, extent, -extent, 0, extent, extent, 0,
      -extent, -extent, 0, extent, extent, 0, -extent, extent, 0,
    ])
    gl.bindVertexArray(floorVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, floorVbo)
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0)
    floorReady = true
  }

  function uploadMesh(mesh, matOf, centre) {
    // occlusion arrives asynchronously: the bake is ~0.4 s on a real mesh, so it
    // runs on idle after the user stops dragging, and the frame simply draws
    // unoccluded until it lands
    const aoAttr = aoMesh === mesh ? aoData : null
    if (aoAttr && !globalThis.__rfAOStats) {
      let mn = 1, mx = 0, sum = 0
      for (let i = 0; i < aoAttr.length; i += 1) { const v = aoAttr[i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v }
      globalThis.__rfAOStats = { n: aoAttr.length, min: +mn.toFixed(3), max: +mx.toFixed(3), mean: +(sum / aoAttr.length).toFixed(3) }
    }
    const tri = mesh.length
    const stride = 3 + 3 + 4 + 3 + 1
    const data = new Float32Array(tri * 3 * stride)
    // Which way do the faces point? Meshes arrive from several generators, so
    // the winding is not guaranteed; measure it against the model centre once
    // and flip the whole set if it is consistently inward, rather than guessing
    // per face.
    let sign = 0
    const normals = new Array(tri)
    for (let i = 0; i < tri; i += 1) {
      const [a, b, c] = mesh[i].pts
      const n = norm(cross(sub(b, a), sub(c, a)))
      normals[i] = n
      const cen = [(a[0] + b[0] + c[0]) / 3 - centre[0], (a[1] + b[1] + c[1]) / 3 - centre[1], (a[2] + b[2] + c[2]) / 3 - centre[2]]
      sign += dot(n, cen) >= 0 ? 1 : -1
    }
    const flip = sign < 0 ? -1 : 1

    const seen = new Set()
    let o = 0
    for (let i = 0; i < tri; i += 1) {
      const t = mesh[i]
      const [a, b, c] = t.pts
      const raw = normals[i]
      const n = [raw[0] * flip, raw[1] * flip, raw[2] * flip]
      const m = matParams(matOf(t))
      seen.add(m.alb.map((c) => c.toFixed(2)).join(','))
      const corners = [a, b, c]
      for (let cornerIndex = 0; cornerIndex < 3; cornerIndex += 1) {
        const p = corners[cornerIndex]
        data[o++] = p[0]; data[o++] = p[1]; data[o++] = p[2]
        data[o++] = n[0]; data[o++] = n[1]; data[o++] = n[2]
        data[o++] = m.alb[0]; data[o++] = m.alb[1]; data[o++] = m.alb[2]; data[o++] = m.glow
        data[o++] = m.rough; data[o++] = m.metal; data[o++] = m.printed ? 1 : 0
        data[o++] = aoAttr ? aoAttr[i * 3 + cornerIndex] : 1
      }
    }
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
    const strideBytes = stride * 4
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, strideBytes, 0)
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, strideBytes, 12)
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, strideBytes, 24)
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, strideBytes, 40)
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, strideBytes, 52)
    uniqueAlbedos = seen.size
    return tri * 3
  }

  return {
    ok: true,
    draw(mesh, cam, opts, matOf, bounds, overlay) {
      const w = canvas.width
      const h = canvas.height
      if (!w || !h || !mesh || !mesh.length) return

      // Framing subject = the machine (opts.subjectBounds); the full scene
      // bounds may include a course spanning metres, which must not stretch
      // the camera or shrink the robot to a speck.
      let subj = (opts && opts.subjectBounds) || bounds
      if (opts && opts.focus && subj) {
        // subjectBounds are in local machine space; the fit loop needs the
        // world-space box so a driving machine frames correctly
        const hx = (subj.max[0] - subj.min[0]) / 2
        const hy = (subj.max[1] - subj.min[1]) / 2
        const hz = (subj.max[2] - subj.min[2]) / 2
        const f = opts.focus
        subj = { min: [f[0] - hx, f[1] - hy, f[2] - hz], max: [f[0] + hx, f[1] + hy, f[2] + hz] }
      }
      const cx = subj ? (subj.min[0] + subj.max[0]) / 2 : 0
      const cy = subj ? (subj.min[1] + subj.max[1]) / 2 : 0
      const cz = subj ? (subj.min[2] + subj.max[2]) / 2 : 0
      const size = subj ? Math.max(
        subj.max[0] - subj.min[0],
        subj.max[1] - subj.min[1],
        subj.max[2] - subj.min[2],
      ) : 300
      const sceneSize = bounds ? Math.max(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      ) : size
      // Frame the machine by its own bounds: a 1170mm gantry and a 90mm board
      // must both fill the view, and nothing may be cropped off-screen. The
      // wheel still works, because cam.dist scales the fitted distance.
      const FOV = 0.60
      const margin = 1.28
      const fitH = (size * 0.5) / Math.tan(FOV / 2) * margin
      const aspect = w / h
      const fitW = fitH / Math.min(1, aspect)
      const fit = Math.max(fitH, fitW)
      // cam.dist is an absolute mm value that predates the GPU path; treat the
      // first value seen as neutral and read later ones as a relative zoom, so
      // the fitted framing is the default and the wheel still works.
      if (!baseDist && cam.dist) baseDist = cam.dist
      const zoom = (cam.dist && baseDist ? cam.dist / baseDist : 1)
      let dist = fit * Math.max(0.5, Math.min(2.6, zoom))

      // Bias the subject up and to the left so the title block in the bottom
      // right never sits on top of the machine.
      const target = (opts && opts.focus) || [cx, cy, cz + size * 0.02]
      const yaw = cam.yaw
      const pitch = cam.pitch
      // Z-up, matching the studio's model space: height is z, so the orbit
      // lifts along z and the floor is the XY plane
      const eyeAt = (d) => [
        target[0] + d * Math.cos(pitch) * Math.sin(yaw),
        target[1] + d * Math.cos(pitch) * Math.cos(yaw),
        target[2] + d * Math.sin(pitch),
      ]
      let eye = eyeAt(dist)
      let proj = M4.persp(FOV, w / h, Math.max(1, dist * 0.02), dist * 8 + sceneSize * 6)
      let view = M4.lookAt(eye, target, [0, 0, 1])
      let viewProj = M4.mul(proj, view)

      // Fit by what actually projects on screen, not by a radius guess: project
      // the eight bbox corners and pull the camera back until every one lands
      // inside a safe rectangle that leaves room for the title block and the
      // caption. Three passes is enough to converge, and it makes a 90mm board
      // and a 2m gantry frame identically.
      const SAFE_X = 0.74
      const SAFE_TOP = 0.72
      const SAFE_BOTTOM = 0.56
      for (let pass = 0; pass < 4; pass += 1) {
        let worst = 1
        for (let corner = 0; corner < 8; corner += 1) {
          const p = [
            corner & 1 ? subj.max[0] : subj.min[0],
            corner & 2 ? subj.max[1] : subj.min[1],
            corner & 4 ? subj.max[2] : subj.min[2],
          ]
          const x = viewProj[0] * p[0] + viewProj[4] * p[1] + viewProj[8] * p[2] + viewProj[12]
          const y = viewProj[1] * p[0] + viewProj[5] * p[1] + viewProj[9] * p[2] + viewProj[13]
          const wv = viewProj[3] * p[0] + viewProj[7] * p[1] + viewProj[11] * p[2] + viewProj[15]
          if (Math.abs(wv) < 1e-6) continue
          const nx = x / wv
          const ny = y / wv
          worst = Math.max(
            worst,
            Math.abs(nx) / SAFE_X,
            ny > 0 ? ny / SAFE_TOP : Math.abs(ny) / SAFE_BOTTOM,
          )
        }
        if (worst <= 1.02) break
        dist *= worst * 1.03
        eye = eyeAt(dist)
        proj = M4.persp(FOV, w / h, Math.max(1, dist * 0.02), dist * 8 + sceneSize * 6)
        view = M4.lookAt(eye, target, [0, 0, 1])
        viewProj = M4.mul(proj, view)
      }

      const keyDir = norm([0.42, 0.55, 0.72])
      const shadowExtent = size * 1.6
      const lightView = M4.lookAt(
        [target[0] + keyDir[0] * shadowExtent, target[1] + keyDir[1] * shadowExtent, target[2] + keyDir[2] * shadowExtent],
        target, [0, 0, 1],
      )
      const lightProj = M4.ortho(-shadowExtent, shadowExtent, -shadowExtent, shadowExtent, 1, shadowExtent * 4)
      const lightViewProj = M4.mul(lightProj, lightView)

      const count = uploadMesh(mesh, matOf, target)

      // 1) shadow pass
      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo)
      gl.viewport(0, 0, SHADOW, SHADOW)
      gl.clear(gl.DEPTH_BUFFER_BIT)
      gl.enable(gl.DEPTH_TEST)
      gl.disable(gl.BLEND)
      gl.enable(gl.POLYGON_OFFSET_FILL)
      gl.polygonOffset(1.6, 4.0)
      gl.useProgram(depthProg)
      gl.uniformMatrix4fv(uni(depthProg, 'uLightViewProj'), false, lightViewProj)
      gl.bindVertexArray(vao)
      gl.drawArrays(gl.TRIANGLES, 0, count)

      gl.disable(gl.POLYGON_OFFSET_FILL)

      // 3) main pass
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, w, h)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.enable(gl.DEPTH_TEST)
      gl.disable(gl.CULL_FACE)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, shadowTex)

      if (!floorReady) buildFloor(Math.max(sceneSize * 3, 600))
      gl.useProgram(floorProg)
      gl.uniformMatrix4fv(uni(floorProg, 'uViewProj'), false, viewProj)
      gl.uniformMatrix4fv(uni(floorProg, 'uLightViewProj'), false, lightViewProj)
      gl.uniform3fv(uni(floorProg, 'uEye'), eye)
      gl.uniform1i(uni(floorProg, 'uShadow'), 0)
      gl.uniform1f(uni(floorProg, 'uShadowTexel'), 1 / SHADOW)
      gl.uniform1f(uni(floorProg, 'uHasShadow'), 1)
      gl.uniform3f(uni(floorProg, 'uPlateColor'), 0.028, 0.037, 0.048)
      gl.uniform1f(uni(floorProg, 'uExtent'), Math.max(sceneSize * 3, 600))
      gl.uniform1f(uni(floorProg, 'uGridMm'), sceneSize > 3000 ? 500 : sceneSize > 600 ? 100 : 50)
      gl.uniform1f(uni(floorProg, 'uContactMm'), (opts && opts.subjectR) || Math.min(size * 0.9, 800))
      gl.uniform1f(uni(floorProg, 'uShowGrid'), opts && opts.grid ? 1 : 0)
      gl.bindVertexArray(floorVao)
      gl.depthMask(false)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      gl.depthMask(true)

      gl.useProgram(meshProg)
      gl.uniformMatrix4fv(uni(meshProg, 'uViewProj'), false, viewProj)
      gl.uniformMatrix4fv(uni(meshProg, 'uLightViewProj'), false, lightViewProj)
      gl.uniform3fv(uni(meshProg, 'uEye'), eye)
      gl.uniform3fv(uni(meshProg, 'uKeyDir'), keyDir)
      gl.uniform3f(uni(meshProg, 'uKeyColor'), 1.12, 1.05, 0.96)
      gl.uniform3fv(uni(meshProg, 'uFillDir'), norm([-0.62, 0.35, 0.40]))
      gl.uniform3f(uni(meshProg, 'uFillColor'), 0.20, 0.27, 0.36)
      gl.uniform3fv(uni(meshProg, 'uRimDir'), norm([-0.35, -0.75, 0.35]))
      gl.uniform3f(uni(meshProg, 'uRimColor'), 0.22, 0.58, 0.72)
      gl.uniform3f(uni(meshProg, 'uSkyColor'), 0.20, 0.24, 0.30)
      gl.uniform3f(uni(meshProg, 'uGroundColor'), 0.07, 0.08, 0.09)
      gl.uniform1i(uni(meshProg, 'uShadow'), 0)
      gl.uniform1f(uni(meshProg, 'uShadowTexel'), 1 / SHADOW)
      gl.uniform1f(uni(meshProg, 'uHasShadow'), 1)
      if (envTex) {
        gl.activeTexture(gl.TEXTURE4)
        gl.bindTexture(gl.TEXTURE_2D, envTex)
        gl.uniform1i(uni(meshProg, 'uEnv'), 4)
        gl.uniform1f(uni(meshProg, 'uUseEnv'), 1)
      } else {
        gl.uniform1f(uni(meshProg, 'uUseEnv'), 0)
      }
      gl.bindVertexArray(vao)
      gl.drawArrays(gl.TRIANGLES, 0, count)
      gl.bindVertexArray(null)

      // bench overlay: support polygon, CoM plumb + reticle — world-space
      // lines drawn last so they read on top of the machine, depth-tested so
      // a plumb line behind a link honestly hides
      if (overlay && overlay.data && overlay.data.length) {
        gl.useProgram(lineProg)
        gl.uniformMatrix4fv(uni(lineProg, 'uViewProj'), false, viewProj)
        gl.bindVertexArray(lineVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo)
        gl.bufferData(gl.ARRAY_BUFFER, overlay.data, gl.DYNAMIC_DRAW)
        const stride = 6 * 4
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0)
        gl.enableVertexAttribArray(1)
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12)
        gl.depthMask(false)
        gl.drawArrays(gl.LINES, 0, overlay.verts)
        gl.depthMask(true)
        gl.bindVertexArray(null)
      }
      // self-check: read back a horizontal strip so a silently blank frame is
      // detectable from the outside
      const probe = new Uint8Array(4 * 64 * 4)
      gl.readPixels(0, Math.floor(h * 0.5), 64, 4, gl.RGBA, gl.UNSIGNED_BYTE, probe)
      let nz = 0
      let maxv = 0
      for (let i = 0; i < probe.length; i += 4) {
        if (probe[i] + probe[i + 1] + probe[i + 2] > 0) nz += 1
        maxv = Math.max(maxv, probe[i], probe[i + 1], probe[i + 2])
      }
      globalThis.__rfGLStats = {
        draws: ((globalThis.__rfGLStats || {}).draws || 0) + 1,
        tris: count / 3, eye, dist, size, stripNonZero: nz, stripMax: maxv,
        albedos: uniqueAlbedos,
        firstAlb: null,
      }
    },
    /** Hand the renderer a finished bake for a specific mesh. */
    setAO(mesh, data) { aoMesh = mesh; aoData = data },
    dispose() {
      try {
        gl.deleteBuffer(vbo); gl.deleteBuffer(ibo); gl.deleteTexture(shadowTex)
        gl.deleteFramebuffer(shadowFbo); gl.deleteVertexArray(vao); gl.deleteVertexArray(floorVao)
        gl.deleteBuffer(lineVbo); gl.deleteVertexArray(lineVao)
      } catch (e) { /* context already gone */ }
    },
  }
}
