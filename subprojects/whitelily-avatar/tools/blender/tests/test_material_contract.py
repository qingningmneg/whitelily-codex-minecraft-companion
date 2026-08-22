"""Behavior contract for the WhiteLily 2K atlas and cel material stage."""

import json
import os
import unittest
from array import array

import bpy


AVATAR_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
MATERIAL_NAMES = ("MAT_Face", "MAT_Eyes", "MAT_Hair", "MAT_Outfit")
ATLAS_IMAGES = ("whitelily-base-albedo.png", "whitelily-base-control.png")
VISIBLE_COLLECTIONS = ("BODY_HIGH", "OUTFIT_BASE")


def material_names():
    actual = {material.name for material in bpy.data.materials}
    return tuple(name for name in MATERIAL_NAMES if name in actual)


def has_node_group(material_name, group_name):
    material = bpy.data.materials[material_name]
    return any(
        node.type == "GROUP" and node.node_tree and node.node_tree.name == group_name
        for node in material.node_tree.nodes
    )


def has_basic_fallback(material_name):
    material = bpy.data.materials[material_name]
    fallback = material.node_tree.nodes.get("BasicFallback")
    return (
        material.get("whitelily_basic_fallback") is True
        and fallback is not None
        and fallback.type == "BSDF_PRINCIPLED"
        and fallback.inputs["Roughness"].default_value == 1.0
        and fallback.inputs["Metallic"].default_value == 0.0
    )


def visible_meshes():
    objects = {}
    for collection_name in VISIBLE_COLLECTIONS:
        for object_ in bpy.data.collections[collection_name].all_objects:
            if object_.type == "MESH" and not object_.hide_render:
                objects[object_.as_pointer()] = object_
    return tuple(objects.values())


