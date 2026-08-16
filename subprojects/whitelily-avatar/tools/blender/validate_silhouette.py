"""Render and compare the fixed body-high silhouette and clay review views."""

import argparse
from array import array
import json
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector


SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, SCRIPT_DIRECTORY)

from avatar_contract import CHARACTER_HEIGHT_METERS, HIGH_TRIANGLE_RANGE
from validate_blender_version import validate_blender_version


RESOLUTION = 1024
CAMERA_VIEWS = {
    "front": "CAM_FRONT",
    "back": "CAM_BACK",
    "left": "CAM_LEFT",
    "right": "CAM_RIGHT",
    "top": "CAM_TOP",
    "bottom": "CAM_BOTTOM",
}
REVIEW_VIEWS = ("front", "back", "left", "right")
MAX_KEYPOINT_DRIFT = 0.025
MINIMUM_IOU = 0.94
REQUIRED_OBJECTS = (
    "Face",
    "Eyes",
    "HairFront",
    "HairBack",
    "HairSideL",
    "HairSideR",
    "LilyHairpin",
    "SleeveL",
    "SleeveR",
    "SkirtInner",
    "SkirtOuter",
    "BackRibbon",
)


class SilhouetteValidationError(RuntimeError):
    pass


def fail(code):
    raise SilhouetteValidationError(code)


def blender_arguments():
    arguments = sys.argv
    return arguments[arguments.index("--") + 1 :] if "--" in arguments else []


def collection_meshes(*collection_names):
    objects = {}
    for name in collection_names:
        collection = bpy.data.collections.get(name)
        if collection is None:
            fail("AVATAR_BODY_HIGH_COLLECTION_MISSING")
        for object_ in collection.all_objects:
            if object_.type == "MESH":
                objects[object_.as_pointer()] = object_
    return tuple(objects.values())


def world_bounds(objects):
    points = [object_.matrix_world @ Vector(corner) for object_ in objects for corner in object_.bound_box]
    if not points:
        fail("AVATAR_BODY_HIGH_EMPTY")
    return tuple(
        (min(point[axis] for point in points), max(point[axis] for point in points))
        for axis in range(3)
    )


def object_bounds(name):
    object_ = bpy.data.objects.get(name)
    if object_ is None or object_.type != "MESH":
        fail("AVATAR_BODY_HIGH_OBJECT_MISSING")
    return world_bounds((object_,))


def evaluated_triangle_count(objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    total = 0
    for object_ in objects:
        evaluated = object_.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=depsgraph)
        try:
            total += sum(max(0, len(polygon.vertices) - 2) for polygon in mesh.polygons)
        finally:
            evaluated.to_mesh_clear()
    return total


def validate_body_high_structure(scene):
    if scene.get("AVATAR_ART_STAGE") != "body-high":
        fail("AVATAR_ART_STAGE_INVALID")
    for name in REQUIRED_OBJECTS:
        if bpy.data.objects.get(name) is None or bpy.data.objects[name].type != "MESH":
            fail("AVATAR_BODY_HIGH_OBJECT_MISSING")
    meshes = collection_meshes("BODY_HIGH", "OUTFIT_BASE")
    body_meshes = collection_meshes("BODY_HIGH")
    triangles = evaluated_triangle_count(meshes)
    if not HIGH_TRIANGLE_RANGE[0] <= triangles <= HIGH_TRIANGLE_RANGE[1]:
        fail("AVATAR_BODY_HIGH_TRIANGLE_COUNT_INVALID")
    body_bounds = world_bounds(body_meshes)
    height = body_bounds[2][1] - body_bounds[2][0]
    if abs(height - CHARACTER_HEIGHT_METERS) > 0.01:
        fail("AVATAR_BODY_HIGH_HEIGHT_INVALID")
    face_bounds = object_bounds("Face")
    head_height = face_bounds[2][1] - face_bounds[2][0]
    head_ratio = height / head_height
    if not 6.3 <= head_ratio <= 6.8:
        fail("AVATAR_BODY_HIGH_HEAD_RATIO_INVALID")
    dress_bounds = object_bounds("DressBase")
    shoulder_width = dress_bounds[0][1] - dress_bounds[0][0]
    if not 0.34 <= shoulder_width <= 0.40:
        fail("AVATAR_BODY_HIGH_SHOULDER_WIDTH_INVALID")
    lily_petals = [object_ for object_ in body_meshes if object_.name.startswith("LilyPetal")]
    hair_strands = [object_ for object_ in body_meshes if object_.name.startswith("HairStrand")]
    if len(lily_petals) < 6 or not 6 <= len(hair_strands) <= 10:
        fail("AVATAR_BODY_HIGH_DETAIL_INVALID")
    return {
        "triangleCount": triangles,
        "heightMeters": round(height, 6),
        "headHeightMeters": round(head_height, 6),
        "headToBodyRatio": round(head_ratio, 6),
        "shoulderWidthMeters": round(shoulder_width, 6),
        "hairStrandCount": len(hair_strands),
        "lilyPetalCount": len(lily_petals),
    }


