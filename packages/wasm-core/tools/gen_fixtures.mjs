// Stage 26 verification fixtures: a 20mm cube written as OBJ/PLY/3MF/AMF (the minimal valid files three's loaders accept).
//  STL reuses the existing cube20.stl. The 3MF zip is assembled with fflate from the three bundle.
import { writeFileSync, mkdirSync } from 'node:fs'
import { zipSync, strToU8 } from '../viewer/node_modules/three/examples/jsm/libs/fflate.module.js'

const S = 20
// z-up cube: 8 vertices (0..S) + 12 triangles (outward). Same topology as boxTris.
const V = [[0,0,0],[S,0,0],[S,S,0],[0,S,0],[0,0,S],[S,0,S],[S,S,S],[0,S,S]]
const q = (a,b,c,d) => [[a,b,c],[a,c,d]]
const F = [...q(0,1,2,3), ...q(4,5,6,7), ...q(0,1,5,4), ...q(1,2,6,5), ...q(2,3,7,6), ...q(3,0,4,7)]  // 12 tris, 0-indexed

mkdirSync('fixtures', { recursive: true })

// OBJ (text, z-up). f is 1-indexed.
let obj = '# cube20 z-up\n'
for (const v of V) obj += `v ${v[0]} ${v[1]} ${v[2]}\n`
for (const f of F) obj += `f ${f[0]+1} ${f[1]+1} ${f[2]+1}\n`
writeFileSync('testing_files/cube.obj', obj)

// PLY (ascii, z-up).
let ply = 'ply\nformat ascii 1.0\n'
ply += `element vertex ${V.length}\nproperty float x\nproperty float y\nproperty float z\n`
ply += `element face ${F.length}\nproperty list uchar int vertex_index\nend_header\n`
for (const v of V) ply += `${v[0]} ${v[1]} ${v[2]}\n`
for (const f of F) ply += `3 ${f[0]} ${f[1]} ${f[2]}\n`
writeFileSync('testing_files/cube.ply', ply)

// AMF (XML, millimeter, z-up). A single object/volume.
let amf = `<?xml version="1.0" encoding="UTF-8"?>\n<amf unit="millimeter" version="1.1">\n <object id="0">\n  <mesh>\n   <vertices>\n`
for (const v of V) amf += `    <vertex><coordinates><x>${v[0]}</x><y>${v[1]}</y><z>${v[2]}</z></coordinates></vertex>\n`
amf += `   </vertices>\n   <volume>\n`
for (const f of F) amf += `    <triangle><v1>${f[0]}</v1><v2>${f[1]}</v2><v3>${f[2]}</v3></triangle>\n`
amf += `   </volume>\n  </mesh>\n </object>\n</amf>\n`
writeFileSync('testing_files/cube.amf', amf)

// 3MF (zip: [Content_Types].xml + _rels/.rels + 3D/3dmodel.model). millimeter, z-up.
let verts = ''; for (const v of V) verts += `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`
let tris = '';  for (const f of F) tris += `<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"/>`
const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model"><mesh><vertices>${verts}</vertices><triangles>${tris}</triangles></mesh></object>
 </resources>
 <build><item objectid="1"/></build>
</model>`
const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`
const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`
const zip = zipSync({
  '[Content_Types].xml': strToU8(contentTypes),
  '_rels/.rels': strToU8(rels),
  '3D/3dmodel.model': strToU8(model),
})
writeFileSync('testing_files/cube.3mf', Buffer.from(zip))

console.log('wrote testing_files/cube.{obj,ply,amf,3mf} (20mm cube, z-up)')
