"""Create the deterministic skeleton for the WhiteLily anime avatar source scene."""

import argparse
import os
import sys

import bpy
from mathutils import Vector

SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, SCRIPT_DIRECTORY)

from avatar_contract import ART_STAGE, ASSET_SCHEMA, FRAMES_PER_SECOND, REQUIRED_CAMERAS, REQUIRED_COLLECTIONS, REQUIRED_LIGHTS, UNIT_SCALE
from validate_blender_version import validate_blender_version


ASSET_DIRECTORY = os.path.dirname(os.path.dirname(SCRIPT_DIRECTORY))
SOURCE_DIRECTORY = os.path.join(ASSET_DIRECTORY, "assets", "source")


def blender_arguments():
    arguments = sys.argv
    return arguments[arguments.index("--") + 1 :] if "--" in arguments else []


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)
    for image in list(bpy.data.images):
        if image.users == 0:
            bpy.data.images.remove(image)


def make_collections(scene):
    collections = {}
    for name in REQUIRED_COLLECTIONS:
        collection = bpy.data.collections.new(name)
        scene.collection.children.link(collection)
        collections[name] = collection
    return collections


def link_object(collection, object_):
    collection.objects.link(object_)
    for linked_collection in list(object_.users_collection):
        if linked_collection != collection:
            linked_collection.objects.unlink(object_)


def point_at(object_, target=(0.0, 0.0, 0.9)):
    object_.rotation_euler = (Vector(target) - object_.location).to_track_quat("-Z", "Y").to_euler()


def create_cameras(collection):
    placements = {
        "CAM_FRONT": (0.0, -5.0, 0.9),
        "CAM_BACK": (0.0, 5.0, 0.9),
        "CAM_LEFT": (-5.0, 0.0, 0.9),
        "CAM_RIGHT": (5.0, 0.0, 0.9),
        "CAM_TOP": (0.0, 0.0, 5.0),
        "CAM_BOTTOM": (0.0, 0.0, -3.2),
    }
    for name in REQUIRED_CAMERAS:
        data = bpy.data.cameras.new(name)
        data.type = "ORTHO"
        data.ortho_scale = 2.4
        camera = bpy.data.objects.new(name, data)
        camera.location = placements[name]
        point_at(camera)
        link_object(collection, camera)


def create_lights(collection):
    placements = {
        "LIGHT_KEY": ((3.0, -4.0, 4.0), 1000.0),
        "LIGHT_FILL": ((-4.0, -2.0, 2.5), 450.0),
        "LIGHT_RIM": ((2.0, 4.0, 3.5), 700.0),
    }
    for name in REQUIRED_LIGHTS:
        location, energy = placements[name]
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = 2.0
        light = bpy.data.objects.new(name, data)
        light.location = location
        point_at(light)
        link_object(collection, light)


def create_reference(collection, filename, location):
    image_path = os.path.join(SOURCE_DIRECTORY, filename)
    image = bpy.data.images.load(image_path, check_existing=False)
    image.pack()
    reference = bpy.data.objects.new("REF_" + filename.rsplit(".", 1)[0].upper(), None)
    reference.empty_display_type = "IMAGE"
    reference.empty_display_size = 2.0
    reference.data = image
    reference.location = location
    reference.hide_render = True
    link_object(collection, reference)


def bootstrap(output):
    validate_blender_version()
    reset_scene()
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = UNIT_SCALE
    scene.render.fps = FRAMES_PER_SECOND
    scene["whitelily_asset_schema"] = ASSET_SCHEMA
    scene["AVATAR_ART_STAGE"] = ART_STAGE
    collections = make_collections(scene)
    create_cameras(collections["CAMERAS"])
    create_lights(collections["LIGHTS"])
    create_reference(collections["REF"], "whitelily-turnaround.png", (-2.2, 0.0, 0.9))
    create_reference(collections["REF"], "whitelily-armor-themes.png", (2.2, 0.0, 0.9))
    scene.camera = bpy.data.objects["CAM_FRONT"]
    bpy.ops.wm.save_as_mainfile(
        filepath=os.path.abspath(output), check_existing=False, relative_remap=False
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(blender_arguments())
    bootstrap(arguments.output)


if __name__ == "__main__":
    main()
