// Stage 26 verification fixtures: a 20mm cube written as OBJ/PLY/3MF/AMF (the minimal valid files three's loaders accept).
//  STL reuses the existing cube20.stl. The 3MF zip is assembled with fflate from the three bundle.
import { writeFileSync, mkdirSync } from 'node:fs'
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'

const SIZE = 20
// z-up cube: 8 vertices (0..SIZE) + 12 triangles (outward). Same topology as boxTris.
const VERTICES = [[0,0,0],[SIZE,0,0],[SIZE,SIZE,0],[0,SIZE,0],[0,0,SIZE],[SIZE,0,SIZE],[SIZE,SIZE,SIZE],[0,SIZE,SIZE]]
const quad = (first,second,third,fourth) => [[first,second,third],[first,third,fourth]]
const FACES = [...quad(0,1,2,3), ...quad(4,5,6,7), ...quad(0,1,5,4), ...quad(1,2,6,5), ...quad(2,3,7,6), ...quad(3,0,4,7)]  // 12 tris, 0-indexed

mkdirSync('fixtures', { recursive: true })

// OBJ (text, z-up). f is 1-indexed.
let obj = '# cube20 z-up\n'
for (const vertex of VERTICES) obj += `v ${vertex[0]} ${vertex[1]} ${vertex[2]}\n`
for (const face of FACES) obj += `f ${face[0]+1} ${face[1]+1} ${face[2]+1}\n`
writeFileSync('testing_files/cube.obj', obj)

// PLY (ascii, z-up).
let ply = 'ply\nformat ascii 1.0\n'
ply += `element vertex ${VERTICES.length}\nproperty float x\nproperty float y\nproperty float z\n`
ply += `element face ${FACES.length}\nproperty list uchar int vertex_index\nend_header\n`
for (const vertex of VERTICES) ply += `${vertex[0]} ${vertex[1]} ${vertex[2]}\n`
for (const face of FACES) ply += `3 ${face[0]} ${face[1]} ${face[2]}\n`
writeFileSync('testing_files/cube.ply', ply)

// AMF (XML, millimeter, z-up). A single object/volume.
let amf = `<?xml version="1.0" encoding="UTF-8"?>\n<amf unit="millimeter" version="1.1">\n <object id="0">\n  <mesh>\n   <vertices>\n`
for (const vertex of VERTICES) amf += `    <vertex><coordinates><x>${vertex[0]}</x><y>${vertex[1]}</y><z>${vertex[2]}</z></coordinates></vertex>\n`
amf += `   </vertices>\n   <volume>\n`
for (const face of FACES) amf += `    <triangle><v1>${face[0]}</v1><v2>${face[1]}</v2><v3>${face[2]}</v3></triangle>\n`
amf += `   </volume>\n  </mesh>\n </object>\n</amf>\n`
writeFileSync('testing_files/cube.amf', amf)

// 3MF (zip: [Content_Types].xml + _rels/.rels + 3D/3dmodel.model). millimeter, z-up.
let vertexXml = ''
for (const vertex of VERTICES) vertexXml += `<vertex x="${vertex[0]}" y="${vertex[1]}" z="${vertex[2]}"/>`
let triangleXml = ''
for (const face of FACES) triangleXml += `<triangle v1="${face[0]}" v2="${face[1]}" v3="${face[2]}"/>`
const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model"><mesh><vertices>${vertexXml}</vertices><triangles>${triangleXml}</triangles></mesh></object>
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
