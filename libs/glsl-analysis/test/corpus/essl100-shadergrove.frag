// ESSL 1.00 fragment in Shadergrove's house style (cf. examples/shaders/hex-pulse),
// after the editor has substituted the engine macro __MAX_WAVES__.
#extension GL_OES_standard_derivatives : enable
precision highp float;

#define MAX_WAVES 8
#define TAU 6.2831853
#define SQ(x) ((x) * (x))

uniform vec2 iResolution;
uniform float iTime;
uniform vec4 iMouse;
uniform vec3 u_clickData[MAX_WAVES];
uniform sampler2D u_noise;

// One uniform per control.
uniform float u_timeScale;
uniform vec3 u_colorCell;
uniform bool u_invert;
uniform int u_steps;

varying vec2 vUv;

const int C_MAX_WAVES = MAX_WAVES;
const vec2 HEX = vec2(1.0, 1.7320508);

struct Ripple {
  vec2 origin;
  float age;
};

float hash1(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
}

float hash1(float n) {
  return fract(sin(n) * 43758.5453123);
}

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

Ripple ripple(int i) {
  return Ripple(u_clickData[i].xy / iResolution, iTime - u_clickData[i].z);
}

void main() {
  vec2 uv = rot(iTime * u_timeScale) * (vUv - 0.5);
  float energy = 0.0;
  for (int i = 0; i < C_MAX_WAVES; ++i) {
    Ripple r = ripple(i);
    if (r.age <= 0.0) continue;
    energy += exp(-SQ(length(uv - r.origin) - r.age));
  }
#ifdef GL_OES_standard_derivatives
  float aa = fwidth(energy);
#else
  float aa = 0.01;
#endif
  vec3 color = u_colorCell * smoothstep(0.0, aa + 0.5, energy) * hash1(floor(uv * HEX));
  color += texture2D(u_noise, vUv).rgb * hash1(float(u_steps)) * TAU * 0.0;
  if (u_invert) color = 1.0 - color;
  gl_FragColor = vec4(color, 1.0);
}
