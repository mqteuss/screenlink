import { useEffect, useRef } from 'react';
import { Mesh, Program, Renderer, Triangle } from 'ogl';
import './GradientWaves.css';

type DetailLevel = 'low' | 'medium' | 'high';

export type GradientWavesProps = {
  horizonColor?: string;
  waveColor?: string;
  crestColor?: string;
  speed?: number;
  amplitude?: number;
  waveScale?: number;
  waveRatio?: number;
  swell?: number;
  turbulence?: number;
  tilt?: number;
  zoom?: number;
  height?: number;
  fogDepth?: number;
  detail?: DetailLevel;
  brightness?: number;
  opacity?: number;
  mouseInteraction?: boolean;
  parallaxStrength?: number;
  grain?: boolean;
  grainIntensity?: number;
  animated?: boolean;
  className?: string;
};

type WaveContext = { renderer: Renderer; program: Program; mesh: Mesh };

const contexts = new WeakMap<HTMLElement, WaveContext>();

function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [1, 1, 1];
  return [Number.parseInt(result[1], 16) / 255, Number.parseInt(result[2], 16) / 255, Number.parseInt(result[3], 16) / 255];
}

function detailToSteps(detail: DetailLevel) {
  if (detail === 'low') return 40;
  if (detail === 'high') return 110;
  return 70;
}

const vertex = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragment = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uWaveScale;
uniform float uWaveRatio;
uniform float uSwell;
uniform float uTurbulence;
uniform float uTilt;
uniform float uZoom;
uniform float uHeight;
uniform float uFogDepth;
uniform float uSteps;
uniform float uBrightness;
uniform float uOpacity;
uniform float uGrain;
uniform float uGrainIntensity;
uniform vec2 uMouse;
uniform float uParallax;
uniform bool uEnableMouse;
uniform vec3 uHorizonColor;
uniform vec3 uWaveColor;
uniform vec3 uCrestColor;
out vec4 fragColor;

const float MAX_DIST = 20000.0;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float plasma(vec3 r, vec2 freq, vec4 tc) {
  float mx = r.x + tc.x;
  mx += uSwell * sin((r.y + mx) / 20.0 + tc.y);
  float my = r.y - tc.z;
  my += uTurbulence * cos(r.x / 23.0 + tc.w);
  return r.z - (sin(mx * freq.x) * uAmplitude + sin(my * freq.y) * uAmplitude + uHeight);
}

float raymarch(vec3 pos, vec3 dir, vec2 freq, vec4 tc) {
  float dist = 0.0;
  for (int i = 0; i < 128; i++) {
    if (float(i) >= uSteps) break;
    float dscene = plasma(pos + dist * dir, freq, tc);
    if (abs(dscene) < 0.1) break;
    dist += 0.9 * dscene;
    if (!(abs(dist) < MAX_DIST)) return MAX_DIST;
  }
  return dist;
}

