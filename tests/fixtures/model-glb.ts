import { encodePng } from '../../packages/core/src/png.js';

/** 完全合成的三角形与2×2纹理，不携带游戏模型。 */
export function modelFixture(edit?: (json: any) => void): ArrayBuffer {
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0]);
  const uv = new Float32Array([0, 0, 1, 0, 0.5, 1]);
  const png = encodePng({ width: 2, height: 2, rgba: new Uint8Array([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]) });
  const binary = new Uint8Array(Math.ceil((positions.byteLength + uv.byteLength + png.byteLength)/4)*4);
  binary.set(new Uint8Array(positions.buffer)); binary.set(new Uint8Array(uv.buffer),36); binary.set(png,60);
  const json = {
    asset: {version:'2.0'}, scene:0, scenes:[{nodes:[0]}], nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},material:0}]}],
    materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}},doubleSided:true}],
    textures:[{source:0}], images:[{bufferView:2,mimeType:'image/png'}],
    buffers:[{byteLength:binary.length}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:24},{buffer:0,byteOffset:60,byteLength:png.length}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-0.5,0,0],max:[0.5,1,0]}, {bufferView:1,componentType:5126,count:3,type:'VEC2'}],
  };
  edit?.(json);
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(encoded.length/4)*4, bytes = new Uint8Array(28+jsonLength+binary.length), view = new DataView(bytes.buffer);
  view.setUint32(0,0x46546c67,true); view.setUint32(4,2,true); view.setUint32(8,bytes.length,true);
  view.setUint32(12,jsonLength,true); view.setUint32(16,0x4e4f534a,true);
  bytes.fill(32,20,20+jsonLength); bytes.set(encoded,20);
  view.setUint32(20+jsonLength,binary.length,true); view.setUint32(24+jsonLength,0x004e4942,true);
  bytes.set(binary,28+jsonLength); return bytes.buffer;
}