class MaterialContractTest(unittest.TestCase):
    def test_materials_have_approved_cel_fallback(self):
        self.assertEqual({material.name for material in bpy.data.materials}, set(MATERIAL_NAMES))
        self.assertEqual(material_names(), MATERIAL_NAMES)
        self.assertTrue(
            all(has_node_group(name, "WhiteLilyCelV1") for name in MATERIAL_NAMES)
        )
        self.assertTrue(all(has_basic_fallback(name) for name in MATERIAL_NAMES))

    def test_cel_parameters_and_eye_highlight_are_authored_as_renderable_nodes(self):
        for name in MATERIAL_NAMES:
            material = bpy.data.materials[name]
            self.assertEqual(tuple(material["cel_shadow_thresholds"]), (0.35, 0.68))
            self.assertAlmostEqual(material["edge_highlight_strength"], 0.08)
            group = next(
                node
                for node in material.node_tree.nodes
                if node.type == "GROUP" and node.node_tree.name == "WhiteLilyCelV1"
            )
            self.assertIsNotNone(group.inputs.get("Albedo"))
            self.assertIsNotNone(group.inputs.get("Control"))
        eye = bpy.data.materials["MAT_Eyes"]
        self.assertTrue(eye["unshadowed_highlight_layer"])
        self.assertIsNotNone(eye.node_tree.nodes.get("EyeHighlightEmission"))

    def test_color_textures_are_exact_2k_packed_rgba_images(self):
        for name in ATLAS_IMAGES:
            image = bpy.data.images.get(name)
            self.assertIsNotNone(image, name)
            self.assertEqual(tuple(image.size), (2048, 2048))
            self.assertEqual(image.depth, 32)
            self.assertIsNotNone(image.packed_file)
        used_images = {
            node.image.name
            for material in bpy.data.materials
            for node in material.node_tree.nodes
            if node.type == "TEX_IMAGE" and node.image is not None
        }
        self.assertEqual(used_images, set(ATLAS_IMAGES))

    def test_iris_uvs_sample_a_readable_green_range(self):
        image = bpy.data.images["whitelily-base-albedo.png"]
        pixels = array("f", [0.0]) * len(image.pixels)
        image.pixels.foreach_get(pixels)
        green_advantages = []
        luminances = []
        for object_name in ("IrisL", "IrisR"):
            uv_layer = bpy.data.objects[object_name].data.uv_layers["WhiteLilyUV"]
            for loop in uv_layer.data:
                x = min(2047, max(0, round(loop.uv.x * 2047)))
                y = min(2047, max(0, round(loop.uv.y * 2047)))
                offset = (y * 2048 + x) * 4
                red, green, blue = pixels[offset : offset + 3]
                green_advantages.append(green - max(red, blue))
                luminances.append((red + green + blue) / 3.0)
        self.assertGreaterEqual(max(green_advantages), 0.08)
        self.assertGreaterEqual(max(luminances) - min(luminances), 0.12)

        eye_advantages = []
        eye_uv = bpy.data.objects["Eyes"].data.uv_layers["WhiteLilyUV"]
        for loop in eye_uv.data:
            x = min(2047, max(0, round(loop.uv.x * 2047)))
            y = min(2047, max(0, round(loop.uv.y * 2047)))
            offset = (y * 2048 + x) * 4
            red, green, blue = pixels[offset : offset + 3]
            eye_advantages.append(green - max(red, blue))
        self.assertGreaterEqual(sum(eye_advantages) / len(eye_advantages), 0.25)

    def test_visible_meshes_use_padded_non_overlapping_semantic_uv_regions(self):
        expected_bounds = {
            "face": (16, 1040, 496, 2032),
            "eyes": (528, 1040, 1008, 2032),
            "hair": (1040, 1040, 2032, 2032),
            "outfit": (16, 16, 2032, 1008),
        }
        covered = set()
        for object_ in visible_meshes():
            uv_layer = object_.data.uv_layers.get("WhiteLilyUV")
            self.assertIsNotNone(uv_layer, object_.name)
            region = object_.get("whitelily_uv_region")
            self.assertIn(region, expected_bounds, object_.name)
            covered.add(region)
            minimum_x, minimum_y, maximum_x, maximum_y = expected_bounds[region]
            for loop in uv_layer.data:
                pixel_x = loop.uv.x * 2048
                pixel_y = loop.uv.y * 2048
                self.assertGreaterEqual(pixel_x, minimum_x - 0.01)
                self.assertGreaterEqual(pixel_y, minimum_y - 0.01)
                self.assertLessEqual(pixel_x, maximum_x + 0.01)
                self.assertLessEqual(pixel_y, maximum_y + 0.01)
        self.assertEqual(covered, set(expected_bounds))

    def test_right_lily_and_asymmetric_gold_details_have_unique_uv_allocations(self):
        unique_objects = (
            "LilyHairpin",
            "LilyPetal01",
            "LilyPetal02",
            "LilyPetal03",
            "LilyPetal04",
            "LilyPetal05",
            "LilyPetal06",
            "DressCenterTrim",
            "OuterSkirtTrimR",
            "SleeveTrimR",
        )
        allocations = []
        for name in unique_objects:
            object_ = bpy.data.objects[name]
            allocation = object_.get("whitelily_uv_allocation")
            self.assertIsInstance(allocation, str, name)
            allocations.append(allocation)
        self.assertEqual(len(allocations), len(set(allocations)))

    def test_only_hair_and_lily_edges_opt_into_alpha_test(self):
        for material_name in ("MAT_Face", "MAT_Eyes", "MAT_Outfit"):
            material = bpy.data.materials[material_name]
            self.assertEqual(material.surface_render_method, "DITHERED")
            self.assertEqual(material["alpha_test_scope"], "disabled-opaque-atlas")
        hair = bpy.data.materials["MAT_Hair"]
        self.assertEqual(hair.surface_render_method, "DITHERED")
        self.assertAlmostEqual(hair["alpha_test_threshold"], 0.5)
        self.assertEqual(hair["alpha_test_scope"], "lily-edges-and-hair-tips-only")
        self.assertFalse(any(material.use_transparency_overlap for material in bpy.data.materials))

    def test_material_stage_metadata_records_advanced_and_basic_render_contract(self):
        contract = json.loads(bpy.context.scene["whitelily_material_contract"])
        self.assertEqual(contract["advanced"]["thresholds"], [0.35, 0.68])
        self.assertEqual(contract["advanced"]["edgeHighlightStrength"], 0.08)
        self.assertEqual(contract["basic"]["lighting"], "minecraft")
        self.assertEqual(contract["basic"]["shadowBands"], 1)
        self.assertEqual(contract["sharedDetailLevels"], ["high", "low"])
        self.assertEqual(contract["alphaTestThreshold"], 0.5)
        self.assertEqual(contract["comparisonLighting"], ["day", "night", "indoor"])


if __name__ == "__main__":
    unittest.main(argv=[__file__])