def render_material(name, base_color, emission=False):
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    principled = nodes.get("Principled BSDF")
    if principled is None:
        nodes.clear()
        output = nodes.new("ShaderNodeOutputMaterial")
        principled = nodes.new("ShaderNodeBsdfPrincipled")
        material.node_tree.links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    principled.inputs["Base Color"].default_value = (*base_color, 1.0)
    principled.inputs["Roughness"].default_value = 0.72
    principled.inputs["Metallic"].default_value = 0.0
    principled.inputs["Emission Color"].default_value = (*base_color, 1.0)
    principled.inputs["Emission Strength"].default_value = 1.0 if emission else 0.0
    return material


def configure_render(scene):
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = RESOLUTION
    scene.render.resolution_y = RESOLUTION
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.use_file_extension = True
    scene.view_settings.look = "AgX - Medium High Contrast"
    bpy.data.objects["LIGHT_KEY"].data.energy = 900.0
    bpy.data.objects["LIGHT_FILL"].data.energy = 800.0
    bpy.data.objects["LIGHT_RIM"].data.energy = 650.0
    for camera_name in CAMERA_VIEWS.values():
        camera = bpy.data.objects.get(camera_name)
        if camera is None or camera.type != "CAMERA" or camera.data.type != "ORTHO":
            fail("AVATAR_CAMERA_INVALID")
        camera.data.ortho_scale = 2.10


def render_view(scene, camera_name, material, filepath):
    scene.camera = bpy.data.objects[camera_name]
    scene.view_layers[0].material_override = material
    scene.render.filepath = filepath
    bpy.ops.render.render(write_still=True)
    scene.view_layers[0].material_override = None


def alpha_pixels(filepath):
    image = bpy.data.images.load(filepath, check_existing=False)
    try:
        width, height = image.size
        pixels = array("f", [0.0]) * (width * height * 4)
        image.pixels.foreach_get(pixels)
        occupied = set()
        for source_y in range(height):
            target_y = height - 1 - source_y
            row_offset = source_y * width * 4
            for x in range(width):
                if pixels[row_offset + x * 4 + 3] >= 0.5:
                    occupied.add(target_y * width + x)
        return width, height, occupied
    finally:
        bpy.data.images.remove(image)


def alpha_runs(occupied, width, height):
    runs = []
    for y in range(height):
        start = None
        for x in range(width):
            present = y * width + x in occupied
            if present and start is None:
                start = x
            elif not present and start is not None:
                runs.append([y, start, x - 1])
                start = None
        if start is not None:
            runs.append([y, start, width - 1])
    return runs


def runs_to_pixels(runs, width):
    pixels = set()
    for y, start, end in runs:
        offset = y * width
        pixels.update(range(offset + start, offset + end + 1))
    return pixels