void main() {
  float T = iTime * uSpeed;
  vec2 freq = vec2(uWaveScale / 7.0, (uWaveScale * uWaveRatio) / 3.0);
  vec4 tc = vec4(T / 0.130, T / 0.810, T / 0.200, T / 0.710);
  float c, s;
  float vfov = (3.14159 / 2.3) / max(uZoom, 0.05);
  vec3 cam = vec3(0.0, 0.0, 30.0);
  vec2 uv = (gl_FragCoord.xy / iResolution.xy) - 0.5;
  uv.x *= iResolution.x / iResolution.y;
  uv.y *= -1.0;

  vec3 dir = vec3(0.0, 0.0, -1.0);
  float ulen = length(uv);
  float xrot = vfov * ulen;
  c = cos(xrot); s = sin(xrot);
  dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  vec2 nuv = ulen > 1e-5 ? uv / ulen : vec2(1.0, 0.0);
  c = nuv.x; s = nuv.y;
  dir = mat3(c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0) * dir;
  c = cos(uTilt); s = sin(uTilt);
  dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;

  if (uEnableMouse) {
    float yaw = (uMouse.x - 0.5) * uParallax * 0.4;
    float pitch = (uMouse.y - 0.5) * uParallax * 0.4;
    c = cos(yaw); s = sin(yaw);
    dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;
    c = cos(pitch); s = sin(pitch);
    dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  }

  float dist = raymarch(cam, dir, freq, tc);
  vec3 pos = cam + dist * dir;
  float t = clamp(uFogDepth / max(dist, 0.001), 0.0, 1.0);
  vec3 body = mix(uWaveColor, uCrestColor, clamp(pos.z * 0.08 + 0.5, 0.0, 1.0));
  vec3 col = clamp(mix(uHorizonColor, body, t) * uBrightness, 0.0, 1.0);
  float alpha = clamp(t, 0.0, 1.0) * uOpacity;
  if (uGrain > 0.5) {
    float g = hash21(gl_FragCoord.xy + mod(iTime, 64.0) * 11.0);
    alpha += (g - 0.5) * uGrainIntensity;
  }
  alpha = clamp(alpha, 0.0, 1.0);
  fragColor = vec4(col * alpha, alpha);
}
`;

export default function GradientWaves({
  horizonColor = '#5227FF',
  waveColor = '#FF9FFC',
  crestColor = '#FFFFFF',
  speed = 0.4,
  amplitude = 2.5,
  waveScale = 0.6,
  waveRatio = 0.9,
  swell = 35,
  turbulence = 20,
  tilt = 1.11,
  zoom = 1,
  height = 5.5,
  fogDepth = 15,
  detail = 'medium',
  brightness = 1,
  opacity = 1,
  mouseInteraction = true,
  parallaxStrength = 0.5,
  grain = true,
  grainIntensity = 0.05,
  animated = true,
  className = ''
}: GradientWavesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const enableMouseRef = useRef(mouseInteraction);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: Renderer;
    try {
      const maximumDpr = detail === 'low' ? 1.25 : detail === 'high' ? 2 : 1.6;
      renderer = new Renderer({
        webgl: 2,
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        dpr: Math.min(window.devicePixelRatio || 1, maximumDpr),
        powerPreference: 'low-power'
      });
    } catch {
      container.dataset.webgl = 'unavailable';
      return;
    }

    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    const canvas = gl.canvas;
    canvas.setAttribute('aria-hidden', 'true');
    container.append(canvas);

    const geometry = new Triangle(gl);
    const program = new Program(gl, {
      vertex,
      fragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        iTime: { value: 0 },
        iResolution: { value: new Float32Array([1, 1]) },
        uSpeed: { value: 0.4 },
        uAmplitude: { value: 2.5 },
        uWaveScale: { value: 0.6 },
        uWaveRatio: { value: 0.9 },
        uSwell: { value: 35 },
        uTurbulence: { value: 20 },
        uTilt: { value: 1.11 },
        uZoom: { value: 1 },
        uHeight: { value: 5.5 },
        uFogDepth: { value: 15 },
        uSteps: { value: 70 },
        uBrightness: { value: 1 },
        uOpacity: { value: 1 },
        uGrain: { value: 1 },
        uGrainIntensity: { value: 0.05 },
        uMouse: { value: new Float32Array([0.5, 0.5]) },
        uParallax: { value: 0.5 },
        uEnableMouse: { value: true },
        uHorizonColor: { value: new Float32Array([1, 1, 1]) },
        uWaveColor: { value: new Float32Array([1, 1, 1]) },
        uCrestColor: { value: new Float32Array([1, 1, 1]) }
      }
    });
    const mesh = new Mesh(gl, { geometry, program });
    contexts.set(container, { renderer, program, mesh });

    const renderFrame = (time = 0) => {
      program.uniforms.iTime.value = time;
      renderer.render({ scene: mesh });
    };
    const setSize = () => {
      const rect = container.getBoundingClientRect();
      renderer.setSize(Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)));
      const resolution = program.uniforms.iResolution.value as Float32Array;
      resolution[0] = gl.drawingBufferWidth;
      resolution[1] = gl.drawingBufferHeight;
      renderFrame();
    };

    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(setSize) : null;
    resizeObserver?.observe(container);
    setSize();

    const currentMouse = [0.5, 0.5];
    const targetMouse = [0.5, 0.5];
    const onPointerMove = (event: PointerEvent) => {
      if (!enableMouseRef.current) return;
      const rect = container.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      targetMouse[0] = inside ? (event.clientX - rect.left) / rect.width : 0.5;
      targetMouse[1] = inside ? 1 - (event.clientY - rect.top) / rect.height : 0.5;
    };
    if (animated) window.addEventListener('pointermove', onPointerMove, { passive: true });

    let frame = 0;
    let intersecting = true;
    let pageVisible = !document.hidden;
    const startedAt = performance.now();
    const loop = (timestamp: number) => {
      const targetX = enableMouseRef.current ? targetMouse[0] : 0.5;
      const targetY = enableMouseRef.current ? targetMouse[1] : 0.5;
      currentMouse[0] += 0.05 * (targetX - currentMouse[0]);
      currentMouse[1] += 0.05 * (targetY - currentMouse[1]);
      const mouse = program.uniforms.uMouse.value as Float32Array;
      mouse[0] = currentMouse[0];
      mouse[1] = currentMouse[1];
      renderFrame((timestamp - startedAt) * 0.001);
      frame = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (!frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const start = () => {
      if (animated && intersecting && pageVisible && !frame) frame = requestAnimationFrame(loop);
    };

    const intersectionObserver = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([entry]) => {
          intersecting = entry.isIntersecting;
          if (intersecting) start();
          else stop();
        })
      : null;
    intersectionObserver?.observe(container);
    const onVisibilityChange = () => {
      pageVisible = !document.hidden;
      if (pageVisible) start();
      else stop();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    start();

    return () => {
      stop();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (animated) window.removeEventListener('pointermove', onPointerMove);
      contexts.delete(container);
      canvas.remove();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [animated, detail]);

  useEffect(() => {
    const container = containerRef.current;
    const context = container ? contexts.get(container) : null;
    if (!context) return;
    const uniforms = context.program.uniforms;
    enableMouseRef.current = animated && mouseInteraction;
    uniforms.uSpeed.value = speed;
    uniforms.uAmplitude.value = amplitude;
    uniforms.uWaveScale.value = waveScale;
    uniforms.uWaveRatio.value = waveRatio;
    uniforms.uSwell.value = swell;
    uniforms.uTurbulence.value = turbulence;
    uniforms.uTilt.value = tilt;
    uniforms.uZoom.value = zoom;
    uniforms.uHeight.value = height;
    uniforms.uFogDepth.value = fogDepth;
    uniforms.uSteps.value = detailToSteps(detail);
    uniforms.uBrightness.value = brightness;
    uniforms.uOpacity.value = opacity;
    uniforms.uGrain.value = grain && animated ? 1 : 0;
    uniforms.uGrainIntensity.value = grainIntensity;
    uniforms.uParallax.value = parallaxStrength;
    uniforms.uEnableMouse.value = animated && mouseInteraction;
    for (const [uniformName, color] of [
      ['uHorizonColor', horizonColor],
      ['uWaveColor', waveColor],
      ['uCrestColor', crestColor]
    ] as const) {
      const target = uniforms[uniformName].value as Float32Array;
      const rgb = hexToRgb(color);
      target[0] = rgb[0];
      target[1] = rgb[1];
      target[2] = rgb[2];
    }
    context.renderer.render({ scene: context.mesh });
  }, [amplitude, animated, brightness, crestColor, detail, fogDepth, grain, grainIntensity, height, horizonColor, mouseInteraction, opacity, parallaxStrength, speed, swell, tilt, turbulence, waveColor, waveRatio, waveScale, zoom]);

  return <div ref={containerRef} className={`gradient-waves-container ${animated ? 'is-animated' : 'is-static'} ${className}`.trim()} aria-hidden="true"/>;
}
