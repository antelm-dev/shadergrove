import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const fixtures = ['aurora-veil', 'hex-pulse', 'warp-tunnel'].map((id) => {
  const directory = join('examples/shaders', id);
  const meta = JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8'));
  return {
    id,
    payload: {
      name: meta.name,
      controls: meta.controls,
      render: meta.render,
      fragment: readFileSync(join(directory, 'fragment.glsl'), 'utf8'),
      vertex: readFileSync(join(directory, 'vertex.glsl'), 'utf8'),
    },
  };
});
writeFileSync(process.argv[2], JSON.stringify(fixtures));
