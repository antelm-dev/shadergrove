// ESSL 1.00 vertex: a Three.js-style generated prefix followed by the user's
// default vertex shader (cf. examples/shaders/*/vertex.glsl).
precision highp float;
precision highp int;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
// ---- user source ----
varying vec2 vUv;

vec4 toClip(vec3 p) {
  return projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}

void main() {
  vUv = uv;
  gl_Position = toClip(position);
}
