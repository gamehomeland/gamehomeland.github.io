"""把已核对Mesh、jsoninspack和本机贴图转为自包含的材质GLB。"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import struct
import numpy as np
from PIL import Image
from inspect_mesh import inspect_mesh

SHADER_HASHES={
    'mtl_std':'365098864aed97bc75867b45b4d490ebfc0275e763f40397370230e4a19ba542',
    'mtl_std01':'6497f5264145cd035a0f06514b9846edecaa99aaffbc8808f18f11145e48054d',
    'mtl_std_colorize':'10fcaa3c5acd45334a4fcbb2e01e5048856beb6f63aac909d8aace0f3bdea0aa',
    'mtl_std_colorize_2ly':'80f09056394946723cfa7ebf9f74337d864b8d34f061897152072d35c1a361be',
    'mtl_water_01':'0c3f0738edc60f9b6532f02fd0b17a61ab632a81e20330ae3d7d0493be6dea55',
    '标准单层':'28cd34b9202e0839680ea3e41be79e380cd55655383b9f2c55c37b2d211acf46',
}


def linear_to_srgb(value):
    value=np.clip(value,0,1)
    return np.where(value<=0.0031308,value*12.92,1.055*np.power(value,1/2.4)-0.055)


def decode_texture(raw):
    if len(raw)>64*1024*1024:raise ValueError('贴图文件过大')
    if raw[:2]==b'Hx':
        import texture2ddecoder as decoder
        width,height=struct.unpack_from('>HH',raw,12)
        if not 1<=width<=4096 or not 1<=height<=4096 or raw[17]!=1 or raw[18] not in (0,2):
            raise ValueError('尚未支持的CRN尺寸、面数或压缩格式')
        blocks=decoder.unpack_crunch(raw)
        expected=((width+3)//4)*((height+3)//4)*(8 if raw[18]==0 else 16)
        if len(blocks)!=expected:raise ValueError('CRN最高层块长度不符')
        pixels=(decoder.decode_bc1 if raw[18]==0 else decoder.decode_bc3)(blocks,width,height)
        return Image.frombytes('RGBA',(width,height),pixels,'raw','BGRA')
    with Image.open(io.BytesIO(raw)) as image:
        if image.width>4096 or image.height>4096:raise ValueError('贴图尺寸过大')
        return image.convert('RGBA')


class Sources:
    def __init__(self,root,max_texture=1024):
        self.root=Path(root).resolve();self.files={};self.cache={};self.max_texture=max_texture
    def read(self,name):
        path=(self.root/str(name).replace('\\','/')).resolve()
        if not path.is_relative_to(self.root):raise ValueError('材质资源路径越界')
        raw=path.read_bytes()
        if len(raw)>64*1024*1024:raise ValueError('材质资源文件过大')
        self.files[path.relative_to(self.root).as_posix()]={'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)}
        return raw
    def document(self,name):return json.loads(self.read(name).decode('gb18030'))
    def texture(self,name):
        path=Path(str(name).replace('\\','/')).with_suffix('.dds')
        cache_key=str(path).lower()
        if cache_key in self.cache:return self.cache[cache_key]
        selected=path
        # 客户端GetTextureHddFileName / _GetHddInfo_NoUpdateFileState使用连续.hdd1..9。
        for index in range(1,10):
            candidate=path.with_suffix('.hdd'+str(index))
            if not (self.root/candidate).is_file():break
            selected=candidate
        image=decode_texture(self.read(selected));original=image.size
        if max(image.size)>self.max_texture:
            factor=self.max_texture/max(image.size)
            image=image.resize(tuple(max(1,round(v*factor)) for v in image.size),Image.Resampling.LANCZOS)
        self.cache[cache_key]=(image,{'path':selected.as_posix(),'originalSize':original,'outputSize':image.size})
        return self.cache[cache_key]


def material_mesh(raw):
    report,streams=inspect_mesh(raw)
    triangles=report['triangleCount'];count=report['headerValue98'];offset=struct.unpack_from('<I',raw,0xb8)[0]
    if not 1<=count<=128 or offset<276 or offset+triangles*2>len(raw):raise ValueError('材质索引流越界')
    for stream in streams.values():
        if offset<stream['offset']+stream['bytes'] and offset+triangles*2>stream['offset']:raise ValueError('材质流与几何重叠')
    materials=np.frombuffer(raw,dtype='<u2',offset=offset,count=triangles).copy()
    if materials.max()>=count:raise ValueError('三角形引用了不存在的材质子集')
    return report,streams,materials


def sample_to(image,size):
    return np.asarray(image.resize(size,Image.Resampling.BILINEAR),dtype=np.float32)/255


def rough_metal(mre,params,rough=None):
    metal=mre[:,:,0];rough=mre[:,:,1] if rough is None else rough
    lo=(float(params.get('adjRange_low',5))-.001)/256
    hi=(float(params.get('adjRange_high',250))+.001)/256
    mask=np.clip(np.sign(metal-hi)*np.sign(lo-metal),0,1)
    metal=metal*(1-mask)+np.clip(metal*float(params.get('Area1_metalAdjust',1)),0,1)*mask
    outputs=[]
    for area in (1,2):
        v=rough*float(params.get(f'Area{area}_roughAdjust',1))
        contrast=float(params.get(f'Area{area}_RContrastEnhance',0))
        outputs.append(np.clip(v*(1-contrast)+(-3+4.5*v)*contrast,0,1))
    return np.clip(metal,0,1),outputs[0]*mask+outputs[1]*(1-mask)


def uv_height(positions,uv,indices,size):
    """将局部Y按实际三角形投到UV；重叠UV的高度不一致会报告。"""
    width,height=size;result=np.zeros((height,width),np.float32);covered=np.zeros((height,width),bool);conflict=0
    for tri in indices:
        coords=uv[tri,:2]*[width,height];ys=positions[tri,1]
        # 重复UV范围不能无界展开；常规家具色图使用有限图集。
        x0=max(0,math.floor(coords[:,0].min()));x1=min(width,math.ceil(coords[:,0].max()))
        y0=max(0,math.floor(coords[:,1].min()));y1=min(height,math.ceil(coords[:,1].max()))
        if x0>=x1 or y0>=y1:continue
        a,b,c=coords;den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
        if abs(den)<1e-8:continue
        xx,yy=np.meshgrid(np.arange(x0,x1)+.5,np.arange(y0,y1)+.5)
        wa=((b[1]-c[1])*(xx-c[0])+(c[0]-b[0])*(yy-c[1]))/den
        wb=((c[1]-a[1])*(xx-c[0])+(a[0]-c[0])*(yy-c[1]))/den;wc=1-wa-wb
        inside=(wa>=-1e-5)&(wb>=-1e-5)&(wc>=-1e-5)
        y=wa*ys[0]+wb*ys[1]+wc*ys[2];old=result[y0:y1,x0:x1];mask=covered[y0:y1,x0:x1]
        conflict+=int(np.sum(inside&mask&(np.abs(old-y)>1)))
        old[inside]=y[inside];mask[inside]=True
    return result,conflict


def bake_material(sources,subset,positions,uv,indices):
    definition_path=subset['Info']['RefPath'].replace('\\','/')
    definition=sources.document(definition_path)
    shader=Path(definition['Info']['Shader'].replace('\\','/')).with_suffix('.fx5').as_posix()
    shader_raw=sources.read(shader)
    if hashlib.sha256(shader_raw).hexdigest()!=SHADER_HASHES.get(Path(definition_path).stem.lower()):
        raise ValueError('着色器内容已改变，请复核材质映射：'+shader)
    params={v['Name']:v['Value'] for v in definition.get('Param',[])}
    params.update({v['Name']:v['Value'] for v in subset.get('Param',[])})
    state={**definition.get('RenderState',{}),**subset.get('RenderState',{})}
    kind=Path(definition_path).stem.lower();notes=[];textures=[]
    if kind=='mtl_water_01':
        # 游戏水面依赖场景深度/时间/折射；GLB保存颜色与粗糙度的静态近似。
        tint=np.asarray(params.get('浅水色',[.5,.6,.7,.5]),dtype=float)
        return {'pbrMetallicRoughness':{'baseColorFactor':[float(v) for v in tint[:3]]+[float(np.clip(tint[3],.08,.8))],
                    'metallicFactor':0,'roughnessFactor':float(np.clip(params.get('水面光滑度',.1),.04,1))},
                'alphaMode':'BLEND','doubleSided':True},[],{'shader':kind,'approximation':['水面使用静态颜色近似，未复现深度、波动和折射']}
    base_name=params.get('BaseColorMap') or params.get('颜色贴图')
    if not base_name:raise ValueError('材质缺少已支持的颜色贴图：'+kind)
    base_image,info=sources.texture(base_name);textures.append(info);size=base_image.size
    base=np.asarray(base_image,dtype=np.float32)/255
    base_linear=base[:,:,:3]**2.2;alpha=base[:,:,3]**2.2
    if params.get('Map(MRE)'):
        image,info=sources.texture(params['Map(MRE)']);textures.append(info);mre=sample_to(image,size)
    else:mre=np.zeros((*base.shape[:2],4),np.float32);mre[:,:,1]=1
    emissive=np.zeros_like(base_linear)
    def color(name,default=(1,1,1,1)):
        v=np.asarray(params.get(name,default),dtype=np.float32);return v[:3]*v[3]
    def saturation(rgb,value):
        mean=np.mean(rgb,axis=2,keepdims=True);return mean+(rgb-mean)*value
    if kind=='mtl_std_colorize_2ly':
        heightmap=None
        if any(float(params.get(f'渐变开关{i}',0))!=0 for i in (1,2)):
            heightmap,conflicts=uv_height(positions,uv,indices,size)
            if conflicts:notes.append(f'渐变UV重叠高度有{conflicts}个采样冲突，采用图集内最后覆盖值')
        layers=[]
        for i in (1,2):
            tinted=saturation(base_linear*float(params.get(f'明度{i}',1))*color(f'颜色{i}'),float(params.get(f'饱和度{i}',1)))
            if float(params.get(f'渐变开关{i}',0))!=0:
                grad=np.clip(heightmap/max(float(params.get(f'渐变高度{i}',50)),.00001)*float(params[f'渐变开关{i}']),0,1)**float(params.get(f'渐变对比度{i}',1))
                if math.ceil(float(params.get(f'上下反转{i}',0))):grad=1-grad
                tinted=tinted*(1-grad[:,:,None])+base_linear*color(f'渐变颜色{i}')*grad[:,:,None]
            layers.append(tinted)
        albedo=base_linear*(1-mre[:,:,2:3])+layers[0]*mre[:,:,2:3]
        albedo=albedo*(1-mre[:,:,3:4])+layers[1]*mre[:,:,3:4]
        rough=mre[:,:,1]*(1-mre[:,:,2])+np.clip(mre[:,:,1]*float(params.get('光滑度调整1',1)),0,1)*mre[:,:,2]
        rough=rough*(1-mre[:,:,3])+np.clip(mre[:,:,1]*float(params.get('光滑度调整2',1)),0,1)*mre[:,:,3]
        metal,rough=rough_metal(mre,params,rough)
    elif kind=='mtl_std_colorize':
        contrast=float(params.get('BaseColor_ContrastAdjust',0))*.1
        exponent=1+contrast if contrast>=0 else 1/(1-contrast)
        adjusted=np.where(base_linear<.5,(base_linear*2)**exponent*.5,1-((1-base_linear)*2)**exponent*.5)
        adjusted=saturation(adjusted*float(params.get('Brightness',1))*color('BaseColor_colorizeColor'),float(params.get('Saturation',1)))
        albedo=base_linear*(1-mre[:,:,3:4])+adjusted*mre[:,:,3:4]
        metal,rough=rough_metal(mre,params);emissive=mre[:,:,2:3]*color('Emissive Color',(0,0,0,0))
        if float(params.get('fresnelStrength',0)) or np.any(color('HighlightColor',(0,0,0,0))):notes.append('视角相关的边缘发光由网页PBR近似，未逐式复现')
    elif kind in ['mtl_std','mtl_std01']:
        albedo=base_linear.copy();metal,rough=rough_metal(mre,params)
        if kind=='mtl_std01':
            contrast=float(params.get('对比度',0));brightness=float(params.get('亮度',1));sat=float(params.get('饱和度',1))
            if contrast:notes.append('非零对比度修正尚未逐式映射')
            albedo=saturation(albedo*brightness,sat)
            shade=np.ones(base.shape[:2],np.float32)
            if float(params.get('投影深浅',0)):
                image,info=sources.texture(params['自发光贴图A通道']);textures.append(info)
                shade=1-(1-sample_to(image,size)[:,:,3]**2.2)*float(params['投影深浅'])
            emissive=(mre[:,:,2]*shade)[:,:,None]**float(params.get('边缘硬度',1))*color('Emissive Color',(0,0,0,0))
        if np.any(color('HighlightColor',(0,0,0,0))) or float(params.get('fresnelStrength',0)):notes.append('视角相关边缘高光未烘焙进贴图')
    else:
        albedo=base_linear*color('BaseColor')*float(params.get('亮度',1));metal=np.zeros(base.shape[:2]);rough=np.ones(base.shape[:2])
        notes.append('特效单层材质使用静态颜色近似，未复现时间动画和深度效果')
    material={'pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1],'metallicFactor':1,'roughnessFactor':1},
              'doubleSided':bool(state.get('TwoSide',False))}
    blend=int(state.get('BlendMode',0))
    if not state.get('EnableRendering',1):alpha[:]=0;blend=12
    if blend==1:material.update(alphaMode='MASK',alphaCutoff=float(state.get('AlphaRef',128))/255)
    elif blend in (12,2,5,11):
        material['alphaMode']='BLEND'
        if blend!=12:notes.append(f'混合模式{blend}使用普通透明近似')
    elif blend!=0:raise ValueError('尚未核对的混合模式：'+str(blend))
    outputs=[('baseColorTexture',np.dstack((linear_to_srgb(albedo),alpha)))]
    outputs.append(('metallicRoughnessTexture',np.dstack((np.ones_like(rough),rough,metal))))
    if params.get('Normal Map'):
        image,info=sources.texture(params['Normal Map']);textures.append(info);normal=sample_to(image,size)[:,:,:3];xy=normal[:,:,:2]*2-1
        normal[:,:,2]=(np.sqrt(np.clip(1-np.sum(xy*xy,axis=2),0,1))+1)*.5
        outputs.append(('normalTexture',normal))
    if np.max(emissive)>0:
        strength=max(1,float(np.max(emissive)));outputs.append(('emissiveTexture',linear_to_srgb(emissive/strength)))
        material['emissiveFactor']=[1,1,1]
        if strength>1:material.setdefault('extensions',{})['KHR_materials_emissive_strength']={'emissiveStrength':strength}
    return material,outputs,{'shader':kind,'blendMode':blend,'textures':textures,'approximation':notes}


class GLB:
    def __init__(self):
        self.binary=bytearray();self.images={};self.doc={'asset':{'version':'2.0','generator':'Homeland material converter'},'scene':0,'scenes':[{'nodes':[0]}],
            'nodes':[{'mesh':0}], 'meshes':[{'primitives':[]}], 'buffers':[{'byteLength':0}], 'bufferViews':[],'accessors':[],'materials':[],
            'images':[],'textures':[],'samplers':[{'wrapS':10497,'wrapT':10497,'magFilter':9729,'minFilter':9987}]}
    def buffer(self,raw,target=None):
        self.binary.extend(b'\0'*(-len(self.binary)%4));view={'buffer':0,'byteOffset':len(self.binary),'byteLength':len(raw)}
        if target:view['target']=target
        self.binary.extend(raw);self.doc['bufferViews'].append(view);return len(self.doc['bufferViews'])-1
    def accessor(self,array,kind,component,target,bounds=False):
        values=np.asarray(array,dtype='<f4' if component==5126 else '<u4');count=len(values)
        info={'bufferView':self.buffer(values.tobytes(),target),'componentType':component,'count':count,'type':kind}
        if bounds:info.update(min=values.min(axis=0).tolist(),max=values.max(axis=0).tolist())
        self.doc['accessors'].append(info);return len(self.doc['accessors'])-1
    def texture(self,array):
        out=io.BytesIO();Image.fromarray(np.rint(np.clip(array,0,1)*255).astype(np.uint8)).save(out,format='PNG',compress_level=6)
        raw=out.getvalue();sha=hashlib.sha256(raw).hexdigest()
        if sha in self.images:return self.images[sha]
        image=len(self.doc['images']);self.doc['images'].append({'bufferView':self.buffer(raw),'mimeType':'image/png'})
        tex=len(self.doc['textures']);self.doc['textures'].append({'sampler':0,'source':image});self.images[sha]=tex;return tex
    def finish(self):
        self.doc['buffers'][0]['byteLength']=len(self.binary);self.binary.extend(b'\0'*(-len(self.binary)%4))
        header=json.dumps(self.doc,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode();header+=b' '*(-len(header)%4)
        size=28+len(header)+len(self.binary)
        if size>50*1024*1024:raise ValueError('材质GLB超过50MiB，降低输出贴图尺寸')
        return struct.pack('<IIIII',0x46546c67,2,size,len(header),0x4e4f534a)+header+struct.pack('<II',len(self.binary),0x004e4942)+self.binary


def add_tangents(glb, mesh_index=0):
    doc=glb.doc
    def data(index):
        a=doc['accessors'][index];v=doc['bufferViews'][a['bufferView']]
        array=np.frombuffer(glb.binary,dtype='<f4' if a['componentType']==5126 else '<u4',offset=v.get('byteOffset',0)+a.get('byteOffset',0),count=a['count']*{'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]).copy()
        return array.reshape(a['count'],-1)
    primitives=doc['meshes'][mesh_index]['primitives'];attrs=primitives[0]['attributes']
    p=data(attrs['POSITION']).astype(float);n=data(attrs['NORMAL']).astype(float);uv=data(attrs['TEXCOORD_0']).astype(float)
    t=np.zeros_like(p);b=np.zeros_like(p)
    for primitive in primitives:
        for ids in data(primitive['indices']).reshape(-1,3):
            edge1=p[ids[1]]-p[ids[0]];edge2=p[ids[2]]-p[ids[0]];d1=uv[ids[1]]-uv[ids[0]];d2=uv[ids[2]]-uv[ids[0]]
            determinant=d1[0]*d2[1]-d1[1]*d2[0]
            if abs(determinant)<1e-12:continue
            tangent=(edge1*d2[1]-edge2*d1[1])/determinant;bitangent=(edge2*d1[0]-edge1*d2[0])/determinant
            for i in ids:t[i]+=tangent;b[i]+=bitangent
    t-=n*np.sum(t*n,axis=1,keepdims=True);length=np.linalg.norm(t,axis=1)
    for i in np.flatnonzero(length<1e-10):
        axis=np.array([1.,0,0]) if abs(n[i,0])<.9 else np.array([0.,1,0]);t[i]=np.cross(axis,n[i])
    t/=np.linalg.norm(t,axis=1,keepdims=True)
    w=np.where(np.sum(np.cross(n,t)*b,axis=1)<0,-1.,1.)
    accessor=glb.accessor(np.column_stack((t,w)),'VEC4',5126,34962)
    for primitive in primitives:primitive['attributes']['TANGENT']=accessor


def orient_indices(positions,normals,indices):
    """GLTF使用逆时针正面；以资源法线交叉核对已核对Mesh的顺时针索引。"""
    face=np.cross(positions[indices[:,1]]-positions[indices[:,0]],positions[indices[:,2]]-positions[indices[:,0]])
    dot=np.sum(face*normals[indices].mean(axis=1),axis=1)
    positive=float(np.sum(np.maximum(dot,0)));negative=float(np.sum(np.maximum(-dot,0)))
    # 极薄倒角的平滑法线可能与局部面交叉；按面积加权确认整体约定，统一翻转，不逐面重排。
    if min(positive,negative)>max(positive,negative)*.01: raise ValueError('模型正面方向不一致，需要单独核对')
    return indices[:,[0,2,1]].copy() if negative>positive else indices


def convert(mesh_file,pack_path,sources,default_detail=0):
    raw=Path(mesh_file).read_bytes();report,streams,face_materials=material_mesh(raw);pack=sources.document(pack_path)
    groups=pack['LOD'][0]['Group'];slots=report['headerValue98']
    if not groups or len(groups)>32 or any(len(g['Subset'])!=slots for g in groups):raise ValueError('材质组与Mesh子集数量不一致')
    if not 0<=default_detail<len(groups):raise ValueError('默认样式超出材质组')
    positions=np.asarray(streams['position']['values'],np.float32).reshape(-1,3)
    normals=np.asarray(streams['normal']['values'],np.float32).reshape(-1,3)
    uv=np.asarray(streams['uvw']['values'],np.float32).reshape(-1,3)[:,:2]
    indices=orient_indices(positions,normals,np.asarray(streams['indices']['values'],np.uint32).reshape(-1,3));used=np.unique(indices)
    remap=np.full(len(positions),-1,dtype=np.int64);remap[used]=np.arange(len(used))
    glb=GLB();position=glb.accessor(positions[used]/100,'VEC3',5126,34962,True)
    normal=glb.accessor(normals[used]/np.linalg.norm(normals[used],axis=1,keepdims=True),'VEC3',5126,34962)
    texcoord=glb.accessor(uv[used],'VEC2',5126,34962)
    coverage=[];names=[g.get('Name') or '原始样式' for g in groups];extensions=set()
    for slot in sorted(set(face_materials.tolist())):
        selected=indices[face_materials==slot];accessor=glb.accessor(remap[selected].reshape(-1),'SCALAR',5125,34963)
        material_ids=[]
        for detail,group in enumerate(groups):
            material,maps,evidence=bake_material(sources,group['Subset'][slot],positions,uv,selected)
            material['name']=f'{names[detail]} · 部位{slot+1}'
            for channel,pixels in maps:
                tex={'index':glb.texture(pixels)}
                if channel in ['baseColorTexture','metallicRoughnessTexture']:material['pbrMetallicRoughness'][channel]=tex
                else:material[channel]=tex
            extensions.update(material.get('extensions',{}));material_ids.append(len(glb.doc['materials']));glb.doc['materials'].append(material)
            coverage.append({'detail':detail,'slot':slot,**evidence})
        primitive={'attributes':{'POSITION':position,'NORMAL':normal,'TEXCOORD_0':texcoord},'indices':accessor,'material':material_ids[default_detail],'mode':4}
        if len(groups)>1:
            primitive['extensions']={'KHR_materials_variants':{'mappings':[{'material':material,'variants':[i]} for i,material in enumerate(material_ids)]}}
        glb.doc['meshes'][0]['primitives'].append(primitive)
    if len(groups)>1:
        extensions.add('KHR_materials_variants');glb.doc['extensions']={'KHR_materials_variants':{'variants':[{'name':name} for name in names]}}
    if extensions:glb.doc['extensionsUsed']=sorted(extensions)
    glb.doc['extras']={'sourceSha256':report['sha256'],'unitsPerMeterApplied':100,'materialMode':'client-textured','defaultDetail':default_detail,
                       'scope':'client texture, UV and material subset conversion; scene lighting and some special shaders are approximated'}
    add_tangents(glb)
    result=glb.finish()
    return result,{'mesh':report,'styles':names,'defaultDetail':default_detail,'glbBytes':len(result),'glbSha256':hashlib.sha256(result).hexdigest(),'materials':coverage,'sources':dict(sources.files)}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--mesh',required=True);parser.add_argument('--material-pack',required=True)
    parser.add_argument('--assets',required=True);parser.add_argument('--glb',required=True);parser.add_argument('--report',required=True)
    parser.add_argument('--max-texture',type=int,default=1024);parser.add_argument('--detail',type=int,default=0);args=parser.parse_args()
    if not 64<=args.max_texture<=2048:raise SystemExit('预览贴图长边范围64～2048')
    outputs=[Path(args.glb).resolve(),Path(args.report).resolve()]
    source=Path(args.mesh).resolve();root=Path(args.assets).resolve()
    if outputs[0]==outputs[1] or any(p==source or p.is_relative_to(root) for p in outputs):
        raise SystemExit('输出必须与源Mesh和提取资源目录分开')
    result,report=convert(args.mesh,args.material_pack,Sources(args.assets,args.max_texture),args.detail)
    Path(args.glb).write_bytes(result);Path(args.report).write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf8')
    print(json.dumps({'bytes':len(result),'styles':report['styles'],'materials':len(report['materials'])},ensure_ascii=False))
