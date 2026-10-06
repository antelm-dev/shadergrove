#version 300 es
// ESSL 3.00 vertex with Three.js's WebGL2 compatibility defines.
#define attribute in
#define varying out
#define texture2D texture
precision highp float;
precision highp int;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
flat out int vInstance;

void main() {
  vUv = uv;
  vInstance = gl_InstanceID;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
