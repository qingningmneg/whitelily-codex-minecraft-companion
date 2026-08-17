"""Contract tests for the smooth WhiteLily body-high production stage."""

import os
import sys
import unittest
from collections import defaultdict
import math

import bmesh
import bpy
from mathutils.bvhtree import BVHTree
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
PHYSICAL_SUBPIECES = (
    "BackRibbon", "RibbonLoopL", "RibbonLoopR", "RibbonTailL", "RibbonTailR",
    "LilyHairpin", "LilyMount",
    "LilyStamen01", "LilyStamen02", "LilyStamen03",
    "LilyStamen04", "LilyStamen05", "LilyStamen06",
)
SHELL_OBJECTS = ("SleeveL", "SleeveR", "SkirtInner", "SkirtOuter")


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


def object_world_vertices(object_name):
    object_ = bpy.data.objects[object_name]
    return [object_.matrix_world @ vertex.co for vertex in object_.data.vertices]


def vertex_group_centroid(object_name, group_name):
    object_ = bpy.data.objects[object_name]
    group = object_.vertex_groups.get(group_name)
    if group is None:
        return None
    points = []
    for vertex in object_.data.vertices:
        if any(membership.group == group.index and membership.weight > 0.5 for membership in vertex.groups):
            points.append(object_.matrix_world @ vertex.co)
    return sum(points, Vector()) / len(points) if points else None


def connected_component_count(object_):
    adjacency = defaultdict(set)
    for edge in object_.data.edges:
        a, b = edge.vertices
        adjacency[a].add(b)
        adjacency[b].add(a)
    remaining = set(range(len(object_.data.vertices)))
    components = 0
    while remaining:
        components += 1
        queue = [remaining.pop()]
        while queue:
            current = queue.pop()
            for neighbor in adjacency[current]:
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    queue.append(neighbor)
    return components


def manifold_volume_and_thickness(object_):
    mesh = object_.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    try:
        manifold = bool(bm.edges) and all(edge.is_manifold for edge in bm.edges)
        volume = abs(bm.calc_volume(signed=True))
        area = sum(face.calc_area() for face in bm.faces)
        return manifold, volume, volume / area if area else 0.0
    finally:
        bm.free()


def group_forms_closed_loop(object_name, group_name, minimum_vertices=12):
    object_ = bpy.data.objects[object_name]
    group = object_.vertex_groups.get(group_name)
    if group is None:
        return False
    vertices = {
        vertex.index
        for vertex in object_.data.vertices
        if any(membership.group == group.index and membership.weight > 0.5 for membership in vertex.groups)
    }
    if len(vertices) < minimum_vertices:
        return False
    adjacency = {index: set() for index in vertices}
    for edge in object_.data.edges:
        a, b = edge.vertices
        if a in vertices and b in vertices:
            adjacency[a].add(b)
            adjacency[b].add(a)
    if any(len(neighbors) != 2 for neighbors in adjacency.values()):
        return False
    visited = set()
    queue = [next(iter(vertices))]
    while queue:
        current = queue.pop()
        if current in visited:
            continue
        visited.add(current)
        queue.extend(adjacency[current] - visited)
    return visited == vertices


def maximum_coplanar_patch_ratio(object_):
    polygons = object_.data.polygons
    total_area = sum(polygon.area for polygon in polygons)
    if total_area == 0:
        return 1.0
    edge_faces = defaultdict(list)
    for polygon in polygons:
        for edge_key in polygon.edge_keys:
            edge_faces[tuple(sorted(edge_key))].append(polygon.index)
    cosine = math.cos(math.radians(3.0))
    adjacency = defaultdict(set)
    for face_indices in edge_faces.values():
        if len(face_indices) == 2:
            first, second = face_indices
            adjacency[first].add(second)
            adjacency[second].add(first)
    remaining = set(range(len(polygons)))
    maximum = 0.0
    while remaining:
        seed = remaining.pop()
        reference_normal = polygons[seed].normal
        reference_center = polygons[seed].center
        patch = {seed}
        queue = [seed]
        while queue:
            current = queue.pop()
            for neighbor in adjacency[current]:
                if neighbor not in remaining:
                    continue
                polygon = polygons[neighbor]
                if reference_normal.dot(polygon.normal) < cosine:
                    continue
                if any(
                    abs(reference_normal.dot(object_.data.vertices[index].co - reference_center)) > 1e-5
                    for index in polygon.vertices
                ):
                    continue
                remaining.remove(neighbor)
                patch.add(neighbor)
                queue.append(neighbor)
        maximum = max(maximum, sum(polygons[index].area for index in patch))
    return maximum / total_area


