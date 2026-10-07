/*{
  "ISFVSN": "2",
  "DESCRIPTION": "Warm tint",
  "CREDIT": "Shadergrove fixture",
  "CATEGORIES": ["Color Adjustment"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" }
  ]
}*/

void main() {
  vec4 pixel = IMG_THIS_PIXEL(inputImage);
  gl_FragColor = vec4(pixel.r * 1.2, pixel.g, pixel.b * 0.6, pixel.a);
}
