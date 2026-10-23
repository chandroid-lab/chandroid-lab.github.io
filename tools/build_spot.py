"""Bake RAI Institute's Spot + Arm URDF meshes into a compact binary for the website.

Usage (needs numpy, trimesh, fast_simplification):
    xacro spot_description/urdf/spot.urdf.xacro arm:=true > spot_arm.urdf
    python tools/build_spot.py <spot_description checkout> spot_arm.urdf models/spot.bin

Links rigidly bolted to the body are merged into one mesh in the body frame; every
link behind a revolute joint (the four legs and the arm) is exported in its own link
frame together with the joint chain, so the page can pose it. The header also carries
each leg's joint names and foot contact point, which is what the gait IK needs.
"""
import json
import math
import os
import struct
import sys
import xml.etree.ElementTree as ET

import fast_simplification
import numpy as np
import trimesh

PKG = os.path.join(sys.argv[1], 'spot_description')
URDF = sys.argv[2]
OUT = sys.argv[3]

# Standing pose for the legs (radians).
LEG_POSE = {'hip_x': 0.0, 'hip_y': 0.8, 'knee': -1.6}

# Triangle budget per link after decimation.
def budget(link):
    if link == 'body':
        return 18000
    if link.endswith('_hip'):
        return 1400
    if link.endswith('upper_leg'):
        return 3000
    if link.endswith('lower_leg'):
        return 2200
    return 3200

# 0 = dark plastic, 1 = Spot yellow.
MATERIALS = {'BlackAbs': 0, 'wrap': 1}


def rot_rpy(r, p, y):
    cr, sr, cp, sp, cy, sy = math.cos(r), math.sin(r), math.cos(p), math.sin(p), math.cos(y), math.sin(y)
    rx = np.array([[1, 0, 0], [0, cr, -sr], [0, sr, cr]])
    ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
    rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    return rz @ ry @ rx


def origin_tf(el):
    t = np.eye(4)
    o = el.find('origin') if el is not None else None
    if o is None:
        return t
    xyz = [float(v) for v in o.get('xyz', '0 0 0').split()]
    rpy = [float(v) for v in o.get('rpy', '0 0 0').split()]
    t[:3, :3] = rot_rpy(*rpy)
    t[:3, 3] = xyz
    return t


def axis_rot(axis, q):
    return trimesh.transformations.rotation_matrix(q, axis)


def load_obj(path):
    verts, faces, mats = [], [], []
    cur = 0
    with open(path) as f:
        for line in f:
            if line.startswith('v '):
                verts.append([float(x) for x in line.split()[1:4]])
            elif line.startswith('usemtl'):
                cur = MATERIALS.get(line.split()[1], 0)
            elif line.startswith('f '):
                idx = []
                for tok in line.split()[1:]:
                    i = int(tok.split('/')[0])
                    idx.append(i - 1 if i > 0 else len(verts) + i)
                for k in range(1, len(idx) - 1):
                    faces.append([idx[0], idx[k], idx[k + 1]])
                    mats.append(cur)
    return np.array(verts, np.float64), np.array(faces, np.int64), np.array(mats, np.int64)


def link_geometry(link_el, target):
    """Returns (verts, faces, per-vertex material) for a link's visuals, in link frame."""
    parts = []
    for vis in link_el.findall('visual'):
        mesh = vis.find('geometry/mesh')
        if mesh is None:
            continue
        fn = mesh.get('filename').replace('package://spot_description/', '')
        v, f, m = load_obj(os.path.join(PKG, fn))
        tf = origin_tf(vis)
        v = (tf[:3, :3] @ v.T).T + tf[:3, 3]
        parts.append((v, f, m))
    if not parts:
        return None
    total = sum(len(p[1]) for p in parts)
    out_v, out_f, out_m = [], [], []
    base = 0
    for v, f, m in parts:
        for mat in np.unique(m):
            sub = trimesh.Trimesh(v, f[m == mat], process=True)
            sub.merge_vertices()
            n = len(sub.faces)
            keep = max(60, int(round(target * n / total)))
            if n > keep:
                dv, df = fast_simplification.simplify(
                    sub.vertices.astype(np.float32), sub.faces.astype(np.int32), 1.0 - keep / n)
                sub = trimesh.Trimesh(dv, df, process=True)
            # Split vertices at hard edges so machined corners stay crisp while
            # curved panels still shade smoothly.
            sub = trimesh.graph.smooth_shade(sub, angle=np.radians(35))
            out_v.append(sub.vertices)
            out_f.append(sub.faces + base)
            out_m.append(np.full(len(sub.vertices), mat))
            base += len(sub.vertices)
    verts = np.concatenate(out_v)
    faces = np.concatenate(out_f)
    mats = np.concatenate(out_m)
    return verts, faces, mats


