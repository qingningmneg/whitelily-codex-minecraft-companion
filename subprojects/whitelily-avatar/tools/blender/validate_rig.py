"""Validate and render the contract-driven WhiteLily humanoid rig stage."""

import argparse
from array import array
import colorsys
import json
import math
import os
import shutil
import sys

import bpy
from mathutils import Vector


SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, SCRIPT_DIRECTORY)

from validate_blender_version import validate_blender_version


AVATAR_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIRECTORY))
DEFAULT_CONTRACT_PATH = os.path.join(
    AVATAR_ROOT, "assets", "rig", "whitelily-humanoid-v1.json"
)
PREVIEW_RESOLUTION = 768
VISIBLE_COLLECTIONS = ("BODY_HIGH", "OUTFIT_BASE")


class RigValidationError(RuntimeError):
    pass


def fail(code):
    raise RigValidationError(code)


def blender_arguments():
    arguments = sys.argv
    return arguments[arguments.index("--") + 1 :] if "--" in arguments else []


def load_contract(contract_path=DEFAULT_CONTRACT_PATH):
    try:
        with open(contract_path, "r", encoding="utf-8") as contract_file:
            contract = json.load(contract_file)
    except (OSError, ValueError):
        fail("AVATAR_RIG_CONTRACT_INVALID")
    if (
        contract.get("schemaVersion") != 1
        or contract.get("id") != "whitelily-humanoid-v1"
        or contract.get("armature") != "RIG_WhiteLily"
    ):
        fail("AVATAR_RIG_CONTRACT_INVALID")
    bones = contract.get("bones")
    semantic_bones = contract.get("semanticBones")
    if not isinstance(bones, list) or not isinstance(semantic_bones, list):
        fail("AVATAR_RIG_CONTRACT_INVALID")
    names = [bone.get("name") for bone in bones]
    if (
        any(not isinstance(name, str) or not name for name in names)
        or len(names) != len(set(names))
        or len(names) > contract["limits"]["maximumJoints"]
        or [bone["name"] for bone in bones if bone.get("role") == "semantic"]
        != semantic_bones
    ):
        fail("AVATAR_RIG_CONTRACT_INVALID")
    known = set(names)
    for bone in bones:
        if bone.get("parent") is not None and bone["parent"] not in known:
            fail("AVATAR_RIG_CONTRACT_INVALID")
        if bone.get("role") == "secondary" and not bone["name"].startswith("secondary."):
            fail("AVATAR_RIG_CONTRACT_INVALID")
        if bone.get("role") == "attachment" and bone["name"] not in {
            "heldItemL",
            "heldItemR",
        } and not bone["name"].startswith("attachment."):
            fail("AVATAR_RIG_CONTRACT_INVALID")
    if set(contract.get("attachments", {})) != {"heldItemL", "heldItemR"}:
        fail("AVATAR_RIG_CONTRACT_INVALID")
    if [pose.get("id") for pose in contract.get("poses", [])] != [
        "t-pose",
        "a-pose",
        "arms-forward",
        "bent-elbow-pickaxe",
        "deep-stride",
        "swimming-stretch",
        "side-sleep",
    ]:
        fail("AVATAR_RIG_CONTRACT_INVALID")
    return contract


def visible_meshes():
    objects = {}
    for collection_name in VISIBLE_COLLECTIONS:
        collection = bpy.data.collections.get(collection_name)
        if collection is None:
            fail("AVATAR_RIG_VISIBLE_COLLECTION_MISSING")
        for object_ in collection.all_objects:
            if object_.type == "MESH":
                objects[object_.as_pointer()] = object_
    return tuple(objects.values())


