import { FRAGMENT_SHADER, VERTEX_SHADER } from './chroma-vignette.glsl';

export interface ShaderParams {
  /** Chroma key */
  keyEnabled: boolean;
  /** Key color as 0..1 RGB. Default = pure green (0,1,0). */
  keyColor: [number, number, number];
  /** Distance from key in chroma space below which alpha → 0. */
  similarity: number;
  /** Width of the smoothstep ramp between matte and keep. */
  smoothness: number;
  /** Knoll-despill strength on body pixels — caps green at max(r,b). */
  spill: number;
  /** Matte choke: -0.2..+0.2. Positive erodes inward (eats fringe);
   *  negative expands outward (recovers detail eaten by similarity). */
  choke: number;
  /** Extra despill in the partial-alpha fringe zone — caps green at
   *  min(r,b) blended by edge weight. Cleans hair halos without
   *  shifting body skin tones. */
  edgeDespill: number;
  /** Edge color restore: replaces fringe color with a sampled
   *  neighborhood color (8-tap ring at radius 3 texels, weighted by
   *  "non-background-ness"). Eliminates dark halo around hair that
   *  channel-clamping despill leaves behind. */
  edgeColorRestore: number;
  /** Alpha curve reshape. <1 = softer edges (fine hair); >1 = harder
   *  cutout. =1 leaves smoothstep unmodified. */
  alphaGamma: number;

  /** Bilateral denoise / deblock — smooths blocking artifacts in flat
   *  regions while preserving real edges. Also stabilizes the chroma
   *  matte by feeding it a less-noisy input. */
  denoise: number;
  /** Bilateral color tolerance — higher = smooths through bigger
   *  color steps (more aggressive blur). 0.05–0.12 is a good range. */
  denoiseSigma: number;

  /** Unsharp mask 0..1 — restores edge crispness softened by WebRTC. */
  sharpen: number;
  /** Cap on devicePixelRatio for the avatar canvas. Lower → fewer
   *  pixels rendered, less obvious upscale stretching from the
   *  ~720p WebRTC source. 1.0 hands final scale to the OS bicubic.
   */
  maxDpr: number;

  /** Use the local placeholder image as the texture source instead of
   *  the live Anam video. Lets you dial in chroma params offline. */
  standIn: boolean;
}

export const DEFAULT_PARAMS: ShaderParams = {
  keyEnabled: false,
  keyColor: [0.0, 1.0, 0.0],
  similarity: 0.35,
  smoothness: 0.12,
  spill: 0.85,
  choke: 0.02,
  edgeDespill: 0.5,
  edgeColorRestore: 0.7,
  alphaGamma: 1.0,
  denoise: 0.55,
  denoiseSigma: 0.08,
  sharpen: 0.35,
  maxDpr: 1.0,
  standIn: false,
};

/** A single-shader renderer driven by a HTMLVideoElement and a RAF loop. */
export class ChromaVignetteRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture;
  private rafId: number | null = null;
  private params: ShaderParams = DEFAULT_PARAMS;
  private videoEl: HTMLVideoElement;
  private imageEl: HTMLImageElement | null = null;
  private uniformLocs: Record<string, WebGLUniformLocation | null> = {};
  private lastVideoSize = { w: 0, h: 0 };
  private effectiveDpr(): number {
    return Math.min(window.devicePixelRatio || 1, this.params.maxDpr);
  }
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, videoEl: HTMLVideoElement) {
    this.canvas = canvas;
    this.videoEl = videoEl;
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      antialias: false,
      alpha: true,
    });
    if (!gl) throw new Error('WebGL2 unavailable — pat-web needs a WebGL2-capable browser');
    this.gl = gl;

    this.program = this.compileProgram();
    gl.useProgram(this.program);
    this.cacheUniformLocations();

    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  setParams(p: Partial<ShaderParams>): void {
    this.params = { ...this.params, ...p };
  }

  /** Optional still-image source. When `params.standIn` is true the
   *  renderer samples this instead of the video. */
  setImageSource(el: HTMLImageElement | null): void {
    this.imageEl = el;
  }

  start(): void {
    if (this.rafId !== null) return;
    const loop = () => {
      this.renderFrame();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  dispose(): void {
    this.stop();
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
  }

  private renderFrame(): void {
    const gl = this.gl;

    // Pick the source. Stand-in mode uses the still image; otherwise
    // we sample the live video. We treat both through the same
    // texImage2D path — WebGL2 accepts either as a TexImageSource.
    let source: HTMLVideoElement | HTMLImageElement;
    let srcW: number;
    let srcH: number;
    if (this.params.standIn && this.imageEl && this.imageEl.complete && this.imageEl.naturalWidth > 0) {
      source = this.imageEl;
      srcW = this.imageEl.naturalWidth;
      srcH = this.imageEl.naturalHeight;
    } else {
      const v = this.videoEl;
      if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      source = v;
      srcW = v.videoWidth || this.lastVideoSize.w;
      srcH = v.videoHeight || this.lastVideoSize.h;
      if (srcW && srcH) this.lastVideoSize = { w: srcW, h: srcH };
    }
    if (!srcW || !srcH) return;

    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    const dpr = this.effectiveDpr();
    const targetW = Math.max(1, Math.floor(cssW * dpr));
    const targetH = Math.max(1, Math.floor(cssH * dpr));
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source,
    );
    const vw = srcW;
    const vh = srcH;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    this.uploadUniforms(vw, vh);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniformLocs.u_video!, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private uploadUniforms(vw: number, vh: number): void {
    const gl = this.gl;
    const p = this.params;
    const u = this.uniformLocs;
    gl.uniform2f(u.u_videoSize!, vw, vh);
    gl.uniform2f(u.u_canvasSize!, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.u_keyEnabled!, p.keyEnabled ? 1 : 0);
    gl.uniform3f(u.u_keyColor!, p.keyColor[0], p.keyColor[1], p.keyColor[2]);
    gl.uniform1f(u.u_similarity!, p.similarity);
    gl.uniform1f(u.u_smoothness!, p.smoothness);
    gl.uniform1f(u.u_spill!, p.spill);
    gl.uniform1f(u.u_choke!, p.choke);
    gl.uniform1f(u.u_edgeDespill!, p.edgeDespill);
    gl.uniform1f(u.u_edgeColorRestore!, p.edgeColorRestore);
    gl.uniform1f(u.u_alphaGamma!, p.alphaGamma);
    gl.uniform1f(u.u_denoise!, p.denoise);
    gl.uniform1f(u.u_denoiseSigma!, p.denoiseSigma);
    gl.uniform1f(u.u_sharpen!, p.sharpen);
  }

  private cacheUniformLocations(): void {
    const gl = this.gl;
    const names = [
      'u_video',
      'u_videoSize',
      'u_canvasSize',
      'u_keyEnabled',
      'u_keyColor',
      'u_similarity',
      'u_smoothness',
      'u_spill',
      'u_choke',
      'u_edgeDespill',
      'u_edgeColorRestore',
      'u_alphaGamma',
      'u_denoise',
      'u_denoiseSigma',
      'u_sharpen',
    ];
    for (const n of names) {
      this.uniformLocs[n] = gl.getUniformLocation(this.program, n);
    }
  }

  private compileProgram(): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) ?? '<no log>';
      gl.deleteProgram(prog);
      throw new Error(`shader link failed: ${log}`);
    }
    return prog;
  }

  private compileShader(kind: number, source: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(kind)!;
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? '<no log>';
      gl.deleteShader(sh);
      throw new Error(`shader compile failed: ${log}\n${source}`);
    }
    return sh;
  }
}