def nonlinear_width_profile(object_name, axis=0, bins=9):
    points = object_world_vertices(object_name)
    low = min(point.z for point in points)
    high = max(point.z for point in points)
    samples = []
    for index in range(bins):
        center = low + (high - low) * index / (bins - 1)
        half_band = (high - low) / (bins - 1) * 0.6
        band = [point[axis] for point in points if abs(point.z - center) <= half_band]
        if band:
            samples.append((index / (bins - 1), max(band) - min(band)))
    if len(samples) < 5:
        return 0.0, 0
    first = samples[0][1]
    last = samples[-1][1]
    deviations = [abs(width - (first + (last - first) * t)) for t, width in samples]
    scale = max(max(width for _, width in samples), 1e-6)
    return max(deviations) / scale, len({round(width, 4) for _, width in samples})


def maximum_ring_depth_asymmetry(object_name, minimum_ring_vertices=12):
    """Measure front/back depth around the anatomical side-plane of each ring."""
    rings = defaultdict(list)
    for point in object_world_vertices(object_name):
        rings[round(point.z, 5)].append(point)
    asymmetries = []
    for points in rings.values():
        if len(points) < minimum_ring_vertices:
            continue
        low_x = min(point.x for point in points)
        high_x = max(point.x for point in points)
        half_width = (high_x - low_x) * 0.5
        if half_width <= 1e-6:
            continue
        center_x = (low_x + high_x) * 0.5
        side_points = [
            point
            for point in points
            if abs(point.x - center_x) >= half_width * 0.92
        ]
        if not side_points:
            continue
        side_plane_y = sum(point.y for point in side_points) / len(side_points)
        front_depth = side_plane_y - min(point.y for point in points)
        back_depth = max(point.y for point in points) - side_plane_y
        total_depth = front_depth + back_depth
        if total_depth > 1e-6:
            asymmetries.append(abs(front_depth - back_depth) / total_depth)
    return max(asymmetries, default=0.0)


def large_shallow_torso_panels():
    panels = []
    for object_ in collection_meshes("BODY_HIGH", "OUTFIT_BASE"):
        world_corners = [object_.matrix_world @ Vector(corner) for corner in object_.bound_box]
        center_x = (min(point.x for point in world_corners) + max(point.x for point in world_corners)) * 0.5
        center_z = (min(point.z for point in world_corners) + max(point.z for point in world_corners)) * 0.5
        dimensions = object_.dimensions
        if (
            abs(center_x) <= 0.04
            and
            1.0 <= center_z <= 1.5
            and dimensions.x >= 0.08
            and dimensions.y <= 0.05
            and dimensions.z >= 0.22
        ):
            panels.append(object_.name)
    return panels


def maximum_normal_turn(object_):
    polygons = object_.data.polygons
    turns = []
    edge_faces = defaultdict(list)
    for polygon in polygons:
        for edge_key in polygon.edge_keys:
            edge_faces[tuple(sorted(edge_key))].append(polygon.index)
    for indices in edge_faces.values():
        if len(indices) == 2:
            dot = max(-1.0, min(1.0, polygons[indices[0]].normal.dot(polygons[indices[1]].normal)))
            turns.append(math.degrees(math.acos(dot)))
    turns.sort()
    return turns[int(len(turns) * 0.95)] if turns else 180.0


