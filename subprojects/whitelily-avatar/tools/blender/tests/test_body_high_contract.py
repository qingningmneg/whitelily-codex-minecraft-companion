"""Contract tests for the smooth WhiteLily body-high production stage."""

import os
import sys
import unittest

import bpy
from mathutils import Vector


BLENDER_TOOLS_DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BLENDER_TOOLS_DIRECTORY not in sys.path:
    sys.path.insert(0, BLENDER_TOOLS_DIRECTORY)

from avatar_contract import CHARACTER_HEIGHT_METERS, HIGH_TRIANGLE_RANGE


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
QUAD_DEFORMATION_OBJECTS = ("Body", "Face", "Hair", "DressBase")


def collection_meshes(*collection_names):
    objects = {}
    for collection_name in collection_names:
        collection = bpy.data.collections.get(collection_name)
        if collection is None:
            continue
        for object_ in collection.all_objects:
            if object_.type == "MESH":
                objects[object_.as_pointer()] = object_
    return tuple(objects.values())


def evaluated_triangle_count(*collection_names):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    total = 0
    for object_ in collection_meshes(*collection_names):
        evaluated = object_.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=depsgraph)
        try:
            total += sum(max(0, len(polygon.vertices) - 2) for polygon in mesh.polygons)
        finally:
            evaluated.to_mesh_clear()
    return total


def collection_bounding_height(collection_name):
    z_values = []
    for object_ in collection_meshes(collection_name):
        z_values.extend((object_.matrix_world @ Vector(corner)).z for corner in object_.bound_box)
    return max(z_values) - min(z_values) if z_values else 0.0


def is_axis_aligned_box(object_, minimum_size=0.08, tolerance=1e-5):
    if object_.type != "MESH" or max(object_.dimensions) <= minimum_size:
        return False
    vertices = [object_.matrix_world @ vertex.co for vertex in object_.data.vertices]
    if len(vertices) < 8:
        return False
    bounds = tuple(
        (min(vertex[axis] for vertex in vertices), max(vertex[axis] for vertex in vertices))
        for axis in range(3)
    )
    if any(high - low <= tolerance for low, high in bounds):
        return False
    return all(
        all(
            abs(vertex[axis] - bounds[axis][0]) <= tolerance
            or abs(vertex[axis] - bounds[axis][1]) <= tolerance
            for axis in range(3)
        )
        for vertex in vertices
    )


class BodyHighContractTest(unittest.TestCase):
    def test_body_high_is_smooth_and_complete(self):
        triangle_count = evaluated_triangle_count("BODY_HIGH", "OUTFIT_BASE")
        self.assertGreaterEqual(triangle_count, HIGH_TRIANGLE_RANGE[0])
        self.assertLessEqual(triangle_count, HIGH_TRIANGLE_RANGE[1])

        self.assertAlmostEqual(
            collection_bounding_height("BODY_HIGH"),
            CHARACTER_HEIGHT_METERS,
            delta=0.01,
        )

        for object_name in REQUIRED_OBJECTS:
            object_ = bpy.data.objects.get(object_name)
            self.assertIsNotNone(object_, object_name)
            self.assertEqual(object_.type, "MESH", object_name)

        for object_name in QUAD_DEFORMATION_OBJECTS:
            object_ = bpy.data.objects.get(object_name)
            self.assertIsNotNone(object_, object_name)
            self.assertEqual(object_.type, "MESH", object_name)
            self.assertTrue(object_.data.polygons, object_name)
            self.assertTrue(
                all(len(polygon.vertices) == 4 for polygon in object_.data.polygons),
                object_name,
            )

        box_objects = [
            object_.name
            for object_ in collection_meshes("BODY_HIGH", "OUTFIT_BASE")
            if is_axis_aligned_box(object_)
        ]
        self.assertEqual(box_objects, [])


if __name__ == "__main__":
    unittest.main(argv=[__file__])
