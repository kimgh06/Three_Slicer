// 22-fix reproduction: replicate buildLayerRibbon vertex math in node and scan
// generated geometry for NaN / huge coordinates (the "giant diagonal polygon" bug).
import createSlicer from '../engine/src/slicer_core.js'
function boxTris(ox,oy,oz,sx,sy,sz){const c=[[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v=>[v[0]+ox,v[1]+oy,v[2]+oz]);const q=(a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]];return[...q(0,1,2,3),...q(4,5,6,7),...q(0,1,5,4),...q(1,2,6,5),...q(2,3,7,6),...q(3,0,4,7)]}
// thin cross (arms ~0.9mm wide → gapfill/thinwall)
function crossTris(){const a=[]; const arm=0.9,L=16,H=6; a.push(...boxTris(-L/2,-arm/2,0,L,arm,H)); a.push(...boxTris(-arm/2,-L/2,0,arm,L,H)); return a}
function cylTris(cx,cy,r,h,n){const t=[];const top=[],bot=[];for(let i=0;i<n;i++){const A=2*Math.PI*i/n;top.push([cx+r*Math.cos(A),cy+r*Math.sin(A),h]);bot.push([cx+r*Math.cos(A),cy+r*Math.sin(A),0])}for(let i=0;i<n;i++){const j=(i+1)%n;t.push([bot[i],bot[j],top[j]],[bot[i],top[j],top[i]]);t.push([[cx,cy,h],top[i],top[j]]);t.push([[cx,cy,0],bot[j],bot[i]])}return t}
function trisToSTL(tris){const buf=Buffer.alloc(84+tris.length*50);buf.writeUInt32LE(tris.length,80);let off=84;for(const t of tris){off+=12;for(const p of t){buf.writeFloatLE(p[0],off);buf.writeFloatLE(p[1],off+4);buf.writeFloatLE(p[2],off+8);off+=12}buf.writeUInt16LE(0,off);off+=2}return buf}

const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:2,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:3,bottom_shell_layers:3,skirt_loops:0,skirt_distance:2,brim_width:0,retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45}
const M=await createSlicer()
const slice=(stl,p)=>M.slice(new Uint8Array(stl),JSON.stringify(p),()=>{})
const TYPE={0:'travel',1:'wall',2:'sparse',3:'solid',4:'skirt',5:'support',6:'raft',7:'gapfill',8:'thinwall',9:'bridge',10:'ironing',11:'primetower'}

// exact replica of Viewport.jsx buildLayerRibbon vertex generation (current, pre-fix)
function scanLayer(paths, lineWidth, layerH, widths, bound){
  const h=Math.max(0.05,layerH); const zEps=h*0.05; const bad=[]   // mirrors Viewport.jsx buildLayerRibbon (post 22-fix)
  const chk=(p,seg)=>{for(const v of p){ if(!Number.isFinite(v)||Math.abs(v)>bound){ bad.push(seg); return true } } return false}
  for(let i=0;i<paths.length;i+=8){
    const type=paths[i+3]; if(type===0)continue
    const x0=paths[i],y0=paths[i+1],z0=paths[i+2],x1=paths[i+4],y1=paths[i+5]
    let dx=x1-x0,dy=y1-y0; const len=Math.hypot(dx,dy); if(!(len>1e-6))continue   // 22-fix(H1) guard (NaN-safe)
    dx/=len; dy/=len
    let sw=(widths&&widths[i/8]>0)?widths[i/8]:lineWidth
    if(!Number.isFinite(sw)||sw<=0) sw=lineWidth                                   // 22-fix(H1) width guard
    const hw=Math.min(Math.max(0.05,sw)/2, 2.5)                                    // 22-fix(H1) half-width clamp
    const nx=-dy*hw,ny=dx*hw,ex=dx*hw,ey=dy*hw
    const zt=z0,zb=z0-h-zEps
    const verts=[x0+nx-ex,y0+ny-ey,zt, x0-nx-ex,y0-ny-ey,zt, x1+nx+ex,y1+ny+ey,zt, x1-nx+ex,y1-ny+ey,zt, zb]
    const seg={type:TYPE[type]||type,len:+len.toFixed(4),w:+(sw||0).toFixed(3),x0:+x0.toFixed(2),y0:+y0.toFixed(2),x1:+x1.toFixed(2),y1:+y1.toFixed(2)}
    chk(verts,seg)
  }
  return bad
}
function run(name, stl, p, bboxHalf){
  const r=slice(stl,p); const bound=bboxHalf*3+50   // "sane" bound: 3x half-extent + margin
  let total=0, allbad=[]
  for(let li=0;li<r.layers.length;li++){ const L=r.layers[li]; const bad=scanLayer(L.paths,p.line_width,p.layer_height||0.2,L.widths,bound)
    total+=L.paths.length/8; for(const b of bad){b.layer=li; allbad.push(b)} }
  // width stats
  let maxw=0; for(const L of r.layers){const w=L.widths; if(w)for(let k=0;k<w.length;k++)if(w[k]>maxw)maxw=w[k]}
  console.log(`\n[${name}] layers=${r.layers.length} segs=${total} maxWidth=${maxw.toFixed(3)} bound=${bound}`)
  console.log(`  bad verts (NaN or |coord|>${bound}): ${allbad.length}`)
  const byType={}; for(const b of allbad)byType[b.type]=(byType[b.type]||0)+1
  if(allbad.length){ console.log('  byType:', JSON.stringify(byType)); console.log('  samples:'); for(const b of allbad.slice(0,8)) console.log('   ',JSON.stringify(b)) }
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
