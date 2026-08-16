"""Validate the pinned Blender source scene before an avatar build can proceed."""

import argparse
import hashlib
import json
import os
import sys

import bpy

SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, SCRIPT_DIRECTORY)

from avatar_contract import (
    ART_STAGE,
    ASSET_SCHEMA,
    FRAMES_PER_SECOND,
    REQUIRED_CAMERAS,
    REQUIRED_COLLECTIONS,
    REQUIRED_LIGHTS,
    REQUIRED_SOURCE_DIGESTS,
    UNIT_SCALE,
)
from validate_blender_version import validate_blender_version


ASSET_DIRECTORY = os.path.dirname(os.path.dirname(SCRIPT_DIRECTORY))
SOURCE_DIRECTORY = os.path.join(ASSET_DIRECTORY, "assets", "source")
EXPORT_PROFILE_PATH = os.path.join(ASSET_DIRECTORY, "assets", "blender", "export-profile.json")


class AvatarValidationError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def fail(code):
    raise AvatarValidationError(code)


def source_digest(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_sources(source_directory=SOURCE_DIRECTORY):
    for filename, expected in REQUIRED_SOURCE_DIGESTS.items():
        path = os.path.join(source_directory, filename)
        if not os.path.isfile(path) or source_digest(path) != expected:
            fail("AVATAR_SOURCE_DIGEST_MISMATCH")
    license_path = os.path.join(source_directory, "asset-license.json")
    try:
        with open(license_path, "r", encoding="utf-8") as license_file:
            license_data = json.load(license_file)
    except (OSError, ValueError):
        fail("AVATAR_LICENSE_INVALID")
    if not isinstance(license_data.get("confirmedOn"), str) or not isinstance(
        license_data.get("authorization"), str
    ):
        fail("AVATAR_LICENSE_INVALID")


def validate_export_profile(profile_path=EXPORT_PROFILE_PATH):
    expected = {
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
    try:
        with open(profile_path, "r", encoding="utf-8") as profile_file:
            profile = json.load(profile_file)
    except (OSError, ValueError):
        fail("AVATAR_EXPORT_PROFILE_INVALID")
    if profile != expected:
        fail("AVATAR_EXPORT_PROFILE_INVALID")
    return profile


def validate_reference_images(scene):
    references = [object_ for object_ in bpy.data.collections["REF"].objects if object_.type == "EMPTY"]
    if len(references) != len(REQUIRED_SOURCE_DIGESTS) or any(
        not object_.hide_render for object_ in references
    ):
        fail("AVATAR_REFERENCE_INVALID")
    reference_images = []
    reference_names = set()
    for reference in references:
        image = reference.data
        if image is None or image.source != "FILE" or image.name not in REQUIRED_SOURCE_DIGESTS:
            fail("AVATAR_PACKED_SOURCE_INVALID")
        if image.name in reference_names or image.packed_file is None or image.filepath.startswith("//"):
            fail("AVATAR_PACKED_SOURCE_INVALID")
        payload = bytes(image.packed_file.data)
        if hashlib.sha256(payload).hexdigest() != REQUIRED_SOURCE_DIGESTS[image.name]:
            fail("AVATAR_PACKED_SOURCE_INVALID")
        reference_names.add(image.name)
        reference_images.append(image)
    if reference_names != set(REQUIRED_SOURCE_DIGESTS):
        fail("AVATAR_PACKED_SOURCE_INVALID")
    source_images = [image for image in bpy.data.images if image.source == "FILE"]
    if len(source_images) != len(reference_images) or {
        image.as_pointer() for image in source_images
    } != {image.as_pointer() for image in reference_images}:
        fail("AVATAR_RESOURCE_UNPACKED")


def validate_scene(scene):
    if scene.get("whitelily_asset_schema") != ASSET_SCHEMA:
        fail("AVATAR_SCHEMA_MISMATCH")
    if scene.get("AVATAR_ART_STAGE") != ART_STAGE:
        fail("AVATAR_ART_STAGE_INVALID")
    if scene.unit_settings.system != "METRIC" or scene.unit_settings.scale_length != UNIT_SCALE:
        fail("AVATAR_UNITS_INVALID")
    if scene.render.fps != FRAMES_PER_SECOND:
        fail("AVATAR_FRAME_RATE_INVALID")
    # Blender 4.5 reports is_dirty=True for every background invocation,
    # including --factory-startup.  In an interactive session it remains the
    # authoritative unsaved-scene guard; the build always opens a saved file.
    if bpy.data.is_dirty and not bpy.app.background:
        fail("AVATAR_SCENE_DIRTY")
    if not bpy.data.filepath or not os.path.isfile(bpy.data.filepath):
        fail("AVATAR_SCENE_UNSAVED")
    for name in REQUIRED_COLLECTIONS:
        if bpy.data.collections.get(name) is None:
            fail("AVATAR_COLLECTION_MISSING")
    for name in REQUIRED_CAMERAS:
        object_ = bpy.data.objects.get(name)
        if (
            object_ is None
            or object_.type != "CAMERA"
            or object_.data.type != "ORTHO"
            or bpy.data.collections["CAMERAS"] not in object_.users_collection
        ):
            fail("AVATAR_CAMERA_INVALID")
    for name in REQUIRED_LIGHTS:
        object_ = bpy.data.objects.get(name)
        if (
            object_ is None
            or object_.type != "LIGHT"
            or bpy.data.collections["LIGHTS"] not in object_.users_collection
        ):
            fail("AVATAR_LIGHT_INVALID")
    validate_reference_images(scene)
    if bpy.data.libraries or bpy.data.fonts or bpy.data.sounds or bpy.data.movieclips:
        fail("AVATAR_RESOURCE_UNPACKED")


def gltf_export_arguments(profile, output_path):
    if profile["maxWeightsPerVertex"] != 4:
        fail("AVATAR_EXPORT_PROFILE_INVALID")
    return {
        "filepath": output_path,
        "export_format": profile["container"],
        "export_yup": profile["upAxis"] == "Y",
        "export_apply": profile["applyModifiers"],
        "export_skins": profile["exportSkins"],
        "export_animations": profile["exportAnimations"],
        "export_morph": profile["exportMorphTargets"],
        "export_image_format": "AUTO",
        "export_draco_mesh_compression_enable": profile["draco"],
        "export_all_influences": False,
        "export_force_sampling": True,
        "export_frame_step": 1,
    }


def export_bootstrap(output_directory, render_previews, profile):
    os.makedirs(output_directory, exist_ok=True)
    bpy.ops.export_scene.gltf(
        **gltf_export_arguments(profile, os.path.join(output_directory, "whitelily-anime-avatar.glb"))
    )
    if not render_previews:
        return
    previews = os.path.join(output_directory, "previews")
    os.makedirs(previews, exist_ok=True)
    for camera_name in REQUIRED_CAMERAS:
        bpy.context.scene.camera = bpy.data.objects[camera_name]
        bpy.context.scene.render.filepath = os.path.join(previews, camera_name.lower() + ".png")
        bpy.ops.render.render(write_still=True)


def blender_arguments():
    arguments = sys.argv
    return arguments[arguments.index("--") + 1 :] if "--" in arguments else []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", default=SOURCE_DIRECTORY)
    parser.add_argument("--output-dir")
    parser.add_argument("--render-previews", action="store_true")
    arguments = parser.parse_args(blender_arguments())
    try:
        validate_blender_version()
        validate_sources(arguments.source_root)
        profile = validate_export_profile()
        validate_scene(bpy.context.scene)
        if arguments.output_dir:
            export_bootstrap(arguments.output_dir, arguments.render_previews, profile)
    except AvatarValidationError as error:
        print(error.code, file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
