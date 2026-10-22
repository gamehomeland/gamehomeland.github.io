from pathlib import Path
import hashlib
import io
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import export_textured_glb as material
from mesh_tools_test import fixture

class MaterialTests(unittest.TestCase):
    def test_subset_indices_are_checked(self):
        raw=fixture();struct.pack_into('<I',raw,0xb8,len(raw));raw.extend(struct.pack('<HI',0,0xffffffff));struct.pack_into('<I',raw,0x58,len(raw))
        report,streams,slots=material.material_mesh(raw)
        self.assertEqual(slots.tolist(),[0]);self.assertEqual(report['triangleCount'],1)
        struct.pack_into('<H',raw,len(raw)-6,1)
        with self.assertRaisesRegex(ValueError,'不存在'):material.material_mesh(raw)
        struct.pack_into('<I',raw,0xb8,276)
        with self.assertRaisesRegex(ValueError,'重叠'):material.material_mesh(raw)

    def test_high_resolution_chain_stops_at_gap_and_rejects_escape(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for suffix,size in [('dds',8),('hdd1',16),('hdd3',32)]:Image.new('RGBA',(size,size),(20,80,150,255)).save(root/('map.'+suffix),format='PNG')
            sources=material.Sources(root,64);image,info=sources.texture('map.tga')
            self.assertEqual(image.size,(16,16));self.assertEqual(info['path'],'map.hdd1')
            with self.assertRaisesRegex(ValueError,'越界'):sources.read('../outside.dds')

    def test_gamma_linear_channels_and_shader_gate(self):
        class Sources:
            def document(self,_):return {'Info':{'Shader':'mtl_std.fx'},'Param':[{'Name':'BaseColorMap','Value':'base'},{'Name':'Map(MRE)','Value':'mre'},{'Name':'Normal Map','Value':'normal'}]}
            def read(self,_):return b'synthetic shader'
            def texture(self,name):
                values={'base':(128,64,32,128),'mre':(64,128,0,255),'normal':(128,128,0,255)}
                return Image.new('RGBA',(2,2),values[name]),{'path':name}
        subset={'Info':{'RefPath':'mtl_std.jsondef'},'RenderState':{'BlendMode':1,'AlphaRef':128}}
        sources=Sources();empty=np.empty((0,3))
        with self.assertRaisesRegex(ValueError,'着色器内容已改变'):material.bake_material(sources,subset,empty,empty,empty)
        with patch.dict(material.SHADER_HASHES,{'mtl_std':hashlib.sha256(b'synthetic shader').hexdigest()}):
            result,maps,_=material.bake_material(sources,subset,empty,empty,empty)
        maps=dict(maps);self.assertEqual(result['alphaMode'],'MASK')
        self.assertAlmostEqual(float(maps['baseColorTexture'][0,0,3]),(128/255)**2.2,places=6)
        self.assertAlmostEqual(float(maps['metallicRoughnessTexture'][0,0,1]),128/255,places=6)
        self.assertAlmostEqual(float(maps['metallicRoughnessTexture'][0,0,2]),64/255,places=6)
        self.assertGreater(maps['normalTexture'][0,0,2],.99)
        self.assertAlmostEqual(float(material.linear_to_srgb(np.array([0.0031308]))[0]),.0404499,places=6)

    def test_tangents_are_unit_and_orthogonal_even_with_degenerate_uv(self):
        for uv in [[[0,0],[1,0],[0,1]],[[0,0]]*3]:
            glb=material.GLB();p=glb.accessor([[0,0,0],[1,0,0],[0,1,0]],'VEC3',5126,34962,True)
            n=glb.accessor([[0,0,1]]*3,'VEC3',5126,34962);t=glb.accessor(uv,'VEC2',5126,34962);i=glb.accessor([0,1,2],'SCALAR',5125,34963)
            glb.doc['meshes'][0]['primitives'].append({'attributes':{'POSITION':p,'NORMAL':n,'TEXCOORD_0':t},'indices':i})
            material.add_tangents(glb);a=glb.doc['accessors'][-1];view=glb.doc['bufferViews'][a['bufferView']]
            values=np.frombuffer(glb.binary,dtype='<f4',offset=view['byteOffset'],count=12).reshape(-1,4)
            self.assertTrue(np.isfinite(values).all());np.testing.assert_allclose(np.linalg.norm(values[:,:3],axis=1),1,atol=1e-6)
            np.testing.assert_allclose(values[:,2],0,atol=1e-6);self.assertTrue(np.isin(values[:,3],[-1,1]).all())

if __name__=='__main__':unittest.main()
