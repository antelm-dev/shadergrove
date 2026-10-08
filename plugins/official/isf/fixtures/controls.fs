/*{
  "ISFVSN": "2",
  "DESCRIPTION": "Posterize",
  "CREDIT": "Shadergrove fixture",
  "CATEGORIES": ["Stylize"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "levels", "TYPE": "float", "LABEL": "Levels", "DEFAULT": 4.0, "MIN": 2.0, "MAX": 16.0 },
    { "NAME": "invert", "TYPE": "bool", "LABEL": "Invert", "DEFAULT": false },
    { "NAME": "tint", "TYPE": "color", "LABEL": "Tint", "DEFAULT": [1.0, 0.5, 0.25, 1.0] },
    {
      "NAME": "channel",
      "TYPE": "long",
      "LABEL": "Channel",
      "VALUES": [0, 1, 2],
      "LABELS": ["All", "Luma", "Red"],
      "DEFAULT": 0
    }
  ]
}*/

void main() {
  vec4 pixel = IMG_THIS_PIXEL(inputImage);
  vec3 color = pixel.rgb;
  if (channel == 1) {
    color = vec3(dot(color, vec3(0.299, 0.587, 0.114)));
  } else if (channel == 2) {
    color = vec3(color.r);
  }
  color = floor(color * levels) / (levels - 1.0);
  if (invert) {
    color = 1.0 - color;
  }
  gl_FragColor = vec4(color * tint.rgb, pixel.a);
}