def validate_armature(contract):
    rig = bpy.data.objects.get(contract["armature"])
    if rig is None or rig.type != "ARMATURE" or bpy.data.collections.get("RIG") not in rig.users_collection:
        fail("AVATAR_RIG_ARMATURE_MISSING")
    specifications = {bone["name"]: bone for bone in contract["bones"]}
    if {bone.name for bone in rig.data.bones} != set(specifications):
        fail("AVATAR_RIG_BONE_SET_INVALID")
    for bone in rig.data.bones:
        specification = specifications[bone.name]
        parent = bone.parent.name if bone.parent is not None else None
        if parent != specification["parent"]:
            fail("AVATAR_RIG_HIERARCHY_INVALID")
        if bone.use_deform != specification["deform"]:
            fail("AVATAR_RIG_DEFORM_ROLE_INVALID")
        if (bone.head_local - Vector(specification["head"])).length > 1e-5:
            fail("AVATAR_RIG_BIND_POSE_INVALID")
        if (bone.tail_local - Vector(specification["tail"])).length > 1e-5:
            fail("AVATAR_RIG_BIND_POSE_INVALID")
    return rig


def is_generated_duplicate(group_name, expected_bones):
    return any(
        group_name.startswith(expected + ".")
        and group_name[len(expected) + 1 :].isdigit()
        for expected in expected_bones
    )


def validate_skinning(contract, rig):
    expected_bones = {bone["name"] for bone in contract["bones"]}
    limit = contract["limits"]["maximumWeightsPerVertex"]
    tolerance = contract["limits"]["weightSumTolerance"]
    maximum_influences = 0
    vertex_count = 0
    unweighted_count = 0
    non_normalized_count = 0
    weighted_meshes = 0
    for object_ in visible_meshes():
        modifiers = [
            modifier
            for modifier in object_.modifiers
            if modifier.type == "ARMATURE" and modifier.object == rig
        ]
        if len(modifiers) != 1:
            fail("AVATAR_RIG_SKIN_BINDING_INVALID")
        group_names = {group.index: group.name for group in object_.vertex_groups}
        for group in object_.vertex_groups:
            reserved_unknown = group.name.startswith(
                ("secondary.", "attachment.", "heldItem")
            ) and group.name not in expected_bones
            if reserved_unknown or is_generated_duplicate(group.name, expected_bones):
                fail("AVATAR_RIG_VERTEX_GROUP_INVALID")
        weighted_meshes += 1
        for vertex in object_.data.vertices:
            vertex_count += 1
            weights = [
                membership.weight
                for membership in vertex.groups
                if group_names.get(membership.group) in expected_bones
                and membership.weight > 1e-8
            ]
            maximum_influences = max(maximum_influences, len(weights))
            if not weights:
                unweighted_count += 1
            elif abs(sum(weights) - 1.0) > tolerance:
                non_normalized_count += 1
    if maximum_influences > limit:
        fail("AVATAR_RIG_WEIGHT_INFLUENCE_LIMIT_EXCEEDED")
    if unweighted_count:
        fail("AVATAR_RIG_UNWEIGHTED_VERTICES")
    if non_normalized_count:
        fail("AVATAR_RIG_NON_NORMALIZED_WEIGHTS")
    return {
        "meshCount": weighted_meshes,
        "vertexCount": vertex_count,
        "maximumInfluencesPerVertex": maximum_influences,
        "unweightedVertexCount": unweighted_count,
        "nonNormalizedVertexCount": non_normalized_count,
    }


def palm_center(object_name):
    object_ = bpy.data.objects.get(object_name)
    if object_ is None or object_.type != "MESH":
        fail("AVATAR_RIG_HAND_MISSING")
    corners = [object_.matrix_world @ Vector(corner) for corner in object_.bound_box]
    return Vector(
        tuple(
            (min(point[axis] for point in corners) + max(point[axis] for point in corners)) * 0.5
            for axis in range(3)
        )
    )


