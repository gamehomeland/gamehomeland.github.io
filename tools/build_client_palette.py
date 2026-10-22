"""Build color and attachment data from a locally extracted client."""
from __future__ import annotations

import argparse
from collections import defaultdict
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import struct

import numpy as np
from PIL import Image

POLICY = "material-neutral-display-v3"
MAX_RECIPE_LAYERS = 6


def encoded(value):
    return (json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+"\n").encode("utf-8")


class Inputs:
    def __init__(self,root):
        self.root=Path(root).resolve()
        self.files={}

    def read(self,relative):
        relative=str(relative).replace("\\","/").lstrip("/")
        path=(self.root/relative).resolve()
        if not path.is_relative_to(self.root): raise ValueError("resource path escapes client assets")
        body=path.read_bytes()
        self.files[relative]={"sha256":hashlib.sha256(body).hexdigest(),"bytes":len(body)}
        return body

    def table(self,relative):
        return list(csv.DictReader(io.StringIO(self.read(relative).decode("gb18030")),delimiter="\t"))

    def document(self,relative):
        return json.loads(self.read(relative).decode("gb18030"))


def icon_sample(body):
    with Image.open(io.BytesIO(body)) as original:
        rgba=np.asarray(original.convert("RGBA"))
    h,w=rgba.shape[:2]
    if min(h,w)<16: raise ValueError("client icon too small")
    center=rgba[h//4:3*h//4,w//4:3*w//4]
    pixels=center[center[:,:,3]>=250,:3]
    if len(pixels)<center.shape[0]*center.shape[1]*.8:
        raise ValueError("client icon has insufficient opaque central surface")
    unique,counts=np.unique(pixels,axis=0,return_counts=True)
    best=int(np.argmax(counts))
    if counts[best]<len(pixels)*.15: raise ValueError("icon surface is not sufficiently uniform")
    return {"rgb":unique[best].tolist(),"sampled_pixels":len(pixels),
            "dominant_pixels":int(counts[best]),"size":[w,h]}


def decode_uniform_texture(body):
    if body[:2]==b"Hx":
        import texture2ddecoder
        width,height=struct.unpack_from(">HH",body,12)
        kind=body[18]
        if body[17]!=1 or kind not in (0,2): raise ValueError("unsupported CRN texture")
        blocks=texture2ddecoder.unpack_crunch(body)
        expected=((width+3)//4)*((height+3)//4)*(8 if kind==0 else 16)
        if len(blocks)!=expected: raise ValueError("invalid CRN payload")
        decoder=texture2ddecoder.decode_bc1 if kind==0 else texture2ddecoder.decode_bc3
        image=Image.frombytes("RGBA",(width,height),decoder(blocks,width,height),"raw","BGRA")
    else:
        image=Image.open(io.BytesIO(body)).convert("RGBA")
    values=np.unique(np.asarray(image).reshape(-1,4),axis=0)
    image.close()
    if len(values)!=1: raise ValueError("nonuniform texture needs a separate sampling rule")
    return values[0].astype(float)/255


def mesh_size(body):
    if body[0x54:0x58]!=b"HSEM" or struct.unpack_from("<I",body,0x58)[0]!=len(body):
        raise ValueError("unsupported mesh header")
    flags,count,offset=(struct.unpack_from("<I",body,p)[0] for p in (0x5c,0x90,0x9c))
    if flags!=2 or not 4<=count<=100000 or offset+count*12>len(body):
        raise ValueError("unsupported static mesh vertex stream")
    positions=np.frombuffer(body,dtype="<f4",offset=offset,count=count*3).reshape(-1,3)
    if not np.isfinite(positions).all(): raise ValueError("nonfinite mesh")
    low,high=positions.min(axis=0),positions.max(axis=0)
    return {"size_x_m":float((high[0]-low[0])/100),"size_z_m":float((high[2]-low[2])/100),
            "surface_y":float(high[1]),"bounds_min":low.tolist(),"bounds_max":high.tolist()}


def material_data(inputs,model):
    material_path=str(Path(model).with_suffix(".jsoninspack")).replace("\\","/")
    data=inputs.document(material_path)
    if len(data["LOD"])!=1: raise ValueError("unexpected material LOD override")
    group=data["LOD"][0]["Group"]
    if len(group)!=1 or len(group[0]["Subset"])!=1: raise ValueError("multiple materials require review")
    subset=group[0]["Subset"][0]
    params={p["Name"]:p["Value"] for p in subset["Param"]}
    definition_path=subset["Info"]["RefPath"].replace("\\","/")
    definition=inputs.document(definition_path)
    shader_path=Path(definition["Info"]["Shader"].replace("\\","/")).with_suffix(".fx5").as_posix()
    shader=inputs.read(shader_path).decode("gb18030")
    gammas={float(value) for value in re.findall(r"=\s*pow\(abs\(\w+\),\s*([\d.]+)f\)",shader)}
    if gammas!={2.2} or "MainNodeParam.Opacity =" not in shader:
        raise ValueError("unsupported client opacity/color transfer")
    gamma=next(iter(gammas))
    texture_path=params["BaseColorMap"].replace("\\","/")
    packed_path=str(Path(texture_path).with_suffix(".dds")).replace("\\","/")
    texel=decode_uniform_texture(inputs.read(packed_path))
    mre_path=Path(params["Map(MRE)"].replace("\\","/")).with_suffix(".dds").as_posix()
    mre=decode_uniform_texture(inputs.read(mre_path))
    normal_path=Path(params["Normal Map"].replace("\\","/")).with_suffix(".dds").as_posix()
    normal=decode_uniform_texture(inputs.read(normal_path))
    blend=int(subset["RenderState"]["BlendMode"])
    if blend not in (0,12): raise ValueError("unsupported blend mode")
    base=texel[:3]**gamma
    colorize=definition_path.lower().endswith("mtl_std_colorize.jsondef")
    if colorize:
        expected={"Brightness":1.,"Saturation":1.,"BaseColor_ContrastAdjust":0.,
                  "Area1_RContrastEnhance":0.,"Area2_RContrastEnhance":0.,"fresnelStrength":0.}
        if any(float(params.get(k,v))!=v for k,v in expected.items()):
            raise ValueError("nondefault color correction requires a new evaluation rule")
        for name in ("Emissive Color","HighlightColor"):
            if any(float(x)!=0 for x in params.get(name,[0,0,0])[:3]):
                raise ValueError("emissive cloth is outside this palette")
        color=np.asarray(params["BaseColor_colorizeColor"],dtype=float)
        if color.shape!=(4,) or not np.isfinite(color).all() or np.any(color<0):
            raise ValueError("invalid material color")
        # The client shader multiplies the white texture by the material tint,
        # then uses MRE.a as the colorize mask. All evaluated corrections are neutral.
        albedo=base*(1-mre[3])+base*color[:3]*color[3]*mre[3]
    elif definition_path.lower().endswith("mtl_std.jsondef"):
        if float(params.get("fresnelStrength",0))!=0: raise ValueError("nonzero Fresnel emission")
        albedo=base
    else:
        raise ValueError("unsupported material definition")
    if not np.isfinite(albedo).all() or np.any(albedo>1): raise ValueError("HDR albedo needs review")
    return {"material_path":material_path,"definition_path":definition_path,"shader_path":shader_path,
            "texture_path":packed_path,"texture_rgba":np.rint(texel*255).astype(int).tolist(),
            "normal_rgb":np.rint(normal[:3]*255).astype(int).tolist(),
            "albedo_linear":albedo.tolist(),"texture_alpha":float(texel[3]),
            "shader_opacity":float(texel[3]**gamma),"display_gamma":gamma,
            "blend_mode":blend,"two_side":bool(subset["RenderState"]["TwoSide"])}


def display_transform(inputs):
    function_path="data/material/Shader_DX11_HD/CommonParam.h"
    entry_path="data/material/Shader_DX11_HD/ModelBasePixelShader.fx5"
    # HLSL tokens are ASCII; byte-preserving decoding keeps mixed-encoding comments intact.
    common=inputs.read(function_path).decode("latin1")
    entry=inputs.read(entry_path).decode("latin1")
    body=re.search(r"float4\s+Tonemap\s*\([^)]*\)\s*\{(.*?)\n\}",common,re.S)
    if not body:raise ValueError("display transform not found")
    compact=re.sub(r"\s+","",body.group(1))
    expected=("exp2(i_Exposure)*i_ColorSrc","max(0,outColor-0.004f)",
              "(outColor*(6.2f*outColor+0.5f))/(outColor*(6.2f*outColor+1.7)+0.06f)")
    if any(value not in compact for value in expected):raise ValueError("display transform changed; review required")
    call=re.search(r"OutColor\s*=\s*Tonemap\(OutColor,\s*([0-9.]+)f?\)",entry)
    if not call or "bEnableForwardMinimal" not in entry:raise ValueError("display transform call path changed")
    return {"model":"neutral-material-display","exposure":float(call.group(1)),
            "illumination":"unit neutral white","source_function":function_path,
            "source_call":entry_path,"source_branch":"RenderLevelLow and ForwardMinimal",
            "scope":"reference preview; not a complete scene or all graphics modes"}


def display_rgb(linear,transform):
    # The selected game display function already returns display-space values.
    # Do not apply a second gamma curve or a per-image brightness filter.
    x=np.maximum(0,np.asarray(linear,dtype=float)*2**transform["exposure"]-.004)
    return np.rint(np.clip(x*(6.2*x+.5)/(x*(6.2*x+1.7)+.06),0,1)*255).astype(int).tolist()


def derive_attachment(inputs,model,shape):
    path=model+'.jsonAP'
    data=inputs.document(path)
    if data.get('anchorpoint') or data.get('group'):
        raise ValueError('additional anchor types require index-order review')
    candidates=[(i,p) for i,p in enumerate(data['planes']) if 'H_Furniture' in p['tag']
                and p['normal']==[0,1,0] and p['center'][1]>0]
    if len(candidates)!=1:raise ValueError('cloth top plane is ambiguous')
    index,plane=candidates[0]
    if (plane['translation']!={'x':0.,'y':0.,'z':0.}
        or plane['rotation']!={'x':0.,'y':0.,'z':0.,'w':1.}
        or plane['scaling']!={'x':1.,'y':1.,'z':1.}
        or abs(plane['center'][1]-shape['surface_y'])>.001):
        raise ValueError('cloth attachment transform changed')
    return {'path':path,'index':index,'center':plane['center'],'tags':plane['tag']}


def derive_support(inputs,catalog,models):
    # Choosing this furniture is an export policy, not a file-format requirement.
    row=next(r for r in catalog if r['nFurnitureType']=='1' and r['dwFurnitureID']=='6551')
    model=models[row['nRepresentID']]
    prefab_path=model['model'].replace('\\','/')
    prefab=inputs.document(prefab_path)['prefab']
    elements=prefab['comGroup']['elements']
    meshes=[v for v in elements.values() if isinstance(v,dict) and v.get('comRender',{}).get('actorModel')]
    if len(meshes)!=1:raise ValueError('support prefab mesh layout changed')
    mesh=meshes[0];matrix=mesh['comBasic']['actorLocalMatrix']
    expected=[.5,0,0,0,0,.5,0,0,0,0,.5,0,0,1,0,1]
    if matrix!=expected:raise ValueError('support prefab transform requires a new export rule')
    mesh_path=mesh['comRender']['actorModel'].replace('\\','/')
    mesh_rows=[r for r in models.values() if r['model'].replace('\\','/').lower()==mesh_path.lower()]
    if len(mesh_rows)!=1:raise ValueError('support mesh identity is ambiguous')
    anchor_path=mesh_path+'.jsonAP'
    anchors=inputs.document(anchor_path)
    candidates=[(i,p) for i,p in enumerate(anchors['planes']) if 'H_Furniture' in p['tag']]
    if len(candidates)!=1 or anchors.get('anchorpoint') or anchors.get('group'):
        raise ValueError('support anchor index requires review')
    index,plane=candidates[0]
    if plane['translation']!={'x':0.,'y':0.,'z':0.} or plane['rotation']!={'x':0.,'y':0.,'z':0.,'w':1.}:
        raise ValueError('support anchor transform changed')
    inputs.read(mesh_path)
    return {'schema_version':1,'source':'local-client-prefab-and-anchor',
      'runtime':{'name':row['szName']+'（挂接）','furnitureId':int(row['dwFurnitureID']),
        'representId':int(row['nRepresentID']),'meshRepresentId':int(mesh_rows[0]['id']),
        'meshY':matrix[13],'socketY':plane['center'][1]*matrix[5],
        'socketIndex':index,'meshScale':matrix[0]},
      'evidence':{'prefab_path':prefab_path,'mesh_path':mesh_path,'anchor_path':anchor_path,
        'mesh_matrix':matrix,'anchor_center':plane['center'],'anchor_tags':plane['tag'],
        'represent_tags':model['RepresentTags'],'details':model['details']}}


def build(resources,version):
    inputs=Inputs(resources)
    transform=display_transform(inputs)
    version_text=inputs.read("client/version.cfg").decode("gb18030")
    matched_version=re.search(r"(?m)^Sword3\.version=([^\r\n]+)",version_text)
    if not matched_version or matched_version.group(1).strip()!=version:
        raise ValueError("requested version does not match the extracted client version")
    categories=inputs.table("UI/Scheme/Case/Homeland/Homeland_FurnitureCatg.tab")
    category=next(row for row in categories if row["szName"]=="拼布")
    catalog=inputs.table("UI/Scheme/Case/Homeland/Homeland_FurnitureInfo.tab")
    items=[r for r in catalog if (r["nCatag1Index"],r["nCatag2Index"])==(
        category["nCatag1Index"],category["nCatag2Index"])]
    if len(items)!=144 or len({r["dwFurnitureID"] for r in items})!=144 or len({r["nRepresentID"] for r in items})!=144:
        raise ValueError("client cloth catalog changed; review its completeness and protocol limits")
    models={r["id"]:r for r in inputs.table("Represent/homeland/ID_Model.txt")}
    icons={r["dwID"]:r for r in inputs.table("UI/Scheme/Case/Homeland/FurnitureAddInfo.tab")}
    support=derive_support(inputs,catalog,models)
    groups=defaultdict(list)
    for item in sorted(items,key=lambda r:int(r["dwFurnitureID"])):
        furniture_id,represent_id=int(item["dwFurnitureID"]),int(item["nRepresentID"])
        model=models[str(represent_id)]
        if model["FurnitureID"]!=str(furniture_id) or model["FurnitureType"]!=item["nFurnitureType"]:
            raise ValueError("furniture-model identity mismatch")
        matched=re.fullmatch(r"(.+)·([\d.]+)米",item["szName"])
        if not matched: raise ValueError("unsupported cloth name or size")
        key,size=matched.group(1),float(matched.group(2))
        low,high=map(float,item["szScaleRange"].split(";"))
        model_path=model["model"].replace("\\","/")
        shape=mesh_size(inputs.read(model_path))
        if max(abs(shape[k]-size) for k in ("size_x_m","size_z_m"))>1e-6:
            raise ValueError("name size and actual mesh disagree")
        attachment=derive_attachment(inputs,model_path,shape)
        icon=icons[str(int(item["nFurnitureType"])*100000000+furniture_id)]
        if icon["Frame"]!="0": raise ValueError("icon atlas requires a separate sampling rule")
        icon_path=icon["Path"].replace("\\","/")
        sample=icon_sample(inputs.read(icon_path))
        material=material_data(inputs,model_path)
        groups[key].append({"variant":{"furnitureId":furniture_id,"representId":represent_id,
            "name":item["szName"],"sizeM":size,"minScale":low,"maxScale":high,
            "topSocketIndex":attachment["index"],"topSocketY":attachment["center"][1],
            "surfaceY":shape["surface_y"]},"material":material,"icon":sample,
            "model_path":model_path,"icon_path":icon_path,"mesh":shape,'attachment':attachment})
    colors=[]
    for key,entries in groups.items():
        if len(entries)!=2 or {e["variant"]["sizeM"] for e in entries}!={2.,4.}:
            raise ValueError("client cloth sizes changed; review their geometry compatibility")
        first=entries[0]["material"]
        for entry in entries[1:]:
            for field in ("albedo_linear","shader_opacity","blend_mode","texture_rgba","display_gamma"):
                if entry["material"][field]!=first[field]: raise ValueError("variants have different material color")
        samples=np.asarray([e["icon"]["rgb"] for e in entries],dtype=float)
        if np.ptp(samples,axis=0).max()>8: raise ValueError("variant icon colors require calibration review")
        icon_rgb=np.rint(np.mean(samples,axis=0)).astype(int).tolist()
        rgb=display_rgb(first["albedo_linear"],transform)
        transparent=first["blend_mode"]!=0
        colors.append({"key":key,"family":re.sub(r"\d+$","",key),"rgb":rgb,"iconRgb":icon_rgb,
            "materialRgb":np.rint(np.asarray(first["albedo_linear"])**(1/first["display_gamma"])*255).astype(int).tolist(),
            "linearColor":first["albedo_linear"],"translucent":transparent,
            "alpha":first["shader_opacity"] if transparent else 1.,"textureAlpha":first["texture_alpha"],
            "blendMode":first["blend_mode"],"twoSide":first["two_side"],
            "variants":[e["variant"] for e in entries],"clientEvidence":entries})
    translucent=[c for c in colors if c["translucent"]]
    opaque=[c for c in colors if not c["translucent"]]
    if len(translucent)!=1 or len(opaque)!=71: raise ValueError("palette differs from the validated recipe protocol")
    neutral=[c for c in opaque if np.ptp(c["linearColor"])<1e-6]
    white=max(neutral,key=lambda c:sum(c["linearColor"]))
    black=min(neutral,key=lambda c:sum(c["linearColor"]))
    overlay=translucent[0]
    gamma=overlay["clientEvidence"][0]["material"]["display_gamma"]
    palette={"schema_version":2,"clientVersion":version,"colorReference":POLICY,
             "transparencyReference":"client-shader-opacity","renderVerified":False,
             "displayTransform":transform,"colors":colors}
    palette_bytes=encoded(palette)
    values={}
    for color in opaque:
        linear=np.asarray(color["linearColor"],dtype=float)
        for depth in range(MAX_RECIPE_LAYERS):
            keys=[color["key"]]+[overlay["key"]]*depth
            values[json.dumps(keys,ensure_ascii=False,separators=(",",":"))]=display_rgb(linear,transform)
            linear=linear*(1-overlay["alpha"])+np.asarray(overlay["linearColor"])*overlay["alpha"]
    profiles={"schema_version":1,"profile":POLICY,"client_version":version,
              "palette_sha256":hashlib.sha256(palette_bytes).hexdigest(),"game_render_verified":False,
              "display_gamma":gamma,"overlay_key":overlay["key"],"overlay_opacity":overlay["alpha"],
              "max_recipe_layers":MAX_RECIPE_LAYERS,
              "neutral_keys":{"black":black["key"],"white":white["key"]},
              "orientation_lighting":"shared-neutral-display-no-weather-assumption",
              "display_transform":transform,
              "tables":{direction:{"orientation":direction,"colors":values} for direction in ("wall","ground")}}
    manifest={"schema_version":1,"input_kind":"local-installed-client-assets","client_version":version,
              "builder_policy":POLICY,"furniture_rows":len(items),"colors":len(colors),
              "opaque_colors":len(opaque),"recipes_per_orientation":len(values),
              "game_render_verified":False,"resources":inputs.files,
              "geometry_source":"local-client-anchor-definitions",
              "generated":{"furniture_palette.json":hashlib.sha256(palette_bytes).hexdigest(),
                           "client_color_profiles.json":hashlib.sha256(encoded(profiles)).hexdigest(),
                           "support_geometry.json":hashlib.sha256(encoded(support)).hexdigest()}}
    return palette_bytes,encoded(profiles),encoded(manifest),encoded(support)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--assets",type=Path,required=True)
    parser.add_argument("--client-version",required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--verify",action="store_true")
    args=parser.parse_args()
    payloads=build(args.assets,args.client_version)
    args.output.mkdir(parents=True,exist_ok=True)
    for name,body in zip(("furniture_palette.json","client_color_profiles.json","client_palette_manifest.json","support_geometry.json"),payloads):
        path=args.output/name
        if args.verify:
            if path.read_bytes()!=body: raise SystemExit("generated content differs: "+name)
        else:
            temporary=path.with_name(path.name+".new")
            temporary.write_bytes(body); temporary.replace(path)
    print(json.dumps({"client_version":args.client_version,"outputs":4,"verified":args.verify}))


if __name__=="__main__": main()