def bvh_overlap(first_name, second_name):
    def tree(object_name):
        object_ = bpy.data.objects[object_name]
        vertices = [object_.matrix_world @ vertex.co for vertex in object_.data.vertices]
        polygons = [tuple(polygon.vertices) for polygon in object_.data.polygons]
        return BVHTree.FromPolygons(vertices, polygons, all_triangles=False)

    return tree(first_name).overlap(tree(second_name))


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
    def test_anatomical_landmarks_drive_real_proportions(self):
        head_top = vertex_group_centroid("Hair", "HeadTopLandmark")
        chin = vertex_group_centroid("Face", "ChinLandmark")
        self.assertIsNotNone(head_top)
        self.assertIsNotNone(chin)
        ratio = CHARACTER_HEIGHT_METERS / (head_top.z - chin.z)
        message = f"headTop={head_top.z:.6f}, chin={chin.z:.6f}, ratio={ratio:.6f}"
        self.assertGreaterEqual(ratio, 6.3, message)
        self.assertLessEqual(ratio, 6.8, message)

        shoulder_l = vertex_group_centroid("Body", "ShoulderLandmarkL")
        shoulder_r = vertex_group_centroid("Body", "ShoulderLandmarkR")
        self.assertIsNotNone(shoulder_l)
        self.assertIsNotNone(shoulder_r)
        shoulder_width = abs(shoulder_l.x - shoulder_r.x)
        self.assertGreaterEqual(shoulder_width, 0.34)
        self.assertLessEqual(shoulder_width, 0.40)

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
        self.assertEqual(large_shallow_torso_panels(), [])

    def test_large_surfaces_are_curved_connected_and_normally_continuous(self):
        for object_name in ("Body", "Face", "Hair", "HairBack", "DressBase") + SHELL_OBJECTS:
            object_ = bpy.data.objects[object_name]
            self.assertEqual(connected_component_count(object_), 1, object_name)
            maximum_planar_ratio = 0.03 if object_name in SHELL_OBJECTS else 0.08
            self.assertLess(maximum_coplanar_patch_ratio(object_), maximum_planar_ratio, object_name)

        for object_name in ("SleeveL", "SleeveR", "SkirtInner", "SkirtOuter", "HairBack"):
            nonlinearity, unique_widths = nonlinear_width_profile(object_name)
            self.assertGreaterEqual(unique_widths, 5, object_name)
            self.assertGreaterEqual(nonlinearity, 0.18, object_name)

        for object_name in ("Body", "Face", "Hair", "DressBase"):
            self.assertLess(maximum_normal_turn(bpy.data.objects[object_name]), 35.0, object_name)
        for object_name in SHELL_OBJECTS:
            self.assertLess(maximum_normal_turn(bpy.data.objects[object_name]), 35.0, object_name)

        for object_name in ("Body", "Face", "HairBack", "DressBase"):
            self.assertGreaterEqual(
                maximum_ring_depth_asymmetry(object_name),
                0.08,
                object_name,
            )

    def test_hair_strands_are_tapered_connected_and_layered(self):
        strand_names = tuple(f"HairStrand{index:02d}" for index in range(1, 9))
        tip_heights = set()
        for object_name in strand_names:
            object_ = bpy.data.objects[object_name]
            self.assertEqual(connected_component_count(object_), 1, object_name)
            manifold, volume, _ = manifold_volume_and_thickness(object_)
            self.assertTrue(manifold, object_name)
            self.assertGreater(volume, 1e-8, object_name)
            tip_heights.add(round(min(point.z for point in object_world_vertices(object_name)), 3))
        self.assertGreaterEqual(len(tip_heights), 6)

    def test_face_and_arm_topology_has_closed_deformation_loops(self):
        self.assertTrue(group_forms_closed_loop("EyelidL", "BlinkLoop"))
        self.assertTrue(group_forms_closed_loop("EyelidR", "BlinkLoop"))
        self.assertTrue(group_forms_closed_loop("Mouth", "MouthLoop"))
        for side in ("L", "R"):
            self.assertTrue(group_forms_closed_loop("UpperArm" + side, "ShoulderLoop", 16))
            self.assertTrue(group_forms_closed_loop("UpperArm" + side, "ElbowLoop", 16))

    def test_outfit_and_decorations_are_named_manifold_physical_structures(self):
        for object_name in PHYSICAL_SUBPIECES + SHELL_OBJECTS:
            object_ = bpy.data.objects.get(object_name)
            self.assertIsNotNone(object_, object_name)
            self.assertEqual(object_.type, "MESH", object_name)
            self.assertEqual(connected_component_count(object_), 1, object_name)
            manifold, volume, thickness = manifold_volume_and_thickness(object_)
            self.assertTrue(manifold, object_name)
            self.assertGreater(volume, 1e-9, object_name)
            if object_name in SHELL_OBJECTS:
                self.assertGreaterEqual(thickness, 0.0025, object_name)
                self.assertLessEqual(thickness, 0.0300, object_name)

        sleeve_l = bpy.data.objects["SleeveL"].dimensions
        sleeve_r = bpy.data.objects["SleeveR"].dimensions
        self.assertGreater(abs(sleeve_l.y - sleeve_r.y) + abs(sleeve_l.z - sleeve_r.z), 0.004)

        loop_l = bpy.data.objects["RibbonLoopL"].dimensions
        loop_r = bpy.data.objects["RibbonLoopR"].dimensions
        self.assertGreater(sum(abs(loop_l[axis] - loop_r[axis]) for axis in range(3)), 0.008)

        for side in ("L", "R"):
            hand = bpy.data.objects["Hand" + side].dimensions
            foot = bpy.data.objects["Foot" + side].dimensions
            sole = bpy.data.objects["ShoeSole" + side].dimensions
            self.assertGreater(hand.z / hand.x, 1.75, "Hand" + side)
            self.assertLess(sole.z / foot.z, 0.13, "ShoeSole" + side)

    def test_static_clothing_shells_do_not_intersect(self):
        self.assertEqual(bvh_overlap("SkirtInner", "SkirtOuter"), [])
        self.assertEqual(bvh_overlap("SleeveL", "HandL"), [])
        self.assertEqual(bvh_overlap("SleeveR", "HandR"), [])


if __name__ == "__main__":
    unittest.main(argv=[__file__])