def validate_attachments(contract, rig):
    specifications = {bone["name"]: bone for bone in contract["bones"]}
    axes = {}
    for suffix, held_name, hand_name in (
        ("L", "heldItemL", "HandL"),
        ("R", "heldItemR", "HandR"),
    ):
        bone = rig.data.bones[held_name]
        if (bone.head_local - palm_center(hand_name)).length > 0.005:
            fail("AVATAR_RIG_HELD_ITEM_ORIGIN_INVALID")
        axis_y = bone.matrix_local.col[1].to_3d().normalized()
        axis_z = bone.matrix_local.col[2].to_3d().normalized()
        hand_bone = rig.data.bones[f"{'left' if suffix == 'L' else 'right'}Hand"]
        hand_axis_y = hand_bone.matrix_local.col[1].to_3d().normalized()
        if axis_y.dot(hand_axis_y) < 0.995:
            fail("AVATAR_RIG_HELD_ITEM_FORWARD_AXIS_INVALID")
        requested_back = Vector(specifications[held_name]["rollAxisWorld"])
        requested_back -= axis_y * requested_back.dot(axis_y)
        requested_back.normalize()
        if axis_z.dot(requested_back) < 0.995:
            fail("AVATAR_RIG_HELD_ITEM_BACK_AXIS_INVALID")
        axes[suffix] = (axis_y, axis_z, bone.head_local.copy())

    left_y, left_z, left_head = axes["L"]
    right_y, right_z, right_head = axes["R"]
    if (
        abs(left_head.x + right_head.x) > 1e-5
        or abs(left_head.y - right_head.y) > 1e-5
        or abs(left_head.z - right_head.z) > 1e-5
        or abs(left_y.x + right_y.x) > 1e-4
        or abs(left_y.y - right_y.y) > 1e-4
        or abs(left_y.z - right_y.z) > 1e-4
        or abs(left_z.x + right_z.x) > 1e-4
        or abs(left_z.y - right_z.y) > 1e-4
        or abs(left_z.z - right_z.z) > 1e-4
    ):
        fail("AVATAR_RIG_HELD_ITEM_MIRROR_INVALID")

    checks = 0
    proxies = contract.get("itemProxies", [])
    if {proxy.get("id") for proxy in proxies} != {"sword", "pickaxe", "fishingRod", "bread"}:
        fail("AVATAR_RIG_ITEM_PROXY_INVALID")
    for held_name in ("heldItemL", "heldItemR"):
        clearance = contract["attachments"][held_name]["palmClearanceMeters"]
        for proxy in proxies:
            center = proxy.get("center")
            half_extents = proxy.get("halfExtents")
            if (
                proxy.get("longAxis") != "+Y"
                or not isinstance(center, list)
                or not isinstance(half_extents, list)
                or len(center) != 3
                or len(half_extents) != 3
                or center[1] - half_extents[1] < clearance
                or any(extent <= 0.0 for extent in half_extents)
            ):
                fail("AVATAR_RIG_ITEM_PROXY_INVALID")
            checks += 1
    runtime_attachments = contract.get("runtimeManifest", {}).get("attachmentBones", {})
    if runtime_attachments.get("leftHeldItem") != "heldItemL" or runtime_attachments.get("rightHeldItem") != "heldItemR":
        fail("AVATAR_RIG_RUNTIME_ATTACHMENT_INVALID")
    return checks


