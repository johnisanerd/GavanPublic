/**
 * Shader: cover-fit sample of the source video + optional chroma key
 * with spill suppression. One draw call per RAF.
 *
 * Vignette intentionally lives elsewhere (see VignetteOverlay) — a
 * top-layer black mask that darkens both the avatar AND whatever
 * background HTML sits behind it. Baking the vignette into this
 * shader's alpha would only feather the avatar.
 *
 * The output is straight-alpha RGBA. Composited over whatever's behind
 * the canvas with standard SRC_ALPHA/ONE_MINUS_SRC_ALPHA blending.
 */

export const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

out vec2 v_uv;

// Full-screen triangle pair via gl_VertexID — no VBOs needed.
void main() {
  vec2 pos[6] = vec2[6](
    vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
    vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0)
  );
  vec2 p = pos[gl_VertexID];
  v_uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_video;
uniform vec2 u_videoSize;
uniform vec2 u_canvasSize;

uniform float u_keyEnabled;
uniform vec3  u_keyColor;
uniform float u_similarity;     // 0..1
uniform float u_smoothness;     // 0..1
uniform float u_spill;          // 0..1 — body despill (Knoll formula)
uniform float u_choke;          // -0.2..+0.2 — matte erode (+) / expand (-)
uniform float u_edgeDespill;    // 0..1 — extra despill in the fringe zone
uniform float u_edgeColorRestore; // 0..1 — replace fringe color with sampled neighbor color
uniform float u_alphaGamma;     // 0.5..2.0 — softer (<1) / harder (>1) edges

uniform float u_denoise;        // 0..1 — bilateral filter strength (deblock)
uniform float u_denoiseSigma;   // 0.02..0.4 — color tolerance; higher = blur more
uniform float u_sharpen;        // 0..1 — unsharp mask strength

in vec2 v_uv;
out vec4 outColor;

// RGB → YCbCr chroma plane. Cheaper than HSV and tracks the
// "greenness" axis cleanly which is what we want for keying.
vec2 rgb2cc(vec3 rgb) {
  float y  = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  return vec2((rgb.b - y) * 0.5389, (rgb.r - y) * 0.6350);
}

