/*{
  "ISFVSN": "2.0",
  "DESCRIPTION": "Wobble",
  "CREDIT": "Shadergrove fixture",
  "CATEGORIES": ["Distortion Effect"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" }
  ]
}*/

void main() {
  vec2 coord = isf_FragNormCoord;
  // A gentle sideways wave, in pixels, sized by the render.
  float wave = sin(coord.y * 24.0 + TIME * 2.0) * 6.0 / RENDERSIZE.x;
  gl_FragColor = IMG_NORM_PIXEL(inputImage, vec2(coord.x + wave, coord.y));
}