def evaluated_world_points(object_, depsgraph):
    evaluated = object_.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=depsgraph)
    try:
        return [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
    finally:
        evaluated.to_mesh_clear()


def point_bounds(points):
    if not points:
        fail("AVATAR_RIG_DEFORMATION_INVALID")
    return tuple(
        (min(point[axis] for point in points), max(point[axis] for point in points))
        for axis in range(3)
    )


def bounds_diagonal(bounds):
    return math.sqrt(sum((high - low) ** 2 for low, high in bounds))


def validate_pose_actions(contract, rig, scene):
    expected = {f"POSE_PREVIEW.{pose['id']}" for pose in contract["poses"]}
    actual = {action.name for action in bpy.data.actions if action.name.startswith("POSE_PREVIEW.")}
    if actual != expected:
        fail("AVATAR_RIG_POSE_SET_INVALID")
    if rig.animation_data is None:
        fail("AVATAR_RIG_POSE_SET_INVALID")
    for pose in contract["poses"]:
        for rotation in pose["rotations"].values():
            if rotation.get("axis") not in {"X", "Y", "Z"} or abs(rotation.get("degrees", 999.0)) > 90.0:
                fail("AVATAR_RIG_POSE_LIMIT_INVALID")

    tracked_names = (
        "ArmL", "ArmR", "HandL", "HandR", "ThighL", "ThighR",
        "ShinL", "ShinR", "FootL", "FootR", "SleeveL", "SleeveR",
    )
    rig.animation_data.action = None
    scene.frame_set(1)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    rest_diagonals = {
        name: bounds_diagonal(point_bounds(evaluated_world_points(bpy.data.objects[name], depsgraph)))
        for name in tracked_names
    }
    maximum_extent = 0.0
    pose_bounds = {}
    for pose in contract["poses"]:
        action = bpy.data.actions[f"POSE_PREVIEW.{pose['id']}"]
        rig.animation_data.action = action
        scene.frame_set(1)
        bpy.context.view_layer.update()
        for bone_name, rotation in pose["rotations"].items():
            axis = {"X": 0, "Y": 1, "Z": 2}[rotation["axis"]]
            actual_degrees = math.degrees(rig.pose.bones[bone_name].rotation_euler[axis])
            if abs(actual_degrees - rotation["degrees"]) > 1e-3:
                fail("AVATAR_RIG_POSE_ACTION_INVALID")
        depsgraph = bpy.context.evaluated_depsgraph_get()
        all_points = []
        for object_ in visible_meshes():
            points = evaluated_world_points(object_, depsgraph)
            if any(not all(math.isfinite(value) for value in point) for point in points):
                fail("AVATAR_RIG_DEFORMATION_INVALID")
            all_points.extend(points)
            if object_.name in rest_diagonals:
                diagonal = bounds_diagonal(point_bounds(points))
                if diagonal < rest_diagonals[object_.name] * 0.55:
                    fail("AVATAR_RIG_JOINT_COLLAPSE_DETECTED")
        bounds = point_bounds(all_points)
        dimensions = [high - low for low, high in bounds]
        maximum_extent = max(maximum_extent, *dimensions)
        if maximum_extent > 3.0:
            fail("AVATAR_RIG_DEFORMATION_INVALID")
        pose_bounds[pose["id"]] = [[round(low, 5), round(high, 5)] for low, high in bounds]
    rig.animation_data.action = None
    scene.frame_set(1)
    bpy.context.view_layer.update()
    return pose_bounds, maximum_extent


def validate_correctives(rig):
    corrective_count = 0
    for object_ in visible_meshes():
        shape_keys = object_.data.shape_keys
        if shape_keys is None:
            continue
        for key_block in shape_keys.key_blocks:
            if not key_block.name.startswith("corrective."):
                continue
            corrective_count += 1
            if shape_keys.animation_data is None or not shape_keys.animation_data.drivers:
                fail("AVATAR_RIG_CORRECTIVE_DRIVER_MISSING")
    return corrective_count


def evaluated_triangle_count():
    depsgraph = bpy.context.evaluated_depsgraph_get()
    total = 0
    for object_ in visible_meshes():
        evaluated = object_.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=depsgraph)
        try:
            total += sum(max(0, len(polygon.vertices) - 2) for polygon in mesh.polygons)
        finally:
            evaluated.to_mesh_clear()
    return total


def validate_rig(scene, contract_path=DEFAULT_CONTRACT_PATH):
    contract = load_contract(contract_path)
    if scene.get("AVATAR_ART_STAGE") != "body-high":
        fail("AVATAR_RIG_BODY_HIGH_SOURCE_INVALID")
    if contract["limits"].get("maximumPersistentClippingFrames") != 15:
        fail("AVATAR_RIG_CLIPPING_LIMIT_INVALID")
    rig = validate_armature(contract)
    metrics = validate_skinning(contract, rig)
    metrics.update(
        {
            "boneCount": len(rig.data.bones),
            "heldItemProxyChecks": validate_attachments(contract, rig),
            "correctiveShapeKeyCount": validate_correctives(rig),
        }
    )
    pose_bounds, maximum_extent = validate_pose_actions(contract, rig, scene)
    metrics.update(
        {
            "posePreviewCount": len(pose_bounds),
            "poseBounds": pose_bounds,
            "maximumPoseExtentMeters": round(maximum_extent, 6),
            "triangleCount": evaluated_triangle_count(),
        }
    )
    if metrics["triangleCount"] != 81044:
        fail("AVATAR_RIG_BODY_HIGH_TRIANGLE_REGRESSION")
    return metrics


