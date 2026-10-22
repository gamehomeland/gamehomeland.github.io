"""Extract only the installed client's cloth palette inputs, into a new offline folder."""
from pathlib import Path
import argparse,csv,hashlib,io,json,os,subprocess

TABLES=("UI/Scheme/Case/Homeland/Homeland_FurnitureCatg.tab",
        "UI/Scheme/Case/Homeland/Homeland_FurnitureInfo.tab",
        "UI/Scheme/Case/Homeland/FurnitureAddInfo.tab",
        "Represent/homeland/ID_Model.txt")
SOURCE_FILES=("Pakv4/Trunk.dir","Pakv4/Package.cfg","Pakv4/versionmap.cfg",
              "bin/zhcn_hd/version.cfg","bin/zhcn_hd/bin64/Engine_Lua5X64.dll",
              "bin/zhcn_hd/bin64/KGPK4_FileSystemX64.dll")

def fingerprint(game):
    records={}
    for name in SOURCE_FILES:
        path=game/name
        records[name]={"sha256":hashlib.file_digest(path.open('rb'),'sha256').hexdigest(),
                       "bytes":path.stat().st_size,"mtime_ns":path.stat().st_mtime_ns}
    return records

def extract(game,reader,output):
    if os.name!='nt':raise ValueError('installed client extraction requires Windows')
    game,reader,output=(Path(v).resolve() for v in (game,reader,output))
    if output.is_relative_to(game):raise ValueError('output must be outside the game directory')
    output.mkdir(parents=True,exist_ok=False)
    assets=output/'assets';assets.mkdir()
    before=fingerprint(game)
    (output/'client-before.json').write_bytes((json.dumps(before,indent=2)+'\n').encode())
    stage=0
    def read(paths):
        nonlocal stage
        stage+=1
        names=sorted({str(p).replace('\\','/') for p in paths})
        listing=output/f'paths-{stage}.txt'
        listing.write_bytes(('\n'.join(names)+'\n').encode('gbk'))
        result=subprocess.run([str(reader),str(game/'bin/zhcn_hd/bin64'),str(game/'Pakv4'),
                               str(listing),str(assets)],capture_output=True)
        (output/f'extract-{stage}.log').write_bytes(result.stdout+result.stderr)
        result.check_returncode()
        missing=[name for name in names if not (assets/name).is_file()]
        if missing:raise ValueError('client resources missing: '+repr(missing))
    def table(name):
        return list(csv.DictReader(io.StringIO((assets/name).read_bytes().decode('gb18030')),delimiter='\t'))
    def document(name):return json.loads((assets/name).read_bytes().decode('gb18030'))
    read(TABLES)
    category=next(r for r in table(TABLES[0]) if r['szName']=='拼布')
    items=[r for r in table(TABLES[1]) if (r['nCatag1Index'],r['nCatag2Index'])==
           (category['nCatag1Index'],category['nCatag2Index'])]
    models={r['id']:r for r in table(TABLES[3])}
    icons={r['dwID']:r for r in table(TABLES[2])}
    paths=[];materials=[]
    for item in items:
        model=models[item['nRepresentID']]
        if model['FurnitureID']!=item['dwFurnitureID'] or model['FurnitureType']!=item['nFurnitureType']:
            raise ValueError('furniture-model identity mismatch')
        path=model['model'].replace('\\','/')
        material=Path(path).with_suffix('.jsoninspack').as_posix()
        materials.append(material)
        icon=icons[str(int(item['nFurnitureType'])*100000000+int(item['dwFurnitureID']))]
        if icon['Frame']!='0':raise ValueError('icon atlas needs review')
        paths.extend((path,path+'.jsonAP',material,icon['Path'].replace('\\','/')))
    support=next(r for r in table(TABLES[1]) if r['nFurnitureType']=='1' and r['dwFurnitureID']=='6551')
    support_path=models[support['nRepresentID']]['model'].replace('\\','/')
    paths.append(support_path)
    read(paths)
    prefab=document(support_path)['prefab']['comGroup']['elements']
    support_meshes=[v['comRender']['actorModel'].replace('\\','/') for v in prefab.values()
                    if isinstance(v,dict) and v.get('comRender',{}).get('actorModel')]
    read(p for mesh in support_meshes for p in (mesh,mesh+'.jsonAP'))
    definitions=set();textures=set()
    for name in materials:
        material=document(name)
        for lod in material['LOD']:
            for group in lod['Group']:
                for subset in group['Subset']:
                    definitions.add(subset['Info']['RefPath'].replace('\\','/'))
                    params={p['Name']:p['Value'] for p in subset['Param']}
                    for key in ('BaseColorMap','Map(MRE)','Normal Map'):
                        textures.add(Path(params[key].replace('\\','/')).with_suffix('.dds').as_posix())
    read(definitions|textures)
    read(Path(document(name)['Info']['Shader'].replace('\\','/')).with_suffix('.fx5').as_posix() for name in definitions)
    read(("data/material/Shader_DX11_HD/CommonParam.h", "data/material/Shader_DX11_HD/ModelBasePixelShader.fx5"))
    (assets/'client').mkdir()
    (assets/'client/version.cfg').write_bytes((game/'bin/zhcn_hd/version.cfg').read_bytes())
    after=fingerprint(game)
    (output/'client-after.json').write_bytes((json.dumps(after,indent=2)+'\n').encode())
    if before!=after:raise ValueError('client changed during extraction; do not build from mixed versions')
    print(json.dumps({'furniture_rows':len(items),'client_unchanged':True,'assets':str(assets)},ensure_ascii=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--game-root',type=Path,required=True)
    parser.add_argument('--reader',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    extract(args.game_root,args.reader,args.output)
