import os
import sys
import tempfile
import unittest

BLENDER_TOOLS_DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BLENDER_TOOLS_DIRECTORY not in sys.path:
    sys.path.insert(0, BLENDER_TOOLS_DIRECTORY)

from avatar_contract import FRAMES_PER_SECOND, REQUIRED_COLLECTIONS, REQUIRED_SOURCE_DIGESTS, UNIT_SCALE
from bootstrap_avatar import bootstrap
from validate_avatar import (
    AvatarValidationError,
    gltf_export_arguments,
    validate_reference_images,
    validate_scene,
)

import bpy


class AvatarContractTest(unittest.TestCase):
    def test_contract_names_are_stable(self):
        self.assertEqual(
            REQUIRED_COLLECTIONS,
            (
                "REF", "BODY_HIGH", "BODY_LOW", "OUTFIT_BASE", "ARMOR",
                "RIG", "CAMERAS", "LIGHTS",
            ),
        )

    def test_scene_rejects_wrong_metric_settings_or_frame_rate(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            bootstrap(os.path.join(temporary_directory, "avatar.blend"))
            scene = bpy.context.scene
            validate_scene(scene)
            scene.unit_settings.system = "NONE"
            with self.assertRaisesRegex(AvatarValidationError, "AVATAR_UNITS_INVALID"):
                validate_scene(scene)
            scene.unit_settings.system = "METRIC"
            scene.unit_settings.scale_length = UNIT_SCALE
            scene.render.fps = FRAMES_PER_SECOND - 1
            with self.assertRaisesRegex(AvatarValidationError, "AVATAR_FRAME_RATE_INVALID"):
                validate_scene(scene)

    def test_scene_accepts_an_explicit_body_high_art_stage(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            bootstrap(os.path.join(temporary_directory, "avatar.blend"))
            scene = bpy.context.scene
            scene["AVATAR_ART_STAGE"] = "body-high"
            validate_scene(scene, expected_art_stage="body-high")

    def test_references_require_the_approved_packed_image_payloads(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            bootstrap(os.path.join(temporary_directory, "avatar.blend"))
            bpy.data.objects["REF_WHITELILY-TURNAROUND"].data = bpy.data.images[
                "whitelily-armor-themes.png"
            ]
            with self.assertRaisesRegex(AvatarValidationError, "AVATAR_PACKED_SOURCE_INVALID"):
                validate_reference_images(bpy.context.scene)

    def test_gltf_export_arguments_pin_four_vertex_influences(self):
        profile = {
            "format": "glTF 2.0",
            "container": "GLB",
            "upAxis": "Y",
            "units": "meters",
            "applyModifiers": True,
            "exportSkins": True,
            "exportAnimations": True,
            "exportMorphTargets": True,
            "images": "embedded",
            "draco": False,
            "externalUris": False,
            "maxWeightsPerVertex": 4,
            "sampleRateFps": 30,
        }
        self.assertEqual(
            gltf_export_arguments(profile, "C:/tmp/avatar.glb"),
            {
                "filepath": "C:/tmp/avatar.glb",
                "export_format": "GLB",
                "export_yup": True,
                "export_apply": True,
                "export_skins": True,
                "export_animations": True,
                "export_morph": True,
                "export_image_format": "AUTO",
                "export_draco_mesh_compression_enable": False,
                "export_all_influences": False,
                "export_force_sampling": True,
                "export_frame_step": 1,
            },
        )
        self.assertEqual(
            REQUIRED_SOURCE_DIGESTS,
            {
                "whitelily-turnaround.png": "572e52d22255c9d36328c48a114dfe30f89988b676122b7025a16af062935cd6",
                "whitelily-armor-themes.png": "8bfa790fbfac1c5e5816765fac5d4466fdb856b9c3fa407c725b9c29270d5a46",
            },
        )


if __name__ == "__main__":
    unittest.main(argv=[__file__])