def main():
    root = ET.parse(URDF).getroot()
    links = {l.get('name'): l for l in root.findall('link')}
    joint_by_child = {j.find('child').get('link'): j for j in root.findall('joint')}

    def moves(link):
        """True if a revolute joint sits between this link and the body."""
        while link in joint_by_child:
            j = joint_by_child[link]
            if j.get('type') == 'revolute':
                return True
            link = j.find('parent').get('link')
        return False

    def depth(link):
        d = 0
        while link in joint_by_child:
            d += 1
            link = joint_by_child[link].find('parent').get('link')
        return d

    def leg_q(joint_name):
        for key, q in LEG_POSE.items():
            if joint_name.endswith(key):
                return q
        return 0.0

    def fk_static(link):
        if link == 'body':
            return np.eye(4)
        j = joint_by_child[link]
        t = fk_static(j.find('parent').get('link')) @ origin_tf(j)
        if j.get('type') == 'revolute':
            axis = [float(v) for v in j.find('axis').get('xyz').split()]
            t = t @ axis_rot(axis, leg_q(j.get('name')))
        return t

    def foot_contact(link):
        """Bottom of the rubber ball on a lower leg, in that link's frame."""
        for col in links[link].findall('collision'):
            sphere = col.find('geometry/sphere')
            if sphere is None:
                continue
            o = origin_tf(col)
            return [o[0, 3], o[1, 3], o[2, 3] - float(sphere.get('radius'))]
        raise SystemExit(f'no contact sphere on {link}')

    geos = {}
    for name, el in links.items():
        geo = link_geometry(el, budget(name))
        if geo is not None:
            geos[name] = geo

    # In the standing pose the feet rest on the ground, so the page lifts the body
    # by -footZ to put them there.
    foot_z = min(
        (((tf[:3, :3] @ v.T).T + tf[:3, 3])[:, 2].min())
        for name, (v, f, m) in geos.items()
        for tf in [fk_static(name)]
    )

    static_v, static_n, static_f, static_m = [], [], [], []
    base = 0
    for name, (v, f, m) in geos.items():
        if moves(name):
            continue
        tf = fk_static(name)
        n = (tf[:3, :3] @ trimesh.Trimesh(v, f, process=False).vertex_normals.T).T
        static_v.append((tf[:3, :3] @ v.T).T + tf[:3, 3])
        static_n.append(n)
        static_f.append(f + base)
        static_m.append(m)
        base += len(v)

    meshes = [('base', None, np.concatenate(static_v), np.concatenate(static_n),
               np.concatenate(static_f), np.concatenate(static_m))]

    chain = []
    # Shallowest first, so the page can walk the chain in one pass.
    for j in sorted(root.findall('joint'), key=lambda j: depth(j.find('child').get('link'))):
        child = j.find('child').get('link')
        if not moves(child):
            continue
        axis_el = j.find('axis')
        limit_el = j.find('limit')
        entry = {
            'joint': j.get('name'),
            'type': j.get('type'),
            'parent': j.find('parent').get('link'),
            'link': child,
            'origin': origin_tf(j).T.reshape(-1).tolist(),  # column-major
            'axis': [float(v) for v in axis_el.get('xyz').split()] if axis_el is not None else [0, 0, 1],
        }
        if limit_el is not None:
            entry['limit'] = [float(limit_el.get('lower')), float(limit_el.get('upper'))]
        chain.append(entry)
        if child in geos:
            v, f, m = geos[child]
            n = trimesh.Trimesh(v, f, process=False).vertex_normals
            meshes.append((child, child, v, n, f, m))

    legs = [{
        'name': side,
        'hipX': f'{side}_hip_x',
        'hipY': f'{side}_hip_y',
        'knee': f'{side}_knee',
        'lowerLeg': f'{side}_lower_leg',
        'foot': foot_contact(f'{side}_lower_leg'),
    } for side in ('front_left', 'front_right', 'rear_left', 'rear_right')]

    blobs = []
    header_meshes = []
    offset = 0

    def add(buf):
        nonlocal offset
        pad = (-len(buf)) % 4
        buf = buf + b'\0' * pad
        start = offset
        blobs.append(buf)
        offset += len(buf)
        return start

    total_tris = 0
    for name, link, v, n, f, m in meshes:
        vmin = v.min(axis=0)
        vmax = v.max(axis=0)
        span = np.maximum(vmax - vmin, 1e-6)
        q = np.round((v - vmin) / span * 65535 - 32768).astype(np.int16)
        nn = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        nq = np.round(nn * 127).astype(np.int8)
        index32 = len(v) > 65535
        idx = f.astype(np.uint32 if index32 else np.uint16).reshape(-1)
        total_tris += len(f)
        header_meshes.append({
            'name': name,
            'link': link,
            'vertexCount': int(len(v)),
            'indexCount': int(len(idx)),
            'index32': bool(index32),
            'min': vmin.tolist(),
            'span': span.tolist(),
            'position': add(q.tobytes()),
            'normal': add(nq.tobytes()),
            'material': add(m.astype(np.uint8).tobytes()),
            'index': add(idx.tobytes()),
        })

    header = json.dumps({
        'source': 'RAI Institute spot_description (MIT / BSD-3-Clause)',
        'footZ': float(foot_z),
        'standPose': LEG_POSE,
        'meshes': header_meshes,
        'chain': chain,
        'legs': legs,
    }, separators=(',', ':')).encode()
    header += b' ' * ((-len(header)) % 4)
    with open(OUT, 'wb') as fo:
        fo.write(b'SPT1')
        fo.write(struct.pack('<I', len(header)))
        fo.write(header)
        for b in blobs:
            fo.write(b)
    print('triangles', total_tris, 'bytes', os.path.getsize(OUT), 'footZ', foot_z)
    for hm in header_meshes:
        print(hm['name'], hm['vertexCount'], hm['indexCount'] // 3)


main()
