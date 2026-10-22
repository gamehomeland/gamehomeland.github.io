"""Build a numeric scene reference and source fingerprint index from offline resources."""
from pathlib import Path
import argparse
import csv
import hashlib
import io
import json
import re


def function_body(source, name):
    # Strip comments before locating a brace-delimited function body.
    source = re.sub(r'/\*.*?\*/|//[^\r\n]*', '', source, flags=re.S)
    match = re.search(r'\b' + re.escape(name) + r'\s*\([^;{}]*\)\s*\{', source)
    if not match:
        raise ValueError('Function needs review: ' + name)
    start = match.end()
    depth = 1
    for i in range(start, len(source)):
        depth += (source[i] == '{') - (source[i] == '}')
        if depth == 0:
            return source[start:i]
    raise ValueError('Incomplete function: ' + name)


def build(assets, palette):
    names = Path(__file__).with_name('scene-resource-paths.txt').read_text('utf8').splitlines()
    inputs = {name: (assets / name).read_bytes() for name in names if name}
    table = lambda name: list(csv.DictReader(io.StringIO(inputs[name].decode('gb18030')), delimiter='\t'))
    shader = lambda name: inputs['data/material/Shader_DX11_HD/' + name].decode('latin1')
    weather = [row for row in table('ui/Scheme/Case/Homeland/Homeland_Weather.tab') if int(row['nTime']) > 0]
    ground = [row for row in table('ui/Scheme/Case/Homeland/GroundArea.tab') if int(row['nOrder']) > 0]
    dyes = [row for row in table('UI/Scheme/Case/Homeland/Homeland_FurnitureColor.tab') if row['szColorIndices']]
    ids = {str(v['representId']) for color in palette['colors'] for v in color['variants']}
    relevant = [row for row in dyes if row['dwRepresentID'] in ids]
    common, main = shader('CommonParam.h'), shader('ModelBasePixelShader.fx5')
    wet = re.sub(r'\s+', '', function_body(common, 'GetWetnessMask'))
    rain = re.sub(r'\s+', '', function_body(shader('DynamicWeatherCommon.h'), 'RenderRain'))
    if wet != '{returnfloat2(1.0f,1.0f);}' or rain != 'returnColor;':
        raise ValueError('Weather material path changed; review the documentation')
    if 'bEnableRenderLevelLow && g_Com.Switch.bEnableForwardMinimal' not in main:
        raise ValueError('Display branch changed')
    for name in ['ForwardLightFull', 'ForwardLightMinimal']:
        function_body(shader('ForwardLightingEntrance.h5'), name)
    snow = function_body(shader('DynamicWeatherCommon.h'), 'RenderSnow')
    if 'fSurafaceDot < 0.8f' not in snow:
        raise ValueError('Snow normal gate changed')
    return {
        'schema_version': 1,
        'scope': 'Static scene/resource reference. Not complete rendering or an in-game calibration.',
        'weather_presets': [dict(time=int(row['nTime']), weather=int(row['nWeather']), environment=row['szEnvironment']) for row in weather],
        'design_ground_presets': [dict(length=int(row['nLength']), width=int(row['nWidth']), private=bool(int(row['bPrivateHome']))) for row in ground],
        'furniture_dye': {'configured_resources': len(dyes), 'cloth_resources_checked': len(ids), 'cloth_dye_entries': relevant, 'scope': 'Configured detail indices, not arbitrary RGB tint'},
        'render_checks': {
            'material_paths': ['mtl_std.fx5', 'mtl_std_colorize.fx5'],
            'material_class': 'MATERIALID_STANDARD',
            'forward_paths': ['ForwardLightFull', 'ForwardLightMinimal'],
            'local_tonemap_gate': 'bEnableRenderLevelLow && bEnableForwardMinimal',
            'local_tonemap_exposure': 0.5,
            'wetness_mask_in_inspected_path': [1, 1],
            'render_rain_in_inspected_path': 'identity',
            'snow_surface_up_dot_min': 0.8,
            'scene_probe_function': 'ComputeIBL_MultipleEnvProbe',
            'opacity_modifiers': ['material opacity', 'model alpha', 'distance fade'],
        },
        'resources': [{'path': name, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()} for name, body in inputs.items()],
        'not_verified': ['complete scene light settings', 'full deferred/postprocess pipeline', 'server-side scene rules', 'real-game lighting calibration'],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--palette', type=Path, default=Path(__file__).resolve().parents[1] / 'data/furniture_palette.json')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = build(args.assets, json.loads(args.palette.read_text('utf8')))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'resources': len(result['resources']), 'weather_presets': len(result['weather_presets']), 'cloth_dye_entries': len(result['furniture_dye']['cloth_dye_entries'])}))