def normalized_bounds(occupied, width, height):
    if not occupied:
        fail("AVATAR_SILHOUETTE_EMPTY")
    xs = [pixel % width for pixel in occupied]
    ys = [pixel // width for pixel in occupied]
    pixel_bounds = [min(xs), min(ys), max(xs), max(ys)]
    return pixel_bounds, [round(value, 6) for value in (
        pixel_bounds[0] / width,
        pixel_bounds[1] / height,
        (pixel_bounds[2] + 1) / width,
        (pixel_bounds[3] + 1) / height,
    )]


def bounds_center(bounds):
    return Vector(tuple((low + high) / 2 for low, high in bounds))


def keypoint_world_positions():
    body = world_bounds(collection_meshes("BODY_HIGH"))
    face = object_bounds("Face")
    dress = object_bounds("DressBase")
    inner_skirt = object_bounds("SkirtInner")
    foot_l = object_bounds("FootL")
    foot_r = object_bounds("FootR")
    points = {
        "headTop": Vector((0.0, 0.0, body[2][1])),
        "chin": Vector((0.0, face[1][0], face[2][0])),
        "shoulderL": Vector((dress[0][1], 0.0, dress[2][1] - 0.04)),
        "shoulderR": Vector((dress[0][0], 0.0, dress[2][1] - 0.04)),
        "waist": Vector((0.0, 0.0, dress[2][0] + 0.03)),
        "skirtHem": Vector((0.0, inner_skirt[1][0], inner_skirt[2][0])),
        "sleeveCuffL": bpy.data.objects["SleeveCuffL"].matrix_world.translation,
        "sleeveCuffR": bpy.data.objects["SleeveCuffR"].matrix_world.translation,
        "footBottomL": Vector((bounds_center(foot_l).x, bounds_center(foot_l).y, foot_l[2][0])),
        "footBottomR": Vector((bounds_center(foot_r).x, bounds_center(foot_r).y, foot_r[2][0])),
        "lily": bpy.data.objects["LilyHairpin"].matrix_world.translation,
        "backRibbon": bpy.data.objects["BackRibbon"].matrix_world.translation,
    }
    return points


def projected_keypoints(scene, camera):
    projected = {}
    for name, point in keypoint_world_positions().items():
        coordinate = world_to_camera_view(scene, camera, point)
        projected[name] = [round(coordinate.x, 6), round(1.0 - coordinate.y, 6)]
    return projected


def render_masks(scene, output_directory):
    mask_directory = os.path.join(output_directory, "masks")
    os.makedirs(mask_directory, exist_ok=True)
    material = render_material("BodyHighSilhouetteMask", (1.0, 1.0, 1.0), emission=True)
    views = {}
    for view_name, camera_name in CAMERA_VIEWS.items():
        filepath = os.path.join(mask_directory, view_name + ".png")
        render_view(scene, camera_name, material, filepath)
        width, height, occupied = alpha_pixels(filepath)
        pixel_bounds, normalized = normalized_bounds(occupied, width, height)
        views[view_name] = {
            "boundsPixels": pixel_bounds,
            "boundsNormalized": normalized,
            "keypoints": projected_keypoints(scene, bpy.data.objects[camera_name]),
            "alphaRuns": alpha_runs(occupied, width, height),
        }
    return views


def create_contact_sheet(input_paths, output_path):
    sources = [bpy.data.images.load(path, check_existing=False) for path in input_paths]
    try:
        sheet_width = RESOLUTION * 2
        sheet_height = RESOLUTION * 2
        sheet_pixels = array("f", [0.0]) * (sheet_width * sheet_height * 4)
        for index, source in enumerate(sources):
            source_pixels = array("f", [0.0]) * (RESOLUTION * RESOLUTION * 4)
            source.pixels.foreach_get(source_pixels)
            column = index % 2
            display_row = index // 2
            blender_row = 1 - display_row
            for y in range(RESOLUTION):
                source_start = y * RESOLUTION * 4
                target_y = blender_row * RESOLUTION + y
                target_start = (target_y * sheet_width + column * RESOLUTION) * 4
                sheet_pixels[target_start : target_start + RESOLUTION * 4] = source_pixels[
                    source_start : source_start + RESOLUTION * 4
                ]
        sheet = bpy.data.images.new("BodyHighContactSheet", width=sheet_width, height=sheet_height, alpha=True)
        sheet.pixels.foreach_set(sheet_pixels)
        sheet.filepath_raw = output_path
        sheet.file_format = "PNG"
        sheet.save()
        bpy.data.images.remove(sheet)
    finally:
        for source in sources:
            bpy.data.images.remove(source)


def render_clay_reviews(scene, output_directory):
    clay = render_material("BodyHighClayReview", (0.82, 0.84, 0.80), emission=False)
    clay_mid = render_material("BodyHighClayMid", (0.58, 0.61, 0.56), emission=False)
    clay_dark = render_material("BodyHighClayDark", (0.19, 0.22, 0.18), emission=False)
    clay_light = render_material("BodyHighClayLight", (0.94, 0.95, 0.91), emission=False)
    for object_ in collection_meshes("BODY_HIGH", "OUTFIT_BASE"):
        object_.data.materials.clear()
        object_.data.materials.append(clay)
    for prefix in ("Iris", "Eyelid", "LowerEyelid", "Mouth"):
        for object_ in bpy.data.objects:
            if object_.type == "MESH" and object_.name.startswith(prefix):
                object_.data.materials.clear()
                object_.data.materials.append(clay_mid)
    for prefix in ("Pupil",):
        for object_ in bpy.data.objects:
            if object_.type == "MESH" and object_.name.startswith(prefix):
                object_.data.materials.clear()
                object_.data.materials.append(clay_dark)
    for prefix in ("Face", "Nose", "EyeWhite", "EyeHighlight", "Eyes"):
        for object_ in bpy.data.objects:
            if object_.type == "MESH" and object_.name.startswith(prefix):
                object_.data.materials.clear()
                object_.data.materials.append(clay_light)
    paths = []
    for view_name in REVIEW_VIEWS:
        filepath = os.path.join(output_directory, view_name + ".png")
        render_view(scene, CAMERA_VIEWS[view_name], None, filepath)
        paths.append(filepath)
    create_contact_sheet(paths, os.path.join(output_directory, "contact-sheet.png"))


def compare_baseline(current, baseline):
    width = current["resolution"]["width"]
    for view_name in REVIEW_VIEWS:
        current_view = current["views"][view_name]
        baseline_view = baseline.get("views", {}).get(view_name)
        if baseline_view is None:
            fail("AVATAR_SILHOUETTE_BASELINE_INVALID")
        current_pixels = runs_to_pixels(current_view["alphaRuns"], width)
        baseline_pixels = runs_to_pixels(baseline_view.get("alphaRuns", []), width)
        union = len(current_pixels | baseline_pixels)
        iou = len(current_pixels & baseline_pixels) / union if union else 0.0
        current_view["iouToBaseline"] = round(iou, 6)
        if iou < MINIMUM_IOU:
            fail("AVATAR_SILHOUETTE_IOU_LOW")
        for name, point in current_view["keypoints"].items():
            baseline_point = baseline_view.get("keypoints", {}).get(name)
            if baseline_point is None:
                fail("AVATAR_SILHOUETTE_BASELINE_INVALID")
            if max(abs(point[0] - baseline_point[0]), abs(point[1] - baseline_point[1])) > MAX_KEYPOINT_DRIFT:
                fail("AVATAR_SILHOUETTE_KEYPOINT_DRIFT")


def validate_silhouette(baseline_path, output_directory, write_baseline=False):
    validate_blender_version()
    scene = bpy.context.scene
    measurements = validate_body_high_structure(scene)
    configure_render(scene)
    os.makedirs(output_directory, exist_ok=True)
    data = {
        "schema": 1,
        "artStage": "body-high",
        "resolution": {"width": RESOLUTION, "height": RESOLUTION},
        "thresholds": {"minimumIoU": MINIMUM_IOU, "maximumKeypointDrift": MAX_KEYPOINT_DRIFT},
        "measurements": measurements,
        "views": render_masks(scene, output_directory),
    }
    if write_baseline:
        os.makedirs(os.path.dirname(baseline_path), exist_ok=True)
        with open(baseline_path, "w", encoding="utf-8") as baseline_file:
            json.dump(data, baseline_file, ensure_ascii=False, indent=2)
            baseline_file.write("\n")
    else:
        try:
            with open(baseline_path, "r", encoding="utf-8") as baseline_file:
                baseline = json.load(baseline_file)
        except (OSError, ValueError):
            fail("AVATAR_SILHOUETTE_BASELINE_INVALID")
        compare_baseline(data, baseline)
    render_clay_reviews(scene, output_directory)
    print("BODY_HIGH_MEASUREMENTS=" + json.dumps(measurements, sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--write-baseline", action="store_true")
    arguments = parser.parse_args(blender_arguments())
    try:
        validate_silhouette(
            os.path.abspath(arguments.baseline),
            os.path.abspath(arguments.output_dir),
            write_baseline=arguments.write_baseline,
        )
    except SilhouetteValidationError as error:
        print(str(error), file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
