"""Behavior contract for the WhiteLily humanoid production rig."""

import copy
import json
import math
import os
import tempfile
import unittest

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector


AVATAR_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
CONTRACT_PATH = os.path.join(
    AVATAR_ROOT, "assets", "rig", "whitelily-humanoid-v1.json"
)
BLENDER_TOOLS_DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BLENDER_TOOLS_DIRECTORY not in os.sys.path:
    os.sys.path.insert(0, BLENDER_TOOLS_DIRECTORY)

import validate_rig as rig_validator

validate_rig = rig_validator.validate_rig


def load_contract():
    with open(CONTRACT_PATH, "r", encoding="utf-8") as contract_file:
        return json.load(contract_file)


class RigContractTest(unittest.TestCase):
    def test_attachment_proxies_query_evaluated_hand_surfaces_on_both_sides(self):
        contract = load_contract()
        intersecting = copy.deepcopy(contract["itemProxies"][0])
        intersecting["id"] = "intentionalHandIntersection"
        intersecting["center"] = [0.0, 0.0, 0.0]
        intersecting["halfExtents"] = [0.04, 0.04, 0.04]
        rig = bpy.data.objects[contract["armature"]]
        for held_name in ("heldItemL", "heldItemR"):
            with self.subTest(held_name=held_name):
                with self.assertRaisesRegex(
                    rig_validator.RigValidationError,
                    "AVATAR_RIG_ITEM_PROXY_HAND_INTERSECTION",
                ):
                    rig_validator.validate_attachment_proxy_surfaces(
                        bpy.context.scene,
                        contract,
                        rig,
                        proxies=(intersecting,),
                        attachment_names=(held_name,),
                    )

    def test_full_rig_validation_rejects_evaluated_item_proxy_hand_intersection(self):
        contract = load_contract()
        for held_name in ("heldItemL", "heldItemR"):
            contract["attachments"][held_name]["palmClearanceMeters"] = -1.0
        contract["itemProxies"][0]["center"] = [0.0, 0.0, 0.0]
        contract["itemProxies"][0]["halfExtents"] = [0.04, 0.04, 0.04]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", encoding="utf-8", delete=False
        ) as contract_file:
            json.dump(contract, contract_file)
            contract_path = contract_file.name
        try:
            with self.assertRaisesRegex(
                rig_validator.RigValidationError,
                "AVATAR_RIG_ITEM_PROXY_HAND_INTERSECTION",
            ):
                validate_rig(bpy.context.scene, contract_path)
        finally:
            os.unlink(contract_path)

    def test_saved_pose_actions_include_transition_and_hold_frames(self):
        contract = load_contract()
        for pose in contract["poses"]:
            action = bpy.data.actions[f"POSE_PREVIEW.{pose['id']}"]
            self.assertEqual(tuple(action.frame_range), (1.0, 31.0))
            for bone_name, rotation in pose["rotations"].items():
                axis = {"X": 0, "Y": 1, "Z": 2}[rotation["axis"]]
                data_path = f'pose.bones["{bone_name}"].rotation_euler'
                curve = next(
                    curve
                    for curve in action.fcurves
                    if curve.data_path == data_path and curve.array_index == axis
                )
                expected = math.radians(rotation["degrees"])
                self.assertAlmostEqual(curve.evaluate(1.0), 0.0, delta=1e-6)
                self.assertAlmostEqual(curve.evaluate(16.0), expected, delta=1e-6)
                self.assertAlmostEqual(curve.evaluate(31.0), expected, delta=1e-6)

    def test_full_rig_validation_rejects_pose_location_contract_mismatch(self):
        contract = load_contract()
        deep_stride = next(
            pose for pose in contract["poses"] if pose["id"] == "deep-stride"
        )
        deep_stride["locations"] = {
            "secondary.skirt.outer.L": [0.0, 0.0, 0.14]
        }
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", encoding="utf-8", delete=False
        ) as contract_file:
            json.dump(contract, contract_file)
            contract_path = contract_file.name
        try:
            with self.assertRaisesRegex(
                rig_validator.RigValidationError,
                "AVATAR_RIG_POSE_ACTION_INVALID",
            ):
                validate_rig(bpy.context.scene, contract_path)
        finally:
            os.unlink(contract_path)

    def test_full_rig_validation_rejects_more_than_fifteen_clipping_frames(self):
        vertices = (
            (-0.1, -0.1, -0.1),
            (0.1, -0.1, -0.1),
            (0.1, 0.1, -0.1),
            (-0.1, 0.1, -0.1),
            (-0.1, -0.1, 0.1),
            (0.1, -0.1, 0.1),
            (0.1, 0.1, 0.1),
            (-0.1, 0.1, 0.1),
        )
        faces = (
            (0, 3, 2, 1),
            (4, 5, 6, 7),
            (0, 1, 5, 4),
            (1, 2, 6, 5),
            (2, 3, 7, 6),
            (3, 0, 4, 7),
        )
        objects = []
        meshes = []
        for name in ("IntentionalClipA", "IntentionalClipB"):
            mesh = bpy.data.meshes.new(name)
            mesh.from_pydata(vertices, [], faces)
            object_ = bpy.data.objects.new(name, mesh)
            object_.hide_render = True
            bpy.context.scene.collection.objects.link(object_)
            meshes.append(mesh)
            objects.append(object_)
        moving = objects[1]
        for frame, x in ((1, 1.0), (16, 1.0), (17, 0.0), (31, 0.0)):
            moving.location.x = x
            moving.keyframe_insert(data_path="location", frame=frame)
        for curve in moving.animation_data.action.fcurves:
            for point in curve.keyframe_points:
                point.interpolation = "CONSTANT"
        contract = load_contract()
        contract["poseClippingChecks"] = [
            {
                "pose": "t-pose",
                "pairs": [["IntentionalClipA", "IntentionalClipB"]],
            }
        ]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", encoding="utf-8", delete=False
        ) as contract_file:
            json.dump(contract, contract_file)
            contract_path = contract_file.name
        try:
            validate_rig(bpy.context.scene, contract_path)
            rig = bpy.data.objects[contract["armature"]]
            rig.animation_data.action = None
            for pose_bone in rig.pose.bones:
                pose_bone.rotation_mode = "XYZ"
                pose_bone.rotation_euler = (0.0, 0.0, 0.0)
                pose_bone.location = (0.0, 0.0, 0.0)
            bpy.context.scene.frame_set(1)
            bpy.context.view_layer.update()
            moving.location.x = 0.0
            moving.keyframe_insert(data_path="location", frame=16)
            with self.assertRaisesRegex(
                rig_validator.RigValidationError,
                "AVATAR_RIG_PERSISTENT_CLIPPING",
            ):
                validate_rig(bpy.context.scene, contract_path)
        finally:
            os.unlink(contract_path)
            for object_ in objects:
                bpy.data.objects.remove(object_, do_unlink=True)
            for mesh in meshes:
                bpy.data.meshes.remove(mesh)

    def test_scene_wide_render_visible_meshes_require_contract_coverage(self):
        mesh = bpy.data.meshes.new("ReviewUncoveredMesh")
        mesh.from_pydata(
            [(3.0, 0.0, 0.0), (3.1, 0.0, 0.0), (3.0, 0.1, 0.0)],
            [],
            [(0, 1, 2)],
        )
        object_ = bpy.data.objects.new("ReviewUncoveredMesh", mesh)
        bpy.context.scene.collection.objects.link(object_)
        try:
            with self.assertRaisesRegex(
                rig_validator.RigValidationError,
                "AVATAR_RIG_VISIBLE_MESH_UNCOVERED",
            ):
                validate_rig(bpy.context.scene, CONTRACT_PATH)
        finally:
            bpy.data.objects.remove(object_, do_unlink=True)
            bpy.data.meshes.remove(mesh)

    def test_pickaxe_review_proxy_connects_both_evaluated_grips(self):
        self.assertTrue(hasattr(rig_validator, "ensure_pickaxe_proxy"))
        shaft, head = rig_validator.ensure_pickaxe_proxy()
        self.assertIsNotNone(shaft, "rendered pickaxe shaft proxy is missing")
        self.assertIsNotNone(head, "rendered pickaxe head proxy is missing")
        rig = bpy.data.objects["RIG_WhiteLily"]
        rig.animation_data.action = bpy.data.actions[
            "POSE_PREVIEW.bent-elbow-pickaxe"
        ]
        bpy.context.scene.frame_set(31)
        bpy.context.view_layer.update()
        rig_validator.position_pickaxe_proxy(rig, shaft, head)
        self.assertFalse(shaft.hide_render)
        self.assertFalse(head.hide_render)
        inverse = shaft.matrix_world.inverted()
        local_bounds = [inverse @ (shaft.matrix_world @ Vector(corner)) for corner in shaft.bound_box]
        minimum_y = min(point.y for point in local_bounds)
        maximum_y = max(point.y for point in local_bounds)
        grip_points = [
            rig.matrix_world @ rig.pose.bones[name].matrix.translation
            for name in ("heldItemL", "heldItemR")
        ]
        for point in grip_points:
            local = inverse @ point
            self.assertLess(abs(local.x), 0.025)
            self.assertLess(abs(local.z), 0.025)
            self.assertLessEqual(minimum_y, local.y)
            self.assertGreaterEqual(maximum_y, local.y)

    def test_pickaxe_pose_avoids_cross_sleeve_surface_intersection(self):
        rig = bpy.data.objects["RIG_WhiteLily"]
        rig.animation_data.action = bpy.data.actions[
            "POSE_PREVIEW.bent-elbow-pickaxe"
        ]
        maximum = rig_validator.maximum_consecutive_clipping_frames(
            bpy.context.scene, (("SleeveL", "SleeveR"),), (31,)
        )
        self.assertEqual(maximum, [0])

    def test_deep_stride_stays_within_rest_derived_leg_skirt_contact_gates(self):
        rig = bpy.data.objects["RIG_WhiteLily"]
        pairs = tuple(
            (leg, skirt)
            for leg in ("ThighL", "ThighR", "ShinL", "ShinR")
            for skirt in ("SkirtInner", "SkirtOuter")
        )

        def intersection_counts():
            depsgraph = bpy.context.evaluated_depsgraph_get()
            trees = {
                name: rig_validator.evaluated_bvh(bpy.data.objects[name], depsgraph)
                for pair in pairs
                for name in pair
            }
            return [
                len(trees[first].overlap(trees[second]))
                for first, second in pairs
            ]

        rig.animation_data.action = None
        bpy.context.scene.frame_set(1)
        bpy.context.view_layer.update()
        rest = intersection_counts()
        rig.animation_data.action = bpy.data.actions["POSE_PREVIEW.deep-stride"]
        bpy.context.scene.frame_set(31)
        bpy.context.view_layer.update()
        posed = intersection_counts()
        self.assertLessEqual(posed[0], rest[0])
        self.assertEqual(posed[1], 0)
        self.assertLessEqual(posed[2], rest[2])
        right_outer_gate = math.floor(
            len(bpy.data.objects["ThighR"].data.polygons) * 0.05
        )
        self.assertLessEqual(posed[3], right_outer_gate)
        self.assertEqual(posed[4:], [0, 0, 0, 0])

    def test_side_sleep_side_camera_is_pose_local_and_readable(self):
        scene = bpy.context.scene
        rig = bpy.data.objects["RIG_WhiteLily"]
        rig.animation_data.action = bpy.data.actions["POSE_PREVIEW.side-sleep"]
        scene.frame_set(31)
        bpy.context.view_layer.update()
        camera = bpy.data.objects["CAM_RIGHT"]
        rig_validator.fit_camera(camera, rig_validator.render_bounds(), "side")
        hips = rig.matrix_world @ rig.pose.bones["hips"].matrix.translation
        head = rig.matrix_world @ rig.pose.bones["head"].matrix.translation
        body_axis = (head - hips).normalized()
        view_direction = (
            camera.matrix_world.to_quaternion() @ Vector((0.0, 0.0, -1.0))
        ).normalized()
        self.assertLess(abs(body_axis.dot(view_direction)), 0.2)
        hips_image = world_to_camera_view(scene, camera, hips)
        head_image = world_to_camera_view(scene, camera, head)
        projected_length = math.hypot(
            head_image.x - hips_image.x, head_image.y - hips_image.y
        )
        self.assertGreater(projected_length, 0.3)

    def pose_points(self, pose_id, *bone_names):
        rig = bpy.data.objects["RIG_WhiteLily"]
        rig.animation_data_create()
        rig.animation_data.action = bpy.data.actions[f"POSE_PREVIEW.{pose_id}"]
        bpy.context.scene.frame_set(31)
        bpy.context.view_layer.update()
        return {
            name: rig.pose.bones[name].matrix.translation.copy()
            for name in bone_names
        }

    def tearDown(self):
        rig = bpy.data.objects.get("RIG_WhiteLily")
        if rig is not None and rig.animation_data is not None:
            rig.animation_data.action = None
            for pose_bone in rig.pose.bones:
                pose_bone.rotation_mode = "XYZ"
                pose_bone.rotation_euler = (0.0, 0.0, 0.0)
                pose_bone.location = (0.0, 0.0, 0.0)
        bpy.context.scene.frame_set(1)
        bpy.context.view_layer.update()

    def test_saved_extreme_poses_have_the_required_physical_directions(self):
        t_pose = self.pose_points("t-pose", "leftHand", "rightHand")
        self.assertGreater(t_pose["leftHand"].x, 0.60)
        self.assertLess(t_pose["rightHand"].x, -0.60)
        self.assertAlmostEqual(t_pose["leftHand"].z, t_pose["rightHand"].z, delta=0.01)

        a_pose = self.pose_points("a-pose", "leftHand", "rightHand")
        self.assertLess(a_pose["leftHand"].z, 1.20)
        self.assertLess(a_pose["rightHand"].z, 1.20)

        forward = self.pose_points("arms-forward", "leftHand", "rightHand")
        self.assertLess(forward["leftHand"].y, -0.35)
        self.assertLess(forward["rightHand"].y, -0.35)

        pickaxe = self.pose_points("bent-elbow-pickaxe", "leftHand", "rightHand")
        self.assertLess(pickaxe["leftHand"].y, -0.15)
        self.assertLess(pickaxe["rightHand"].y, -0.15)
        self.assertLess(abs(pickaxe["leftHand"].x - pickaxe["rightHand"].x), 0.35)
        self.assertGreater((pickaxe["leftHand"] - pickaxe["rightHand"]).length, 0.08)

        stride = self.pose_points("deep-stride", "leftFoot", "rightFoot")
        self.assertGreater(abs(stride["leftFoot"].y - stride["rightFoot"].y), 0.60)

        swim = self.pose_points(
            "swimming-stretch", "leftHand", "rightHand", "leftFoot", "rightFoot"
        )
        self.assertLess(swim["leftHand"].y, -0.35)
        self.assertLess(swim["rightHand"].y, -0.35)
        self.assertGreater(swim["leftFoot"].y, 0.10)
        self.assertGreater(swim["rightFoot"].y, 0.10)

        sleep = self.pose_points("side-sleep", "hips", "head")
        self.assertGreater(abs(sleep["head"].x - sleep["hips"].x), 0.50)
        self.assertLess(abs(sleep["head"].z - sleep["hips"].z), 0.05)

    def test_public_contract_drives_full_rig_validation(self):
        contract = load_contract()
        self.assertEqual(
            [
                bone["name"]
                for bone in contract["bones"]
                if bone["role"] == "semantic"
            ],
            contract["semanticBones"],
        )
        metrics = validate_rig(bpy.context.scene, CONTRACT_PATH)
        self.assertEqual(metrics["boneCount"], len(contract["bones"]))
        self.assertEqual(metrics["posePreviewCount"], 7)
        self.assertEqual(metrics["heldItemProxyChecks"], 8)
        self.assertGreaterEqual(len(metrics["poseClippingChecks"]), 6)
        self.assertEqual(metrics["unweightedVertexCount"], 0)
        self.assertEqual(metrics["nonNormalizedVertexCount"], 0)
        self.assertLessEqual(metrics["maximumInfluencesPerVertex"], 4)

    def test_required_semantic_bones_and_weights(self):
        rig = bpy.data.objects.get("RIG_WhiteLily")
        self.assertIsNotNone(rig, "RIG_WhiteLily is missing")
        self.assertEqual(rig.type, "ARMATURE")

        contract = load_contract()
        expected_bones = {bone["name"] for bone in contract["bones"]}
        self.assertEqual({bone.name for bone in rig.data.bones}, expected_bones)

        parents = {
            bone.name: bone.parent.name if bone.parent is not None else None
            for bone in rig.data.bones
        }
        self.assertEqual(parents["head"], "neck")
        self.assertEqual(parents["neck"], "chest")
        self.assertEqual(parents["chest"], "spine")
        self.assertEqual(parents["spine"], "hips")

        maximum_influences = 0
        unweighted_vertices = []
        non_normalized_vertices = []
        unexpected_rig_groups = []
        for collection_name in ("BODY_HIGH", "OUTFIT_BASE"):
            collection = bpy.data.collections[collection_name]
            for object_ in collection.all_objects:
                if object_.type != "MESH":
                    continue
                group_names = {
                    group.index: group.name for group in object_.vertex_groups
                }
                for group in object_.vertex_groups:
                    generated_duplicate = any(
                        group.name.startswith(expected + ".")
                        and group.name[len(expected) + 1 :].isdigit()
                        for expected in expected_bones
                    )
                    reserved_unknown = group.name.startswith(
                        ("secondary.", "attachment.", "heldItem")
                    ) and group.name not in expected_bones
                    if generated_duplicate or reserved_unknown:
                        unexpected_rig_groups.append((object_.name, group.name))
                for vertex in object_.data.vertices:
                    weights = [
                        membership.weight
                        for membership in vertex.groups
                        if group_names.get(membership.group) in expected_bones
                        and membership.weight > 1e-8
                    ]
                    maximum_influences = max(maximum_influences, len(weights))
                    if not weights:
                        unweighted_vertices.append((object_.name, vertex.index))
                    elif abs(sum(weights) - 1.0) > 1e-4:
                        non_normalized_vertices.append(
                            (object_.name, vertex.index, sum(weights))
                        )

        self.assertLessEqual(maximum_influences, 4)
        self.assertEqual(unexpected_rig_groups, [])
        self.assertEqual(unweighted_vertices, [])
        self.assertEqual(non_normalized_vertices, [])


if __name__ == "__main__":
    unittest.main(argv=[__file__])
