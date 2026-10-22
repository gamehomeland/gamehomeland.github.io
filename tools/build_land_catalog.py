"""从设计尺寸表和实际.land/.pland四角坐标生成地块平面资料。"""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path


def polygon_area(points):
    return abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(points,points[1:]+points[:1])))/2


def build(root):
    root=Path(root).resolve();sources={}
    def table(name):
        path=(root/name).resolve()
        if not path.is_relative_to(root):raise ValueError('资源路径越界')
        raw=path.read_bytes();sources[name]={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        return list(csv.DictReader(raw.decode('gb18030').splitlines(),delimiter='\t'))
    def points(row):return [[int(row[f'X{i}'])/64,int(row[f'Y{i}'])/64] for i in range(1,5)]
    def plot(row,key,label,area):
        p=points(row);actual=polygon_area(p)
        if abs(actual-area)>max(1,area*.0003):raise ValueError(f'{key}的坐标面积与标称面积不符')
        dimensions=sorted([math.dist(p[0],p[1]),math.dist(p[1],p[2])])
        return {'key':key,'name':label,'areaM2':area,'points':p,'edgeLengthsM':dimensions,
                'polygonAreaM2':actual,'heightRaw':int(row['Z']),'rotationRaw':int(row['ROTATION']),
                'sourceCorners':[[int(row[f'X{i}']),int(row[f'Y{i}'])] for i in range(1,5)]}
    ground=table('ui/Scheme/Case/Homeland/GroundArea.tab')
    presets=[]
    for row in sorted(ground,key=lambda r:int(r['nOrder'])):
        if int(row['nOrder'])<=0:continue
        x,z=int(row['nLength']),int(row['nWidth']);area=x*z
        presets.append({'key':f'size-{area}','name':f'{area:,} 平','areaM2':area,'lengthM':x,'widthM':z,
                        'privateOnly':row['bPrivateHome']=='1','points':[[0,0],[x,0],[x,z],[0,z]]})
    info=table('ui/Scheme/Case/Homeland/LandInfo.txt')
    info=[r for r in info if int(r['nMapID'])>0]
    source_maps={int(r['ID']):r for r in table('settings/MapList.tab') if r['ID'].isdigit()}
    home={int(r['MapID']):r for r in table('settings/Homeland/HomelandMapList.tab') if r['MapID'].isdigit()}
    private_areas=table('ui/Scheme/Case/Homeland/PrivateHomeAreas.tab')
    skins=table('ui/Scheme/Case/Homeland/PrivateHomeSkin.tab')
    maps=[]
    for map_id in sorted({int(r['nMapID']) for r in info}):
        meta=source_maps[map_id];private=home.get(map_id,{}).get('IsPrivateHomeMap')=='1'
        name=meta['Name'];extension='pland' if private else 'land';key=f'{"private" if private else "community"}-{map_id}'
        path=f'maps/{name}/{name}.{extension}';rows=table(path)
        plots=[];seen=set();full=None
        for row in rows:
            number=int(row['SubLandIndex'] if private else row['LandIndex'])
            if number in seen:raise ValueError('同一地图地块编号重复')
            seen.add(number)
            if private:
                if number==0:
                    total=int(next(r['nArea'] for r in info if int(r['nMapID'])==map_id))
                    full=plot(row,key+'-all',meta['DisplayName']+' · 全部区域',total);continue
                matches=[r for r in private_areas if r['nMapID']==str(map_id) and r['nLandIndex']==row['LandIndex'] and r['nAreaIndex']==str(number)]
                if len(matches)!=1:raise ValueError('私宅分区元数据无法唯一关联')
                item=matches[0];label=item['szAreaName'];area=int(item['nArea'])
            else:
                matches=[r for r in info if r['nMapID']==str(map_id) and r['nLandIndex']==str(number)]
                if len(matches)!=1:raise ValueError('社区地块元数据无法唯一关联')
                item=matches[0];label=f'{number}号 · {item["szLandName"]}';area=int(item['nArea'])
            plots.append({**plot(row,key+'-'+str(number),label,area),'index':number})
        plots.sort(key=lambda r:r['index'])
        if private and (not full or sum(r['areaM2'] for r in plots)!=full['areaM2']):raise ValueError('私宅各分区面积之和不等于整块面积')
        if not private and len(plots)!=len([r for r in info if int(r['nMapID'])==map_id]):raise ValueError('社区地块数量不一致')
        entry={'key':key,'mapId':map_id,'name':meta['DisplayName'],'kind':'private' if private else 'community','plots':plots,'source':path}
        if full:
            entry['whole']=full
            entry['skins']=[{'id':int(r['dwSkinID']),'name':r['szSkinName']} for r in skins if r['nMapID']==str(map_id)]
        maps.append(entry)
    return {'schemaVersion':1,'horizontalUnitsPerMeter':64,'scope':'地块平面四角、设计尺寸和私宅分区；不包含地形高度、道路、周边模型或玩家解锁状态。',
            'presets':presets,'maps':maps,'sources':[{'path':p,**v} for p,v in sources.items()]}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--assets',required=True);parser.add_argument('--output',required=True)
    args=parser.parse_args();data=build(args.assets)
    Path(args.output).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'presets':len(data['presets']),'maps':len(data['maps']),'communityPlots':sum(len(m['plots']) for m in data['maps'] if m['kind']=='community'),'privateZones':sum(len(m['plots']) for m in data['maps'] if m['kind']=='private')}))
