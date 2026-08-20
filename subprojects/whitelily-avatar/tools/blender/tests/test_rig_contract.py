"""Behavior contract for the WhiteLily humanoid production rig."""

import json
import os
import unittest

import bpy


AVATAR_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
CONTRACT_PATH = os.path.join(
    AVATAR_ROOT, "assets", "rig", "whitelily-humanoid-v1.json"
)
BLENDER_TOOLS_DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BLENDER_TOOLS_DIRECTORY not in os.sys.path:
    os.sys.path.insert(0, BLENDER_TOOLS_DIRECTORY)

from validate_rig import validate_rig


def load_contract():
    with open(CONTRACT_PATH, "r", encoding="utf-8") as contract_file:
        return json.load(contract_file)


class RigContractTest(unittest.TestCase):
    def pose_points(self, pose_id, *bone_names):
        rig = bpy.data.objects["RIG_WhiteLily"]
        rig.animation_data_create()
        rig.animation_data.action = bpy.data.actions[f"POSE_PREVIEW.{pose_id}"]
        bpy.context.scene.frame_set(1)
        bpy.context.view_layer.update()
        return {
            name: rig.pose.bones[name].matrix.translation.copy()
            for name in bone_names
        }

    def tearDown(self):
        rig = bpy.data.objects.get("RIG_WhiteLily")
        if rig is not None and rig.animation_data is not None:
            rig.animation_data.action = None
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
