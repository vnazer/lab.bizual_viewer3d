"""
Inspector de archivos .blend para pipeline Bizual 3D
=====================================================

Uso:
    blender --background ARCHIVO.blend --python inspect_blend.py

Salida:
    Reporte JSON con:
    - Objetos, materiales, texturas
    - Polycount real (triángulos)
    - UV channels por mesh
    - Modificadores no aplicados
    - Estructura jerárquica
    - Geometría duplicada/oculta
    - Recomendaciones de pipeline

Autor: Analista Dev Bizual - 29 abril 2026
"""

import bpy
import json
import sys
import os
from collections import defaultdict


def format_bytes(bytes_count):
    """Formato humano de bytes."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if bytes_count < 1024.0:
            return f"{bytes_count:.2f} {unit}"
        bytes_count /= 1024.0
    return f"{bytes_count:.2f} TB"


def inspect_objects():
    """Análisis completo de todos los objetos del .blend"""
    objects_report = {
        'total': 0,
        'mesh_count': 0,
        'empty_count': 0,
        'light_count': 0,
        'camera_count': 0,
        'other_count': 0,
        'hidden_count': 0,
        'duplicates': [],
        'naming_issues': [],
    }

    # Patrones de naming convention Bizual
    naming_pattern_ok = []  # Edificio_*, Piso_NN, Unidad_NNN

    name_counter = defaultdict(int)

    for obj in bpy.data.objects:
        objects_report['total'] += 1

        # Conteo por tipo
        if obj.type == 'MESH':
            objects_report['mesh_count'] += 1
        elif obj.type == 'EMPTY':
            objects_report['empty_count'] += 1
        elif obj.type == 'LIGHT':
            objects_report['light_count'] += 1
        elif obj.type == 'CAMERA':
            objects_report['camera_count'] += 1
        else:
            objects_report['other_count'] += 1

        # Hidden detection
        if obj.hide_render or obj.hide_viewport:
            objects_report['hidden_count'] += 1

        # Detección de duplicados por nombre base
        base_name = obj.name.rsplit('.', 1)[0]
        name_counter[base_name] += 1

        # Naming convention Bizual
        if obj.type == 'MESH':
            name_lower = obj.name.lower()
            has_pattern = any([
                'edificio' in name_lower,
                'piso' in name_lower,
                'unidad' in name_lower,
                'tipologia' in name_lower or 'tipología' in name_lower,
            ])
            if has_pattern:
                naming_pattern_ok.append(obj.name)
            else:
                objects_report['naming_issues'].append(obj.name)

    # Reportar duplicados
    for name, count in name_counter.items():
        if count > 1:
            objects_report['duplicates'].append({
                'base_name': name,
                'count': count
            })

    objects_report['naming_pattern_ok_count'] = len(naming_pattern_ok)
    objects_report['naming_pattern_ok_sample'] = naming_pattern_ok[:5]

    return objects_report


def inspect_geometry():
    """Análisis de geometría y polycount"""
    geometry_report = {
        'total_vertices': 0,
        'total_polygons': 0,
        'total_triangles': 0,
        'mesh_breakdown': [],
    }

    for obj in bpy.data.objects:
        if obj.type != 'MESH' or obj.hide_render:
            continue

        mesh = obj.data
        verts = len(mesh.vertices)
        polys = len(mesh.polygons)

        # Estimación de triángulos (cada polígono = n-2 tris)
        tris = sum(len(p.vertices) - 2 for p in mesh.polygons)

        geometry_report['total_vertices'] += verts
        geometry_report['total_polygons'] += polys
        geometry_report['total_triangles'] += tris

        # Top 10 meshes más pesados
        geometry_report['mesh_breakdown'].append({
            'name': obj.name,
            'vertices': verts,
            'triangles': tris,
        })

    # Ordenar por triángulos descendente, mostrar top 10
    geometry_report['mesh_breakdown'].sort(key=lambda x: x['triangles'], reverse=True)
    geometry_report['top_10_heaviest'] = geometry_report['mesh_breakdown'][:10]
    del geometry_report['mesh_breakdown']

    return geometry_report


def inspect_uvs():
    """Análisis de UV channels"""
    uv_report = {
        'meshes_with_uv1': 0,
        'meshes_with_uv2': 0,
        'meshes_without_uv': 0,
        'meshes_with_uv2_names': [],
    }

    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue

        mesh = obj.data
        uv_count = len(mesh.uv_layers)

        if uv_count == 0:
            uv_report['meshes_without_uv'] += 1
        elif uv_count == 1:
            uv_report['meshes_with_uv1'] += 1
        else:
            uv_report['meshes_with_uv2'] += 1
            uv_report['meshes_with_uv2_names'].append(obj.name)

    return uv_report


def inspect_modifiers():
    """Detecta modificadores no aplicados"""
    modifiers_report = {
        'total_unapplied': 0,
        'by_type': defaultdict(int),
        'objects_with_modifiers': [],
    }

    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue

        if len(obj.modifiers) > 0:
            mods_list = [m.type for m in obj.modifiers]
            modifiers_report['total_unapplied'] += len(obj.modifiers)
            modifiers_report['objects_with_modifiers'].append({
                'name': obj.name,
                'modifiers': mods_list,
            })

            for m in obj.modifiers:
                modifiers_report['by_type'][m.type] += 1

    modifiers_report['by_type'] = dict(modifiers_report['by_type'])
    return modifiers_report


def inspect_materials():
    """Análisis de materiales"""
    materials_report = {
        'total': len(bpy.data.materials),
        'used': 0,
        'unused': 0,
        'with_principled_bsdf': 0,
        'sample_names': [],
    }

    for mat in bpy.data.materials:
        if mat.users > 0:
            materials_report['used'] += 1
        else:
            materials_report['unused'] += 1

        materials_report['sample_names'].append(mat.name)

        # Verificar si usa Principled BSDF
        if mat.use_nodes and mat.node_tree:
            for node in mat.node_tree.nodes:
                if node.type == 'BSDF_PRINCIPLED':
                    materials_report['with_principled_bsdf'] += 1
                    break

    materials_report['sample_names'] = materials_report['sample_names'][:20]
    return materials_report


def inspect_textures():
    """Análisis de texturas e imágenes"""
    textures_report = {
        'total_images': len(bpy.data.images),
        'total_size_estimate': 0,
        'resolution_breakdown': defaultdict(int),
        'large_textures': [],
        'sample_names': [],
    }

    for img in bpy.data.images:
        if img.name == 'Render Result' or img.name == 'Viewer Node':
            continue

        w, h = img.size[0], img.size[1]
        if w == 0 or h == 0:
            continue

        # Estimación de tamaño en memoria (RGBA float)
        size_bytes = w * h * 4
        textures_report['total_size_estimate'] += size_bytes

        # Bucket de resolución
        if w >= 4096:
            bucket = '4K+'
        elif w >= 2048:
            bucket = '2K'
        elif w >= 1024:
            bucket = '1K'
        elif w >= 512:
            bucket = '512'
        else:
            bucket = '<512'

        textures_report['resolution_breakdown'][bucket] += 1

        # Texturas grandes
        if w >= 2048:
            textures_report['large_textures'].append({
                'name': img.name,
                'resolution': f"{w}x{h}",
            })

        textures_report['sample_names'].append(img.name)

    textures_report['resolution_breakdown'] = dict(textures_report['resolution_breakdown'])
    textures_report['total_size_estimate_human'] = format_bytes(textures_report['total_size_estimate'])
    textures_report['sample_names'] = textures_report['sample_names'][:15]
    textures_report['large_textures'] = textures_report['large_textures'][:15]

    return textures_report


def inspect_hierarchy():
    """Análisis de jerarquía padre-hijo"""
    hierarchy_report = {
        'root_objects': 0,
        'max_depth': 0,
        'has_collections': len(bpy.data.collections),
        'collections_sample': [c.name for c in list(bpy.data.collections)[:10]],
    }

    def get_depth(obj, current=0):
        if not obj.children:
            return current
        return max(get_depth(c, current + 1) for c in obj.children)

    for obj in bpy.data.objects:
        if obj.parent is None:
            hierarchy_report['root_objects'] += 1
            depth = get_depth(obj)
            hierarchy_report['max_depth'] = max(hierarchy_report['max_depth'], depth)

    return hierarchy_report


def generate_recommendations(report):
    """Genera recomendaciones basadas en el análisis"""
    recs = []

    # Modificadores no aplicados
    if report['modifiers']['total_unapplied'] > 0:
        recs.append({
            'priority': 'HIGH',
            'category': 'Modifiers',
            'issue': f"{report['modifiers']['total_unapplied']} modificadores sin aplicar",
            'action': 'Aplicar modificadores antes de export GLB. En script headless: Ctrl+A en cada modificador'
        })

    # UV2 channel
    if report['uvs']['meshes_with_uv2'] == 0:
        recs.append({
            'priority': 'HIGH si se quiere baking',
            'category': 'UV Channels',
            'issue': 'Ningún mesh tiene UV2 channel (necesario para lightmap)',
            'action': 'Generar UV2 con Smart UV Project o xatlas en pipeline'
        })

    # Texturas grandes
    if report['textures']['resolution_breakdown'].get('4K+', 0) > 0:
        recs.append({
            'priority': 'MEDIUM',
            'category': 'Textures',
            'issue': f"{report['textures']['resolution_breakdown']['4K+']} texturas a 4K+",
            'action': 'Considerar bajar a 2K si no son críticas para la fachada'
        })

    # Muchos materiales
    if report['materials']['used'] > 20:
        recs.append({
            'priority': 'HIGH para mobile',
            'category': 'Materials',
            'issue': f"{report['materials']['used']} materiales (>20 = muchas draw calls)",
            'action': 'Hacer atlas de texturas en Blender para combinar materiales similares'
        })

    # Naming convention
    naming_issues = report['objects']['naming_issues']
    if len(naming_issues) > 5:
        recs.append({
            'priority': 'MEDIUM',
            'category': 'Naming',
            'issue': f"{len(naming_issues)} meshes sin naming convention Bizual",
            'action': 'Renombrar a Edificio_NN > Piso_NN > Unidad_NNN para habilitar lazy loading por unidad'
        })

    # Polycount
    tris = report['geometry']['total_triangles']
    if tris > 500_000:
        recs.append({
            'priority': 'HIGH',
            'category': 'Polycount',
            'issue': f"{tris:,} triángulos (>500K es pesado para mobile)",
            'action': 'Aplicar Decimate modifier con vertex groups para preservar fachada'
        })
    elif tris > 200_000:
        recs.append({
            'priority': 'MEDIUM',
            'category': 'Polycount',
            'issue': f"{tris:,} triángulos (200K-500K es aceptable, optimizable)",
            'action': 'Considerar decimate ligero (~30% reducción)'
        })

    # Geometría oculta
    if report['objects']['hidden_count'] > 0:
        recs.append({
            'priority': 'LOW',
            'category': 'Hidden geometry',
            'issue': f"{report['objects']['hidden_count']} objetos ocultos",
            'action': 'Eliminar geometría oculta antes de export para reducir peso'
        })

    return recs


def main():
    """Ejecutar análisis completo"""
    blend_path = bpy.data.filepath
    file_size = os.path.getsize(blend_path) if blend_path else 0

    print("\n" + "="*70)
    print("INSPECTOR BIZUAL — Análisis de archivo .blend")
    print("="*70)
    print(f"Archivo: {blend_path}")
    print(f"Tamaño: {format_bytes(file_size)}")
    print("="*70)

    report = {
        'file_path': blend_path,
        'file_size_bytes': file_size,
        'file_size_human': format_bytes(file_size),
        'blender_version': bpy.app.version_string,
        'objects': inspect_objects(),
        'geometry': inspect_geometry(),
        'uvs': inspect_uvs(),
        'modifiers': inspect_modifiers(),
        'materials': inspect_materials(),
        'textures': inspect_textures(),
        'hierarchy': inspect_hierarchy(),
    }

    report['recommendations'] = generate_recommendations(report)

    # Resumen ejecutivo
    print("\n📊 RESUMEN EJECUTIVO\n")
    print(f"  Objetos totales:      {report['objects']['total']}")
    print(f"  Meshes:               {report['objects']['mesh_count']}")
    print(f"  Vertices totales:     {report['geometry']['total_vertices']:,}")
    print(f"  Triángulos totales:   {report['geometry']['total_triangles']:,}")
    print(f"  Materiales (usados):  {report['materials']['used']}")
    print(f"  Texturas (imágenes):  {report['textures']['total_images']}")
    print(f"  Tex. memoria estim.:  {report['textures']['total_size_estimate_human']}")
    print(f"  Modif. sin aplicar:   {report['modifiers']['total_unapplied']}")
    print(f"  Meshes con UV2:       {report['uvs']['meshes_with_uv2']}")

    # Recomendaciones
    print("\n🎯 RECOMENDACIONES\n")
    if not report['recommendations']:
        print("  ✅ El archivo se ve limpio, sin issues críticos")
    else:
        for i, rec in enumerate(report['recommendations'], 1):
            print(f"  {i}. [{rec['priority']}] {rec['category']}")
            print(f"     Issue:  {rec['issue']}")
            print(f"     Acción: {rec['action']}\n")

    # Guardar JSON completo
    output_dir = os.path.dirname(blend_path) if blend_path else '.'
    json_path = os.path.join(output_dir, 'blend_inspection_report.json')
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"\n💾 Reporte completo JSON: {json_path}")
    print("="*70 + "\n")


if __name__ == '__main__':
    main()
