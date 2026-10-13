// 22-fix reproduction: replicate buildLayerRibbon vertex math in node and scan
// generated geometry for NaN / huge coordinates (the "giant diagonal polygon" bug).
import createSlicer from '../../engine/src/slicer_core.js'
function boxTris(originX,originY,originZ,sizeX,sizeY,sizeZ){
  const corners=[[0,0,0],[sizeX,0,0],[sizeX,sizeY,0],[0,sizeY,0],[0,0,sizeZ],[sizeX,0,sizeZ],[sizeX,sizeY,sizeZ],[0,sizeY,sizeZ]].map(vertex=>[vertex[0]+originX,vertex[1]+originY,vertex[2]+originZ])
  const quad=(first,second,third,fourth)=>[[corners[first],corners[second],corners[third]],[corners[first],corners[third],corners[fourth]]]
  return[...quad(0,1,2,3),...quad(4,5,6,7),...quad(0,1,5,4),...quad(1,2,6,5),...quad(2,3,7,6),...quad(3,0,4,7)]
}
// thin cross (arms ~0.9mm wide → gapfill/thinwall)
function crossTris(){
  const tris=[]
  const arm=0.9,length=16,height=6
  tris.push(...boxTris(-length/2,-arm/2,0,length,arm,height))
  tris.push(...boxTris(-arm/2,-length/2,0,arm,length,height))
  return tris
}
function cylTris(centerX,centerY,radius,height,facetCount){
  const tris=[]
  const top=[],bottom=[]
  for(let i=0;i<facetCount;i++){
    const angle=2*Math.PI*i/facetCount
    top.push([centerX+radius*Math.cos(angle),centerY+radius*Math.sin(angle),height])
    bottom.push([centerX+radius*Math.cos(angle),centerY+radius*Math.sin(angle),0])
  }
  for(let i=0;i<facetCount;i++){
    const j=(i+1)%facetCount
    tris.push([bottom[i],bottom[j],top[j]],[bottom[i],top[j],top[i]])
    tris.push([[centerX,centerY,height],top[i],top[j]])
    tris.push([[centerX,centerY,0],bottom[j],bottom[i]])
  }
  return tris
}
function trisToSTL(tris){
  const buffer=Buffer.alloc(84+tris.length*50)
  buffer.writeUInt32LE(tris.length,80)
  let offset=84
  for(const triangle of tris){
    offset+=12
    for(const point of triangle){
      buffer.writeFloatLE(point[0],offset)
      buffer.writeFloatLE(point[1],offset+4)
      buffer.writeFloatLE(point[2],offset+8)
      offset+=12
    }
    buffer.writeUInt16LE(0,offset)
    offset+=2
  }
  return buffer
}

const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:2,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:3,bottom_shell_layers:3,skirt_loops:0,skirt_distance:2,brim_width:0,retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45}
const slicer=await createSlicer()
const slice=(stl,sliceParams)=>slicer.slice(new Uint8Array(stl),JSON.stringify(sliceParams),()=>{})
const TYPE={0:'travel',1:'wall',2:'sparse',3:'solid',4:'skirt',5:'support',6:'raft',7:'gapfill',8:'thinwall',9:'bridge',10:'ironing',11:'primetower'}