def configure_render(scene):
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = PREVIEW_RESOLUTION
    scene.render.resolution_y = PREVIEW_RESOLUTION
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.world.color = (0.025, 0.03, 0.04)


def render_bounds():
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    for object_ in visible_meshes():
        points.extend(evaluated_world_points(object_, depsgraph))
    return point_bounds(points)


def fit_camera(camera, bounds, view):
    center = Vector(tuple((low + high) * 0.5 for low, high in bounds))
    dimensions = [high - low for low, high in bounds]
    if view == "front":
        camera.location = (center.x, bounds[1][0] - 4.0, center.z)
        camera.rotation_euler = (math.pi * 0.5, 0.0, 0.0)
        camera.data.ortho_scale = max(dimensions[0], dimensions[2]) * 1.15
    else:
        camera.location = (bounds[0][1] + 4.0, center.y, center.z)
        camera.rotation_euler = (math.pi * 0.5, 0.0, math.pi * 0.5)
        camera.data.ortho_scale = max(dimensions[1], dimensions[2]) * 1.15


def render_view(scene, camera, filepath):
    scene.camera = camera
    scene.render.filepath = filepath
    bpy.ops.render.render(write_still=True)


def create_weight_material(expected_bones):
    material = bpy.data.materials.get("WhiteLilyRigWeightHeat") or bpy.data.materials.new(
        "WhiteLilyRigWeightHeat"
    )
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    vertex_color = nodes.new("ShaderNodeVertexColor")
    vertex_color.layer_name = "RigWeightHeat"
    material.node_tree.links.new(vertex_color.outputs["Color"], principled.inputs["Base Color"])
    material.node_tree.links.new(vertex_color.outputs["Color"], principled.inputs["Emission Color"])
    principled.inputs["Emission Strength"].default_value = 0.35
    principled.inputs["Roughness"].default_value = 0.62
    material.node_tree.links.new(principled.outputs["BSDF"], output.inputs["Surface"])

    palette = {}
    for index, name in enumerate(sorted(expected_bones)):
        hue = (index * 0.61803398875) % 1.0
        palette[name] = colorsys.hsv_to_rgb(hue, 0.78, 0.96)
    for object_ in visible_meshes():
        attribute = object_.data.color_attributes.get("RigWeightHeat")
        if attribute is None:
            attribute = object_.data.color_attributes.new(
                name="RigWeightHeat", type="FLOAT_COLOR", domain="POINT"
            )
        group_names = {group.index: group.name for group in object_.vertex_groups}
        for vertex in object_.data.vertices:
            color = [0.0, 0.0, 0.0]
            for membership in vertex.groups:
                name = group_names.get(membership.group)
                if name not in palette:
                    continue
                for channel in range(3):
                    color[channel] += palette[name][channel] * membership.weight
            attribute.data[vertex.index].color = (*color, 1.0)
    return material


