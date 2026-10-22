"""提取设计场的照明数值；不复制地图、纹理或原始环境文件。"""
import argparse
import hashlib
import json
import math
from pathlib import Path


def build(root):
    rows = []
    for scene, name in [('001', '空旷原野'), ('002', '山水画卷')]:
        for quality, directory in [('hd', ''), ('bd', 'bd/'), ('low', 'low/')]:
            for preset in ['默认'] + [weather + '_' + time for weather in ['晴天', '雨天', '雪天'] for time in ['中午', '早晨', '黑夜']]:
                path = f'data/source/maps/HD家园设计场{scene}/{directory}'
                path += 'environment.json' if preset == '默认' else f'env_presets/{preset}/environment.json'
                body = (root / path).read_bytes()
                env = json.loads(body.decode('gb18030'))
                lights = {}
                for field in ['sunlight', 'moonlight']:
                    light = env.get(field, {})
                    keys = ['dir', 'diffuse', 'specular', 'diffuseIntensity', 'specularIntensity',
                            'ambientColor', 'skyLightColor', 'commonLightColor', 'ambientIntensity',
                            'skyLightIntensity', 'commonLightIntensity']
                    value = {key: light[key] for key in keys if key in light}
                    direction = value.get('dir')
                    if direction:
                        x, y, z = direction
                        length = math.sqrt(x*x+y*y+z*z)
                        if length < 1e-9: raise ValueError('zero light direction')
                        value['directionAnglesDegrees'] = {
                            'elevation': math.degrees(math.asin(max(-1, min(1, y/length)))),
                            'azimuthFromNegativeZ': math.degrees(math.atan2(-x, -z)) % 360,
                        }
                    lights[field] = value
                rows.append({'scene': name, 'quality': quality, 'preset': preset,
                             'flags': {k: env[k] for k in ['environmentType', 'lightSource', 'enableDayNightCycle', 'enableGameTimeAffectLights', 'preferedGameTime'] if k in env},
                             'lights': lights, 'path': path, 'sha256': hashlib.sha256(body).hexdigest()})
    return {'schemaVersion': 1, 'usage': 'numeric-reference-not-runtime-replay',
            'angleConvention': 'elevation=asin(y/length); azimuth=atan2(-x,-z), not a geographic north assertion',
            'conditions': 'presets can be affected by time, quality and runtime overrides', 'presets': rows}


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--assets', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    result = build(a.assets)
    a.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)+'\n', 'utf-8')
    print(json.dumps({'presets': len(result['presets']), 'runtimeReplay': False}))
