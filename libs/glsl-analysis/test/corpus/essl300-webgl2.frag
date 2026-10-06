#version 300 es
// ESSL 3.00 fragment: Three.js's WebGL2 compatibility defines in front of an
// ESSL 1.00-style body, plus free uniforms, a block, arrays and overloads.
#define varying in
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define texture2D texture
precision highp float;
precision highp int;

uniform float iTime;
uniform vec2 iResolution;
uniform sampler2D iChannel0;
uniform vec3 u_palette[4];
uniform mat3 u_warp;

uniform Lights {
  vec4 positions[2];
  vec4 colors[2];
} lights;

uniform Globals {
  float exposure;
};

varying vec2 vUv;

const float PI = 3.14159265;
const vec3 WEIGHTS[3] = vec3[3](vec3(0.2), vec3(0.3), vec3(0.5));
float g_accumulated;

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }

void accumulate(in vec3 sampleColor, inout vec3 total, out float weight) {
  weight = dot(sampleColor, WEIGHTS[1]);
  total += sampleColor * weight;
}

vec3 palette(float t) {
  int i = int(floor(t * 3.0)) % 4;
  return u_palette[i];
}

void main() {
  vec3 total = vec3(0.0);
  float weight;
  for (int i = 0; i < 2; i++) {
    vec3 c = lights.colors[i].rgb * saturate(1.0 - length(vUv - lights.positions[i].xy));
    accumulate(c, total, weight);
    g_accumulated += weight;
  }
  vec3 tex = texture2D(iChannel0, (u_warp * vec3(vUv, 1.0)).xy).rgb;
  vec3 color = saturate(total + tex * palette(fract(iTime / PI)) * exposure);
  uint bits = floatBitsToUint(color.r);
  gl_FragColor = vec4(color, float(bits & 1u));
}
