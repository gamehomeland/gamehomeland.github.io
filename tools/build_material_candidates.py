"""核对彩色透明材料；试验资料与默认拼布色卡分别输出。"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import struct

import numpy as np
from PIL import Image


def decode_texture(body):
    if body[:2] == b"Hx":
        import texture2ddecoder as td
        width, height = struct.unpack_from(">HH", body, 12)
        kind = body[18]
        if body[17] != 1 or kind not in (0, 2):
            raise ValueError("unreviewed texture compression")
        blocks = td.unpack_crunch(body)
        expected = ((width + 3) // 4) * ((height + 3) // 4) * (8 if kind == 0 else 16)
        if len(blocks) != expected:
            raise ValueError("invalid texture payload")
        decoder = td.decode_bc1 if kind == 0 else td.decode_bc3
        image = Image.frombytes("RGBA", (width, height), decoder(blocks, width, height), "raw", "BGRA")
    else:
        image = Image.open(io.BytesIO(body)).convert("RGBA")
    result = np.asarray(image, dtype=float) / 255
    image.close()
    return result


def display(linear, exposure):
    x = np.maximum(0, linear * 2 ** exposure - .004)
    return np.rint(np.clip(x * (6.2 * x + .5) / (x * (6.2 * x + 1.7) + .06), 0, 1) * 255).astype(int)


def footprint(mesh, anchor, square):
    if square:
        low, high = np.asarray(anchor['BoundBoxMin']) / 100, np.asarray(anchor['BoundBoxMax']) / 100
        if not np.allclose(low[[0, 2]], -high[[0, 2]], atol=1e-5) or abs(high[0]-high[2]) > 1e-5:
            raise ValueError('rectangular material bounds changed')
        return {'source': 'anchor-bounds', 'bounds': [low.tolist(), high.tolist()], 'triangles': []}
    if mesh[0x54:0x58] != b'HSEM' or struct.unpack_from('<I', mesh, 0x5c)[0] != 2:
        raise ValueError('unreviewed mesh stream')
    count, faces, pos, indices = [struct.unpack_from('<I', mesh, o)[0] for o in (0x90, 0x94, 0x9c, 0xb4)]
    if not 0 < count <= 100000 or pos+count*12 > len(mesh) or indices+faces*12 > len(mesh):
        raise ValueError('invalid mesh ranges')
    vertices = np.frombuffer(mesh, dtype='<f4', offset=pos, count=count*3).reshape(-1, 3) / 100
    index = np.frombuffer(mesh, dtype='<u4', offset=indices, count=faces*3).reshape(-1, 3)
    if not np.isfinite(vertices).all() or index.max() >= count:
        raise ValueError('invalid mesh values')
    low, high = vertices.min(axis=0), vertices.max(axis=0)
    top = [vertices[t][:, [0, 2]].tolist() for t in index if vertices[t][:, 1].min() > high[1]-.0001]
    if not top or len(top) > 500: raise ValueError('top surface was not identified')
    return {'source': 'mesh-vertices-indices', 'bounds': [low.tolist(), high.tolist()], 'triangles': top}


def build(assets, catalog, palette):
    root = Path(assets).resolve()
    evidence = {}

    def read(path):
        normalized = str(path).replace("\\", "/")
        source = (root / normalized).resolve()
        if not source.is_relative_to(root):
            raise ValueError("resource path escaped root")
        body = source.read_bytes()
        evidence[normalized] = {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        return body

    def document(path):
        return json.loads(read(path).decode("gb18030"))

    shader = read("data/material/material/mtl_std_colorize.fx5").decode("gb18030")
    required = ["local24_Prepare * 0.1", "pow(abs(local2), 2.2f)",
                "MainNodeParam.Opacity = local2.a", "local52.a", "local47_Prepare.rgb * local47_Prepare.a"]
    if any(token not in shader for token in required):
        raise ValueError("material calculation changed; review before regenerating")
    opaque = [c for c in palette["colors"] if not c["translucent"]]
    exposure = palette["displayTransform"]["exposure"]
    groups = {}
    for entry in catalog:
        item, model = entry["item"], entry["model"]
        name = item["szName"]
        if not (name.startswith("琉璃·") or name.startswith("琉璃七巧·玄雾·大板·")):
            continue
        key = name.rsplit("·", 1)[0]
        path = model["model"].replace("\\", "/")
        material = document(Path(path).with_suffix(".jsoninspack"))
        if len(material["LOD"]) != 1 or len(material["LOD"][0]["Group"]) != 1:
            raise ValueError("unreviewed material groups")
        subsets = material["LOD"][0]["Group"][0]["Subset"]
        if len(subsets) != 1:
            raise ValueError("unreviewed material subsets")
        subset = subsets[0]
        if subset["Info"]["RefPath"].replace("\\", "/") != "data/material/material/mtl_std_colorize.jsondef":
            raise ValueError("unreviewed shader")
        state = subset["RenderState"]
        if state["BlendMode"] != 12 or state["TwoSide"] != 0:
            raise ValueError("unreviewed transparency")
        definition = document(subset["Info"]["RefPath"])
        params = {p["Name"]: p["Value"] for p in definition["Param"]}
        params.update({p["Name"]: p["Value"] for p in subset["Param"]})
        for name_, expected in {"Brightness": 1, "Saturation": 1, "fresnelStrength": 0}.items():
            if float(params[name_]) != expected:
                raise ValueError("unreviewed correction")
        for name_ in ("Emissive Color", "HighlightColor"):
            if any(float(v) != 0 for v in params[name_][:3]):
                raise ValueError("emissive material requires separate lighting")
        texture = decode_texture(read(Path(params["BaseColorMap"].replace("\\", "/")).with_suffix(".dds")))
        mask = decode_texture(read(Path(params["Map(MRE)"].replace("\\", "/")).with_suffix(".dds")))
        if texture.shape != mask.shape:
            raise ValueError("texture coordinates require explicit resampling")
        base = texture[:, :, :3] ** 2.2
        contrast = float(params["BaseColor_ContrastAdjust"]) * .1
        exponent = 1 + contrast if contrast > 0 else 1 / (1 - contrast)
        corrected = np.where(base >= .5, 1 - .5 * (2 * (1 - base)) ** exponent,
                             .5 * (2 * base) ** exponent)
        tint = np.asarray(params["BaseColor_colorizeColor"], dtype=float)
        albedo = base * (1 - mask[:, :, 3:4]) + corrected * tint[:3] * tint[3] * mask[:, :, 3:4]
        alpha = texture[:, :, 3:4] ** 2.2
        if not np.isfinite(albedo).all() or np.any(albedo < 0) or np.any(albedo > 1):
            raise ValueError("invalid albedo")
        recipes = []
        for color in opaque:
            # 保留颜色与 alpha 的逐纹素相关性，不能把两个平均值相乘。
            mixed = albedo * alpha + np.asarray(color["linearColor"]) * (1 - alpha)
            pixels = display(mixed, exposure).reshape(-1, 3)
            recipes.append({"base": color["key"], "rgb": display(mixed.mean(axis=(0, 1)), exposure).tolist(),
                            "rgbMin": pixels.min(axis=0).tolist(), "rgbMax": pixels.max(axis=0).tolist()})
        anchor = document(path + ".jsonAP")
        mesh = read(path)
        lower, upper = anchor["BoundBoxMin"], anchor["BoundBoxMax"]
        variant = {"name": name, "furnitureId": int(item["dwFurnitureID"]),
                   "representId": int(item["nRepresentID"]),
                   "scaleRange": list(map(float, item["szScaleRange"].split(";"))),
                   "declaredBounds": [lower, upper], "planeCount": len(anchor["planes"]),
                   "geometry": "square-declared-bounds" if key.startswith("琉璃·") else "irregular-mesh",
                   "footprint": footprint(mesh, anchor, key.startswith('琉璃·')),
                   "meshHeaderValue": struct.unpack_from("<I", mesh, 0x5c)[0],
                   "modelPath": path}
        if model["bCanNonUniformScaling"] not in ("", "0"):
            raise ValueError("probe encoder only supports uniform scaling")
        record = {"name": key, "status": "experimental-opt-in", "twoSided": False,
                  "textureRgbMin": np.rint(texture[:, :, :3].min(axis=(0, 1)) * 255).astype(int).tolist(),
                  "textureRgbMax": np.rint(texture[:, :, :3].max(axis=(0, 1)) * 255).astype(int).tolist(),
                  "opacityMin": float(alpha.min()), "opacityMax": float(alpha.max()),
                  "linearMean": albedo.mean(axis=(0, 1)).tolist(), "recipes": recipes, "variants": [variant]}
        if key not in groups:
            groups[key] = record
        else:
            if groups[key]["recipes"] != recipes:
                raise ValueError("size variants differ")
            groups[key]["variants"].append(variant)
    if len(groups) != 6 or any(len(c["variants"]) != 2 for c in groups.values()):
        raise ValueError("candidate catalog incomplete")
    return {"schemaVersion": 1, "status": "experimental-opt-in", "gameImportVerified": False,
            "gameColorVerified": False, "model": "unit-white-light-linear-alpha-neutral-display",
            "limitations": ["纹理取样会变化", "尚未重放反射、阴影与透明排序", "不可逐像素叠入微缩图案，试验使用独立前置层"],
            "candidates": list(groups.values()), "resources": evidence}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets", required=True, type=Path)
    ap.add_argument("--tables", required=True, type=Path)
    ap.add_argument("--palette", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--runtime-output", type=Path)
    args = ap.parse_args()
    table_paths = ['UI/Scheme/Case/Homeland/Homeland_FurnitureInfo.tab', 'Represent/homeland/ID_Model.txt']
    bodies = [(args.tables / path).read_bytes() for path in table_paths]
    furniture, model_rows = [list(csv.DictReader(body.decode('gb18030').splitlines(), delimiter='\t')) for body in bodies]
    models = {row['id']: row for row in model_rows}
    rows = [{'item': row, 'model': models[row['nRepresentID']]} for row in furniture
            if row['szName'].startswith('琉璃·') or row['szName'].startswith('琉璃七巧·玄雾·大板·')]
    result = build(args.assets, rows, json.loads(args.palette.read_text("utf-8")))
    result['resources'].update({path: {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()} for path, body in zip(table_paths, bodies)})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    args.output.write_bytes(encoded.encode('utf-8'))
    if args.runtime_output:
        runtime = {'schemaVersion': 1, 'defaultEnabled': False, 'gameColorVerified': False,
                   'researchSha256': hashlib.sha256(encoded.encode('utf-8')).hexdigest(),
                   'paletteSha256': hashlib.sha256(args.palette.read_bytes()).hexdigest(),
                   'materials': [{'key': c['name'], 'recipes': c['recipes'],
                                  'variants': [{k: v[k] for k in ['name', 'furnitureId', 'representId', 'scaleRange', 'planeCount', 'footprint']}
                                               for v in c['variants']]} for c in result['candidates']]}
        args.runtime_output.write_bytes((json.dumps(runtime, ensure_ascii=False, indent=2, allow_nan=False)+'\n').encode('utf-8'))
    print(json.dumps({"materials": len(result["candidates"]), "variants": sum(len(c["variants"]) for c in result["candidates"]), "defaultEnabled": False}))


if __name__ == "__main__":
    main()