// exact replica of Viewport.jsx buildLayerRibbon vertex generation (current, pre-fix)
function scanLayer(paths, lineWidth, layerH, widths, bound){
  const height=Math.max(0.05,layerH)
  const zEps=height*0.05
  const bad=[]   // mirrors Viewport.jsx buildLayerRibbon (post 22-fix)
  const check=(coordinates,segment)=>{
    for(const value of coordinates){
      if(!Number.isFinite(value)||Math.abs(value)>bound){
        bad.push(segment)
        return true
      }
    }
    return false
  }
  for(let i=0;i<paths.length;i+=8){
    const type=paths[i+3]
    if(type===0)continue
    const x0=paths[i],y0=paths[i+1],z0=paths[i+2],x1=paths[i+4],y1=paths[i+5]
    let dx=x1-x0,dy=y1-y0
    const length=Math.hypot(dx,dy)
    if(!(length>1e-6))continue   // 22-fix(H1) guard (NaN-safe)
    dx/=length
    dy/=length
    let segmentWidth=lineWidth
    if(widths&&widths[i/8]>0) segmentWidth=widths[i/8]
    if(!Number.isFinite(segmentWidth)||segmentWidth<=0) segmentWidth=lineWidth                                   // 22-fix(H1) width guard
    const halfWidth=Math.min(Math.max(0.05,segmentWidth)/2, 2.5)                                    // 22-fix(H1) half-width clamp
    const normalX=-dy*halfWidth,normalY=dx*halfWidth,extendX=dx*halfWidth,extendY=dy*halfWidth
    const zTop=z0,zBottom=z0-height-zEps
    const verts=[x0+normalX-extendX,y0+normalY-extendY,zTop, x0-normalX-extendX,y0-normalY-extendY,zTop, x1+normalX+extendX,y1+normalY+extendY,zTop, x1-normalX+extendX,y1-normalY+extendY,zTop, zBottom]
    const segment={type:TYPE[type]||type,len:+length.toFixed(4),w:+(segmentWidth||0).toFixed(3),x0:+x0.toFixed(2),y0:+y0.toFixed(2),x1:+x1.toFixed(2),y1:+y1.toFixed(2)}
    check(verts,segment)
  }
  return bad
}
function run(name, stl, sliceParams, bboxHalf){
  const result=slice(stl,sliceParams)
  const bound=bboxHalf*3+50   // "sane" bound: 3x half-extent + margin
  let total=0, allbad=[]
  for(let layerIndex=0;layerIndex<result.layers.length;layerIndex++){
    const layer=result.layers[layerIndex]
    const bad=scanLayer(layer.paths,sliceParams.line_width,sliceParams.layer_height||0.2,layer.widths,bound)
    total+=layer.paths.length/8
    for(const badSegment of bad){
      badSegment.layer=layerIndex
      allbad.push(badSegment)
    }
  }
  // width stats
  let maxWidth=0
  for(const layer of result.layers){
    const widths=layer.widths
    if(widths)for(let k=0;k<widths.length;k++)if(widths[k]>maxWidth)maxWidth=widths[k]
  }
  console.log(`\n[${name}] layers=${result.layers.length} segs=${total} maxWidth=${maxWidth.toFixed(3)} bound=${bound}`)
  console.log(`  bad verts (NaN or |coord|>${bound}): ${allbad.length}`)
  const byType={}
  for(const badSegment of allbad)byType[badSegment.type]=(byType[badSegment.type]||0)+1
  if(allbad.length){
    console.log('  byType:', JSON.stringify(byType))
    console.log('  samples:')
    for(const badSegment of allbad.slice(0,8)) console.log('   ',JSON.stringify(badSegment))
  }
  return allbad.length
}

let bad=0
bad+=run('cube20', trisToSTL(boxTris(0,0,0,20,20,20)), base, 10)
bad+=run('thin-cross', trisToSTL(crossTris()), base, 8)
bad+=run('cyl-r30', trisToSTL(cylTris(0,0,30,10,128)), base, 30)
bad+=run('cube-scarf', trisToSTL(boxTris(0,0,0,20,20,20)), {...base,seam_slope_type:'external',scarf_length:10}, 10)
bad+=run('cyl-spiral', trisToSTL(cylTris(0,0,15,20,96)), {...base,spiral_mode:true,wall_loops:1,top_shell_layers:0,bottom_shell_layers:0,infill_density:0}, 15)
bad+=run('thin-cross-arachne', trisToSTL(crossTris()), {...base,wall_generator:'arachne'}, 8)
console.log(`\n=== TOTAL BAD VERTS: ${bad} ===`)
