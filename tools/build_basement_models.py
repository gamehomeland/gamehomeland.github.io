"""将本机地下室资源的24种形态与共享贴图打包，并提取真实地板挂面。

输入目录包含已提取的Mesh、jsonAP、jsoninspack、材质定义及纹理。
GLB仅输出到调用方指定目录，源资源不写入工程或发布包。
"""
from pathlib import Path
import argparse
import hashlib
import json
import numpy as np
from export_textured_glb import Sources, GLB, material_mesh, bake_material, add_tangents, orient_indices


def build(resource, prefix, assets, output, max_texture=1024):
    sources=Sources(assets,max_texture);glb=GLB()
    glb.doc['meshes']=[];glb.doc['nodes']=[];glb.doc['scenes']=[{'nodes':list(range(24))}]
    material_cache={};variants=[];material_reports=[]
    for index,letter in enumerate('ABCDEFGHIJKLMNOPQRSTUVWX'):
        base=prefix+'_'+letter+'_hd';raw=sources.read(base+'.mesh')
        report,streams,face_materials=material_mesh(raw)
        ap=sources.document(base+'.mesh.jsonAP');pack=sources.document(base+'.jsoninspack')
        groups=pack['LOD'][0]['Group']
        if len(groups)!=1 or len(groups[0]['Subset'])!=report['headerValue98']:
            raise ValueError('地下室材质组或子集与绑定范围不一致')
        floors=[]
        for i,p in enumerate(ap.get('planes',[])):
            if 'H_Floor' in p.get('tag',[]):
                q=p['rotation']
                if abs(q['x'])+abs(q['y'])+abs(q['z'])>1e-5 or abs(q['w']-1)>1e-5:
                    raise ValueError('地下室地板不是已核对的水平挂面')
                floors.append({'index':i,'position':[v/100 for v in p['center']],
                               'rotation':[-q['x'],-q['y'],-q['z'],q['w']],
                               'sizeM':[p['width']/100,p['height']/100]})
        if len(floors)>1:raise ValueError('地下室包含多个地板挂面，需要指定选择规则')
        positions=np.asarray(streams['position']['values'],np.float32).reshape(-1,3)
        normals=np.asarray(streams['normal']['values'],np.float32).reshape(-1,3)
        uv=np.asarray(streams['uvw']['values'],np.float32).reshape(-1,3)[:,:2]
        indices=orient_indices(positions,normals,np.asarray(streams['indices']['values'],np.uint32).reshape(-1,3))
        used=np.unique(indices);remap=np.full(len(positions),-1,dtype=np.int64);remap[used]=np.arange(len(used))
        position=glb.accessor(positions[used]/100,'VEC3',5126,34962,True)
        normal=glb.accessor(normals[used],'VEC3',5126,34962)
        texcoord=glb.accessor(uv[used],'VEC2',5126,34962)
        primitives=[]
        for slot in sorted(set(face_materials.tolist())):
            subset=groups[0]['Subset'][slot]
            if Path(subset['Info']['RefPath'].replace('\\','/')).stem!='mtl_std':
                raise ValueError('地下室新增着色器需要核对，不能套用静态材质缓存')
            key=json.dumps(subset,sort_keys=True)
            if key not in material_cache:
                material,maps,evidence=bake_material(sources,subset,positions,uv,indices[face_materials==slot])
                for channel,pixels in maps:
                    tex={'index':glb.texture(pixels)}
                    if channel in ['baseColorTexture','metallicRoughnessTexture']:material['pbrMetallicRoughness'][channel]=tex
                    else:material[channel]=tex
                extensions=set(glb.doc.get('extensionsUsed',[]));extensions.update(material.get('extensions',{}))
                if extensions:glb.doc['extensionsUsed']=sorted(extensions)
                material_cache[key]=len(glb.doc['materials']);glb.doc['materials'].append(material);material_reports.append(evidence)
            selected=indices[face_materials==slot]
            primitives.append({'attributes':{'POSITION':position,'NORMAL':normal,'TEXCOORD_0':texcoord},
                               'indices':glb.accessor(remap[selected].reshape(-1),'SCALAR',5125,34963),
                               'material':material_cache[key],'mode':4})
        glb.doc['meshes'].append({'name':letter,'primitives':primitives})
        glb.doc['nodes'].append({'mesh':index,'name':'variant-'+letter,'extras':{'basementVariant':index}})
        add_tangents(glb,index)
        anchors=[{'index':i,'position':[v/100 for v in p['center']],
                  'rotation':[-p['rotation'][k] if k!='w' else p['rotation'][k] for k in ['x','y','z','w']],
                  'sizeM':[p['width']/100,p['height']/100],'tags':p.get('tag',[])}
                 for i,p in enumerate(ap.get('planes',[]))]
        variants.append({'index':index,'letter':letter,'triangles':report['triangleCount'],'planeCount':len(anchors),'anchors':anchors,
                         'meshSha256':report['sha256'],'anchorSha256':hashlib.sha256(sources.read(base+'.mesh.jsonAP')).hexdigest(),
                         'floor':floors[0] if floors else None})
    glb.doc['extras']={'basementBrushId':resource['brushId'],'basementModelPack':1,'unitsPerMeterApplied':100,'materialMode':'client-textured'}
    data=glb.finish();name=f"basement-{resource['brushId']}.glb";Path(output,name).write_bytes(data)
    return {**resource,'file':name,'bytes':len(data),'modelSha256':hashlib.sha256(data).hexdigest(),'variants':variants}, {'materials':material_reports,'sources':sources.files}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--assets',type=Path,required=True);p.add_argument('--reference',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--catalog',type=Path,required=True);p.add_argument('--report',type=Path,required=True)
    a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
    if a.output.resolve().is_relative_to(a.assets.resolve()) or any(v.resolve().is_relative_to(a.assets.resolve()) for v in [a.catalog,a.report]):raise SystemExit('输出不能覆盖原始资源')
    reference=json.loads(a.reference.read_text(encoding='utf8'));resources=[];reports=[]
    for f in reference['furniture']:
        b=next(b for b in reference['brushes'] if int(b['id'])==f['representId'])
        r,report=build({'brushId':f['representId'],'furnitureId':f['furnitureId'],'name':f['name'],'sizeM':int(b['extent'])/100},b['path'],a.assets,a.output)
        resources.append(r);reports.append(report);print(r['name'],r['bytes'],flush=True)
    a.catalog.write_text(json.dumps({'schemaVersion':1,'resources':resources},ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    a.report.write_text(json.dumps(reports,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