void main() {
  // ── Cover-fit sample ────────────────────────────────────────────
  // Always fill the canvas vertically; crop horizontally if canvas
  // is narrower than the source video.
  float videoAspect  = u_videoSize.x  / max(u_videoSize.y, 1.0);
  float canvasAspect = u_canvasSize.x / max(u_canvasSize.y, 1.0);
  vec2 scale = vec2(canvasAspect / videoAspect, 1.0);
  vec2 sampleUv = (v_uv - 0.5) * scale + 0.5;

  if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }

  vec3 src = texture(u_video, sampleUv).rgb;

  // ── Bilateral denoise (deblock pass) ────────────────────────────
  // 8-tap edge-preserving blur in source-texture space. Samples each
  // neighbour and weights it by exp(-Δcolor²/σ²) — smooths flat
  // regions where VP8/VP9 blocking shows, but spares high-contrast
  // edges (eyes, hair, lapel). Running this BEFORE the chroma key
  // also stabilizes the matte against quantization noise.
  if (u_denoise > 0.0) {
    vec2 texel = vec2(1.0 / u_videoSize.x, 1.0 / u_videoSize.y);
    vec3 acc = src;
    float wTotal = 1.0;
    vec2 dirs[8] = vec2[8](
      vec2(-1,-1), vec2(0,-1), vec2(1,-1),
      vec2(-1, 0),              vec2(1, 0),
      vec2(-1, 1), vec2(0, 1),  vec2(1, 1)
    );
    float sig = max(u_denoiseSigma, 0.0001);
    float sig2 = sig * sig * 2.0;
    for (int i = 0; i < 8; i++) {
      vec3 s = texture(u_video, sampleUv + dirs[i] * texel).rgb;
      vec3 d = s - src;
      float dc2 = dot(d, d);
      float w = exp(-dc2 / sig2);
      acc += s * w;
      wTotal += w;
    }
    vec3 smoothed = acc / wTotal;
    src = mix(src, smoothed, u_denoise);
  }

  // ── Unsharp mask (subtle edge restore on upscaled WebRTC video) ─
  // Sample 4-neighbour pixels in source-texture space; the Laplacian
  // (center * 5 - sum of neighbours) is the high-frequency residue.
  // Adding a scaled fraction back sharpens edges without amplifying
  // the broad gradients that hold most of the compression noise.
  if (u_sharpen > 0.0) {
    vec2 texel = vec2(1.0 / u_videoSize.x, 1.0 / u_videoSize.y);
    vec3 n = texture(u_video, sampleUv + vec2(0.0, -texel.y)).rgb
           + texture(u_video, sampleUv + vec2(0.0,  texel.y)).rgb
           + texture(u_video, sampleUv + vec2(-texel.x, 0.0)).rgb
           + texture(u_video, sampleUv + vec2( texel.x, 0.0)).rgb;
    vec3 lap = src * 4.0 - n;
    src = clamp(src + lap * u_sharpen * 0.25, 0.0, 1.0);
  }

  // ── Chroma key ──────────────────────────────────────────────────
  float keyAlpha = 1.0;
  if (u_keyEnabled > 0.5) {
    vec2 srcCC = rgb2cc(src);
    vec2 keyCC = rgb2cc(u_keyColor);
    float d = distance(srcCC, keyCC);

    // 1. Matte choke: shift the inner threshold inward (+) or outward
    //    (-) without touching the smoothstep ramp width. Lets you
    //    eat green-tinted fringe without softening the edge curve.
    float effSim = u_similarity + u_choke;
    keyAlpha = smoothstep(effSim, effSim + max(u_smoothness, 0.0001), d);

    // 2. Alpha gamma — reshape the falloff curve. <1 = softer (preserves
    //    fine hair), >1 = harder (snappier cutout). Modulates the
    //    *shape* of the transition, not its location.
    keyAlpha = pow(clamp(keyAlpha, 0.0, 1.0), u_alphaGamma);

    // 3. Knoll-style despill on the body: cap green at max(r, b)
    //    blended by u_spill. At spill=0 the source is untouched; at
    //    spill=1 green can't exceed the brighter of red/blue, which
    //    is the canonical "spill removed" condition.
    if (u_spill > 0.0) {
      float maxRB = max(src.r, src.b);
      src.g = mix(src.g, min(src.g, maxRB), u_spill);
    }

    // 4. Edge despill — additional clamping over the fringe zone.
    //    Weight plateaus at 1.0 from α≈0.05 to α≈0.85, then falls
    //    to 0 at α=1 (pure body) and α=0 (pure background). This
    //    catches hair-tip pixels that are mostly-opaque but still
    //    have green spill — the previous 4α(1-α) hump missed those.
    float edgeWeight = smoothstep(0.0, 0.05, keyAlpha) * (1.0 - smoothstep(0.85, 1.0, keyAlpha));
    if (u_edgeDespill > 0.0) {
      float minRB = min(src.r, src.b);
      // Allow u_edgeDespill > 1 so cranking actually crushes.
      src.g = mix(src.g, min(src.g, minRB), clamp(edgeWeight * u_edgeDespill, 0.0, 1.0));
    }

    // 5. Edge color restore — replace the fringe pixel's COLOR with
    //    a sampled "what should be there" from neighboring opaque
    //    pixels. This is what professional keyers do: instead of just
    //    clamping the green channel (which makes hair fringe dark),
    //    we inpaint the fringe with body-side color. Only fires
    //    where the fringe is genuine, so cost is bounded.
    if (u_edgeColorRestore > 0.0 && edgeWeight > 0.02) {
      vec2 texel = 1.0 / u_videoSize;
      // 8-tap ring sample at radius 3 texels — far enough to escape
      // the fringe itself, close enough that the color is local.
      vec2 dirs[8] = vec2[8](
        vec2(-1,-1), vec2(0,-1), vec2(1,-1),
        vec2(-1, 0),              vec2(1, 0),
        vec2(-1, 1), vec2(0, 1),  vec2(1, 1)
      );
      vec3 acc = vec3(0.0);
      float wTotal = 0.0;
      vec2 keyCC2 = rgb2cc(u_keyColor);
      for (int i = 0; i < 8; i++) {
        vec3 s = texture(u_video, sampleUv + dirs[i] * 3.0 * texel).rgb;
        // Weight by "how far from key color" in chroma space — i.e.
        // weight neighbors that are clearly NOT background.
        vec2 cc = rgb2cc(s);
        float w = smoothstep(u_similarity, u_similarity + max(u_smoothness, 0.0001), distance(cc, keyCC2));
        acc += s * w;
        wTotal += w;
      }
      if (wTotal > 0.001) {
        vec3 neighbor = acc / wTotal;
        // Knoll-despill the sampled color too in case any of the
        // contributing neighbors carried spill.
        float maxRB = max(neighbor.r, neighbor.b);
        neighbor.g = min(neighbor.g, maxRB);
        src = mix(src, neighbor, clamp(edgeWeight * u_edgeColorRestore, 0.0, 1.0));
      }
    }
  }

  outColor = vec4(src, keyAlpha);
}
`;