def create_contact_sheet(input_paths, output_path):
    sources = [bpy.data.images.load(path, check_existing=False) for path in input_paths]
    try:
        sheet_width = PREVIEW_RESOLUTION * len(sources)
        sheet_height = PREVIEW_RESOLUTION
        sheet_pixels = array("f", [0.0]) * (sheet_width * sheet_height * 4)
        for index, source in enumerate(sources):
            source_pixels = array("f", [0.0]) * (PREVIEW_RESOLUTION * PREVIEW_RESOLUTION * 4)
            source.pixels.foreach_get(source_pixels)
            for y in range(PREVIEW_RESOLUTION):
                source_start = y * PREVIEW_RESOLUTION * 4
                target_start = (y * sheet_width + index * PREVIEW_RESOLUTION) * 4
                sheet_pixels[target_start : target_start + PREVIEW_RESOLUTION * 4] = source_pixels[
                    source_start : source_start + PREVIEW_RESOLUTION * 4
                ]
        sheet = bpy.data.images.new(
            "WhiteLilyRigPoseContactSheet", width=sheet_width, height=sheet_height, alpha=True
        )
        sheet.pixels.foreach_set(sheet_pixels)
        sheet.filepath_raw = output_path
        sheet.file_format = "PNG"
        sheet.save()
        bpy.data.images.remove(sheet)
    finally:
        for source in sources:
            bpy.data.images.remove(source)


def render_pose_previews(scene, contract, output_directory):
    if os.path.isdir(output_directory):
        shutil.rmtree(output_directory)
    panel_directory = os.path.join(output_directory, "panels")
    os.makedirs(panel_directory, exist_ok=True)
    configure_render(scene)
    rig = bpy.data.objects[contract["armature"]]
    rig.animation_data_create()
    front_camera = bpy.data.objects["CAM_FRONT"]
    side_camera = bpy.data.objects["CAM_RIGHT"]
    original_materials = {
        object_.as_pointer(): list(object_.data.materials) for object_ in visible_meshes()
    }
    heat_material = create_weight_material({bone["name"] for bone in contract["bones"]})
    outputs = []
    for pose in contract["poses"]:
        rig.animation_data.action = bpy.data.actions[f"POSE_PREVIEW.{pose['id']}"]
        scene.frame_set(1)
        bpy.context.view_layer.update()
        for object_ in visible_meshes():
            object_.data.materials.clear()
            for material in original_materials[object_.as_pointer()]:
                object_.data.materials.append(material)
        bounds = render_bounds()
        pose_panel_directory = os.path.join(panel_directory, pose["id"])
        os.makedirs(pose_panel_directory, exist_ok=True)
        front_path = os.path.join(pose_panel_directory, "front.png")
        side_path = os.path.join(pose_panel_directory, "side.png")
        weights_path = os.path.join(pose_panel_directory, "weights.png")
        fit_camera(front_camera, bounds, "front")
        render_view(scene, front_camera, front_path)
        fit_camera(side_camera, bounds, "side")
        render_view(scene, side_camera, side_path)
        for object_ in visible_meshes():
            object_.data.materials.clear()
            object_.data.materials.append(heat_material)
        fit_camera(front_camera, bounds, "front")
        render_view(scene, front_camera, weights_path)
        output_path = os.path.join(output_directory, pose["id"] + ".png")
        create_contact_sheet((front_path, side_path, weights_path), output_path)
        outputs.append(output_path)
    rig.animation_data.action = None
    scene.frame_set(1)
    return outputs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", default=DEFAULT_CONTRACT_PATH)
    parser.add_argument("--output-dir")
    parser.add_argument("--render-previews", action="store_true")
    arguments = parser.parse_args(blender_arguments())
    try:
        validate_blender_version()
        contract_path = os.path.abspath(arguments.contract)
        metrics = validate_rig(bpy.context.scene, contract_path)
        if arguments.render_previews:
            if not arguments.output_dir:
                fail("AVATAR_RIG_PREVIEW_OUTPUT_MISSING")
            outputs = render_pose_previews(
                bpy.context.scene, load_contract(contract_path), os.path.abspath(arguments.output_dir)
            )
            metrics["previewPaths"] = outputs
            with open(
                os.path.join(os.path.abspath(arguments.output_dir), "rig-metrics.json"),
                "w",
                encoding="utf-8",
            ) as metrics_file:
                json.dump(metrics, metrics_file, ensure_ascii=False, indent=2)
                metrics_file.write("\n")
        print("RIG_METRICS=" + json.dumps(metrics, sort_keys=True))
    except RigValidationError as error:
        print(str(error), file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
