"""Build, validate, and render the WhiteLily 2K cel-material production stage."""

import argparse
import binascii
import json
import math
import os
import struct
import sys
import zlib

import bpy
from mathutils import Vector


SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
AVATAR_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIRECTORY))
ASSET_ROOT = os.path.join(AVATAR_ROOT, "assets")
TEXTURE_ROOT = os.path.join(ASSET_ROOT, "textures", "source")
PALETTE_PATH = os.path.join(ASSET_ROOT, "palettes", "whitelily-base.json")
BLEND_PATH = os.path.join(ASSET_ROOT, "blender", "whitelily-anime-avatar.blend")
ALBEDO_NAME = "whitelily-base-albedo.png"
CONTROL_NAME = "whitelily-base-control.png"
MATERIAL_NAMES = ("MAT_Face", "MAT_Eyes", "MAT_Hair", "MAT_Outfit")
VISIBLE_COLLECTIONS = ("BODY_HIGH", "OUTFIT_BASE")
ATLAS_SIZE = 2048
MIP_PADDING = 16
SEMANTIC_BOUNDS = {
    "face": (16, 1040, 496, 2032),
    "eyes": (528, 1040, 1008, 2032),
    "hair": (1040, 1040, 2032, 2032),
    "outfit": (16, 16, 2032, 1008),
}
PALETTE = {
    "lily": (247, 246, 242),
    "silver": (233, 241, 234),
    "green": (205, 226, 200),
    "gold": (212, 199, 163),
    "gold_deep": (166, 124, 82),
    "iris_deep": (127, 129, 95),
    "iris_mid": (144, 151, 112),
    "iris_highlight": (186, 186, 152),
    "iris_render_deep": (50, 115, 35),
    "iris_render_mid": (70, 160, 55),
    "iris_render_highlight": (145, 215, 100),
    "skin": (243, 225, 208),
}


class MaterialContractError(RuntimeError):
    pass


def fail(code):
    raise MaterialContractError(code)


def blender_arguments():
    arguments = sys.argv
    return arguments[arguments.index("--") + 1 :] if "--" in arguments else []


def visible_meshes():
    objects = {}
    for collection_name in VISIBLE_COLLECTIONS:
        collection = bpy.data.collections.get(collection_name)
        if collection is None:
            fail("AVATAR_MATERIAL_COLLECTION_MISSING")
        for object_ in collection.all_objects:
            if object_.type == "MESH" and not object_.hide_render:
                objects[object_.as_pointer()] = object_
    return tuple(sorted(objects.values(), key=lambda object_: object_.name))


def semantic_category(name):
    if name in {"Face", "Body", "ArmL", "ArmR", "HandL", "HandR", "Mouth"}:
        return "face"
    if name.startswith(("Eye", "Iris", "Pupil", "Eyelid", "LowerEyelid", "Eyebrow")):
        return "eyes"
    if name.startswith(("Hair", "Lily")):
        return "hair"
    return "outfit"


def material_for_category(category):
    return {
        "face": "MAT_Face",
        "eyes": "MAT_Eyes",
        "hair": "MAT_Hair",
        "outfit": "MAT_Outfit",
    }[category]


def allocation_layout(objects):
    by_category = {category: [] for category in SEMANTIC_BOUNDS}
    for object_ in objects:
        by_category[semantic_category(object_.name)].append(object_)
    allocations = {}
    for category, category_objects in by_category.items():
        minimum_x, minimum_y, maximum_x, maximum_y = SEMANTIC_BOUNDS[category]
        columns = max(1, math.ceil(math.sqrt(len(category_objects) * 2.0)))
        rows = max(1, math.ceil(len(category_objects) / columns))
        cell_width = (maximum_x - minimum_x) / columns
        cell_height = (maximum_y - minimum_y) / rows
        for index, object_ in enumerate(category_objects):
            column = index % columns
            row = index // columns
            left = round(minimum_x + column * cell_width)
            bottom = round(minimum_y + row * cell_height)
            right = round(minimum_x + (column + 1) * cell_width)
            top = round(minimum_y + (row + 1) * cell_height)
            if right - left <= MIP_PADDING * 2 or top - bottom <= MIP_PADDING * 2:
                fail("AVATAR_MATERIAL_UV_PADDING_INVALID")
            allocations[object_.name] = {
                "category": category,
                "index": index,
                "bounds": (left, bottom, right, top),
            }
    return allocations


def blend_color(first, second, amount):
    return tuple(
        max(1, min(254, round(first[channel] * (1.0 - amount) + second[channel] * amount)))
        for channel in range(3)
    )


def object_colors(name, category):
    if category == "face":
        if name == "Mouth":
            return PALETTE["gold_deep"], PALETTE["skin"]
        return PALETTE["skin"], blend_color(PALETTE["skin"], PALETTE["gold"], 0.25)
    if category == "eyes":
        if name == "Eyes":
            return PALETTE["iris_render_deep"], PALETTE["iris_render_highlight"]
        if name.startswith("Pupil"):
            return PALETTE["iris_render_deep"], PALETTE["iris_render_mid"]
        if name.startswith("Iris"):
            return PALETTE["iris_render_deep"], PALETTE["iris_render_highlight"]
        if name.startswith("EyeHighlight"):
            return PALETTE["iris_highlight"], PALETTE["lily"]
        if name.startswith(("Eyebrow", "Eyelid", "LowerEyelid")):
            return PALETTE["iris_deep"], PALETTE["gold_deep"]
        return PALETTE["silver"], PALETTE["green"]
    if category == "hair":
        if name.startswith("LilyStamen"):
            return PALETTE["gold"], PALETTE["gold_deep"]
        if name == "LilyMount":
            return PALETTE["green"], PALETTE["iris_mid"]
        if name.startswith("Lily"):
            return PALETTE["lily"], PALETTE["gold"]
        return PALETTE["lily"], PALETTE["silver"]
    if any(token in name for token in ("Trim", "Button", "Collar")):
        return PALETTE["gold"], PALETTE["gold_deep"]
    if name.startswith(("Sleeve", "Boot", "ShoeSole")):
        return PALETTE["silver"], PALETTE["lily"]
    if name.startswith(("Skirt", "Dress", "Waist", "Ribbon", "BackRibbon")):
        return PALETTE["green"], PALETTE["silver"]
    return PALETTE["green"], PALETTE["gold"]


def png_chunk(type_, payload):
    return (
        struct.pack(">I", len(payload))
        + type_
        + payload
        + struct.pack(">I", binascii.crc32(type_ + payload) & 0xFFFFFFFF)
    )


def write_rgba_png(path, pixels):
    stride = ATLAS_SIZE * 4
    scanlines = bytearray()
    for row in range(ATLAS_SIZE):
        scanlines.append(0)
        offset = row * stride
        scanlines.extend(pixels[offset : offset + stride])
    header = struct.pack(">IIBBBBB", ATLAS_SIZE, ATLAS_SIZE, 8, 6, 0, 0, 0)
    payload = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(bytes(scanlines), 9))
        + png_chunk(b"IEND", b"")
    )
    with open(path, "wb") as output:
        output.write(payload)


def set_pixel(pixels, x, uv_y, color):
    png_y = ATLAS_SIZE - 1 - uv_y
    offset = (png_y * ATLAS_SIZE + x) * 4
    pixels[offset : offset + 4] = bytes((*color, 255))


def paint_allocation(albedo, control, name, allocation):
    left, bottom, right, top = allocation["bounds"]
    category = allocation["category"]
    first, second = object_colors(name, category)
    width = max(1, right - left - 1)
    height = max(1, top - bottom - 1)
    for uv_y in range(bottom, top):
        vertical = (uv_y - bottom) / height
        for x in range(left, right):
            horizontal = (x - left) / width
            wash = 0.18 + 0.52 * vertical
            if category in {"hair", "outfit"}:
                wash += 0.08 * math.sin(horizontal * math.pi * 3.0)
            color = blend_color(first, second, max(0.0, min(1.0, wash)))
            brush = ((x * 17 + uv_y * 13 + allocation["index"] * 11) % 29) - 14
            color = tuple(max(1, min(254, component + brush // 7)) for component in color)
            if category == "outfit":
                filigree = abs(math.sin(horizontal * math.pi * 4.0) - vertical) < 0.018
                if filigree:
                    color = PALETTE["gold"]
            elif category == "hair" and name.startswith("Lily"):
                center_distance = math.hypot(horizontal - 0.5, vertical - 0.5)
                if 0.12 < center_distance < 0.18:
                    color = PALETTE["gold"]
            elif category == "eyes" and name.startswith("Iris"):
                if vertical > 0.72 and 0.30 < horizontal < 0.70:
                    color = PALETTE["iris_render_highlight"]
                elif vertical < 0.28:
                    color = PALETTE["iris_render_deep"]
            set_pixel(albedo, x, uv_y, color)
            response = 112 if vertical < 0.35 else (176 if vertical < 0.68 else 224)
            edge = 204 if category in {"hair", "outfit"} else (48 if category == "eyes" else 24)
            eye_highlight = 224 if category == "eyes" and vertical > 0.68 else 12
            set_pixel(control, x, uv_y, (response, edge, eye_highlight))


def generate_textures(allocations):
    os.makedirs(TEXTURE_ROOT, exist_ok=True)
    pixel_count = ATLAS_SIZE * ATLAS_SIZE
    albedo = bytearray(bytes((*PALETTE["silver"], 255)) * pixel_count)
    control = bytearray(bytes((96, 24, 12, 255)) * pixel_count)
    for name in sorted(allocations):
        paint_allocation(albedo, control, name, allocations[name])
    write_rgba_png(os.path.join(TEXTURE_ROOT, ALBEDO_NAME), albedo)
    write_rgba_png(os.path.join(TEXTURE_ROOT, CONTROL_NAME), control)


def load_packed_image(name, colorspace):
    existing = bpy.data.images.get(name)
    if existing is not None:
        bpy.data.images.remove(existing)
    image = bpy.data.images.load(os.path.join(TEXTURE_ROOT, name), check_existing=False)
    image.name = name
    image.colorspace_settings.name = colorspace
    image.alpha_mode = "CHANNEL_PACKED"
    image.pack()
    return image


def clear_nodes(node_tree):
    for node in list(node_tree.nodes):
        node_tree.nodes.remove(node)


def create_cel_group():
    existing = bpy.data.node_groups.get("WhiteLilyCelV1")
    if existing is not None:
        bpy.data.node_groups.remove(existing, do_unlink=True)
    group = bpy.data.node_groups.new("WhiteLilyCelV1", "ShaderNodeTree")
    group.interface.new_socket(name="Albedo", in_out="INPUT", socket_type="NodeSocketColor")
    group.interface.new_socket(name="Control", in_out="INPUT", socket_type="NodeSocketColor")
    group.interface.new_socket(name="Shader", in_out="OUTPUT", socket_type="NodeSocketShader")
    nodes = group.nodes
    links = group.links
    input_node = nodes.new("NodeGroupInput")
    input_node.name = "CelInputs"
    input_node.location = (-700, 0)
    output_node = nodes.new("NodeGroupOutput")
    output_node.name = "CelOutput"
    output_node.location = (500, 0)
    diffuse = nodes.new("ShaderNodeBsdfDiffuse")
    diffuse.name = "DiffuseLighting"
    diffuse.location = (-500, -120)
    shader_to_rgb = nodes.new("ShaderNodeShaderToRGB")
    shader_to_rgb.name = "LightingToBands"
    shader_to_rgb.location = (-300, -120)
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.name = "CelThresholds_0.35_0.68"
    ramp.location = (-100, -120)
    ramp.color_ramp.interpolation = "CONSTANT"
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (0.35, 0.38, 0.34, 1.0)
    middle = ramp.color_ramp.elements.new(0.68)
    middle.color = (0.68, 0.72, 0.66, 1.0)
    ramp.color_ramp.elements[-1].position = 1.0
    ramp.color_ramp.elements[-1].color = (1.0, 1.0, 1.0, 1.0)
    multiply = nodes.new("ShaderNodeMixRGB")
    multiply.name = "PaintedAlbedoBands"
    multiply.blend_type = "MULTIPLY"
    multiply.inputs[0].default_value = 1.0
    multiply.location = (100, 20)
    emission = nodes.new("ShaderNodeEmission")
    emission.name = "CelSurface"
    emission.location = (320, 0)
    links.new(diffuse.outputs["BSDF"], shader_to_rgb.inputs["Shader"])
    links.new(shader_to_rgb.outputs["Color"], ramp.inputs["Fac"])
    links.new(input_node.outputs["Albedo"], multiply.inputs[1])
    links.new(ramp.outputs["Color"], multiply.inputs[2])
    links.new(multiply.outputs["Color"], emission.inputs["Color"])
    links.new(emission.outputs["Emission"], output_node.inputs["Shader"])
    return group


def make_material(name, group, albedo, control):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.surface_render_method = "DITHERED"
    material.use_transparency_overlap = False
    material["cel_shadow_thresholds"] = [0.35, 0.68]
    material["edge_highlight_strength"] = 0.08
    material["whitelily_basic_fallback"] = True
    material["basic_lighting"] = "minecraft"
    material["basic_shadow_bands"] = 1
    material["alpha_test_threshold"] = 0.5
    material["alpha_test_scope"] = (
        "lily-edges-and-hair-tips-only"
        if name == "MAT_Hair"
        else "disabled-opaque-atlas"
    )
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    clear_nodes(material.node_tree)
    output = nodes.new("ShaderNodeOutputMaterial")
    output.name = "MaterialOutput"
    output.location = (760, 0)
    coordinates = nodes.new("ShaderNodeTexCoord")
    coordinates.name = "WhiteLilyUV"
    coordinates.location = (-900, 0)
    albedo_texture = nodes.new("ShaderNodeTexImage")
    albedo_texture.name = "BaseAlbedo2K"
    albedo_texture.image = albedo
    albedo_texture.interpolation = "Linear"
    albedo_texture.extension = "EXTEND"
    albedo_texture.location = (-680, 120)
    control_texture = nodes.new("ShaderNodeTexImage")
    control_texture.name = "BaseControl2K"
    control_texture.image = control
    control_texture.interpolation = "Linear"
    control_texture.extension = "EXTEND"
    control_texture.location = (-680, -180)
    advanced = nodes.new("ShaderNodeGroup")
    advanced.name = "WhiteLilyCelV1"
    advanced.node_tree = group
    advanced.location = (-250, 80)
    fallback = nodes.new("ShaderNodeBsdfPrincipled")
    fallback.name = "BasicFallback"
    fallback.location = (-180, -260)
    fallback.inputs["Metallic"].default_value = 0.0
    fallback.inputs["Roughness"].default_value = 1.0
    if fallback.inputs.get("Specular IOR Level") is not None:
        fallback.inputs["Specular IOR Level"].default_value = 0.0
    links.new(coordinates.outputs["UV"], albedo_texture.inputs["Vector"])
    links.new(coordinates.outputs["UV"], control_texture.inputs["Vector"])
    links.new(albedo_texture.outputs["Color"], advanced.inputs["Albedo"])
    links.new(control_texture.outputs["Color"], advanced.inputs["Control"])
    links.new(albedo_texture.outputs["Color"], fallback.inputs["Base Color"])
    links.new(albedo_texture.outputs["Alpha"], fallback.inputs["Alpha"])
    if name == "MAT_Eyes":
        material["unshadowed_highlight_layer"] = True
        eye_emission = nodes.new("ShaderNodeEmission")
        eye_emission.name = "EyeHighlightEmission"
        eye_emission.inputs["Color"].default_value = tuple(
            component / 255.0
            for component in (*PALETTE["iris_render_highlight"], 255)
        )
        eye_emission.inputs["Strength"].default_value = 0.08
        eye_emission.location = (180, 220)
        add_shader = nodes.new("ShaderNodeAddShader")
        add_shader.name = "UnshadowedEyeHighlight"
        add_shader.location = (480, 80)
        links.new(advanced.outputs["Shader"], add_shader.inputs[0])
        links.new(eye_emission.outputs["Emission"], add_shader.inputs[1])
        links.new(add_shader.outputs["Shader"], output.inputs["Surface"])
    else:
        links.new(advanced.outputs["Shader"], output.inputs["Surface"])
    return material


def create_materials(albedo, control):
    for material in list(bpy.data.materials):
        bpy.data.materials.remove(material, do_unlink=True)
    group = create_cel_group()
    return {
        name: make_material(name, group, albedo, control) for name in MATERIAL_NAMES
    }


def assign_uv_and_materials(objects, allocations, materials):
    for object_ in objects:
        allocation = allocations[object_.name]
        category = allocation["category"]
        object_["whitelily_uv_region"] = category
        object_["whitelily_uv_allocation"] = (
            f"{category}:{allocation['index']:03d}:{object_.name}"
        )
        object_.data.materials.clear()
        object_.data.materials.append(materials[material_for_category(category)])
        uv_layer = object_.data.uv_layers.get("WhiteLilyUV")
        if uv_layer is None:
            uv_layer = object_.data.uv_layers.new(name="WhiteLilyUV", do_init=False)
        object_.data.uv_layers.active = uv_layer
        left, bottom, right, top = allocation["bounds"]
        left += MIP_PADDING
        bottom += MIP_PADDING
        right -= MIP_PADDING
        top -= MIP_PADDING
        vertices = object_.data.vertices
        minimum_x = min(vertex.co.x for vertex in vertices)
        maximum_x = max(vertex.co.x for vertex in vertices)
        minimum_z = min(vertex.co.z for vertex in vertices)
        maximum_z = max(vertex.co.z for vertex in vertices)
        x_range = maximum_x - minimum_x
        z_range = maximum_z - minimum_z
        for loop in object_.data.loops:
            point = vertices[loop.vertex_index].co
            u = 0.5 if x_range < 1e-8 else (point.x - minimum_x) / x_range
            v = 0.5 if z_range < 1e-8 else (point.z - minimum_z) / z_range
            uv_layer.data[loop.index].uv = (
                (left + u * (right - left)) / ATLAS_SIZE,
                (bottom + v * (top - bottom)) / ATLAS_SIZE,
            )


def assign_curve_materials(materials):
    for object_ in bpy.data.objects:
        if object_.type == "CURVE" and object_.name.startswith("HandCrease"):
            object_.data.materials.clear()
            object_.data.materials.append(materials["MAT_Face"])


def write_scene_contract(scene):
    scene["whitelily_material_stage"] = "materials-v1"
    scene["whitelily_material_contract"] = json.dumps(
        {
            "advanced": {
                "thresholds": [0.35, 0.68],
                "edgeHighlightStrength": 0.08,
                "eyeHighlight": "unshadowed",
                "hairAndHem": "soft-color-transition",
            },
            "basic": {"lighting": "minecraft", "shadowBands": 1},
            "sharedDetailLevels": ["high", "low"],
            "alphaTestThreshold": 0.5,
            "comparisonLighting": ["day", "night", "indoor"],
        },
        sort_keys=True,
    )


def apply_material_stage():
    objects = visible_meshes()
    allocations = allocation_layout(objects)
    generate_textures(allocations)
    albedo = load_packed_image(ALBEDO_NAME, "sRGB")
    control = load_packed_image(CONTROL_NAME, "Non-Color")
    materials = create_materials(albedo, control)
    assign_uv_and_materials(objects, allocations, materials)
    assign_curve_materials(materials)
    write_scene_contract(bpy.context.scene)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(
        filepath=os.path.abspath(BLEND_PATH), check_existing=False, relative_remap=False
    )


def validate_material_stage():
    if {material.name for material in bpy.data.materials} != set(MATERIAL_NAMES):
        fail("AVATAR_MATERIAL_NAMES_INVALID")
    for image_name in (ALBEDO_NAME, CONTROL_NAME):
        image = bpy.data.images.get(image_name)
        if image is None or tuple(image.size) != (2048, 2048) or image.packed_file is None:
            fail("AVATAR_MATERIAL_TEXTURE_INVALID")
    for material_name in MATERIAL_NAMES:
        material = bpy.data.materials[material_name]
        if not material.use_nodes or material.node_tree.nodes.get("BasicFallback") is None:
            fail("AVATAR_MATERIAL_FALLBACK_INVALID")
        if not any(
            node.type == "GROUP"
            and node.node_tree is not None
            and node.node_tree.name == "WhiteLilyCelV1"
            for node in material.node_tree.nodes
        ):
            fail("AVATAR_MATERIAL_CEL_GROUP_INVALID")
    for object_ in visible_meshes():
        if object_.data.uv_layers.get("WhiteLilyUV") is None:
            fail("AVATAR_MATERIAL_UV_MISSING")
        if len(object_.data.materials) != 1 or object_.data.materials[0].name not in MATERIAL_NAMES:
            fail("AVATAR_MATERIAL_ASSIGNMENT_INVALID")
    if bpy.context.scene.get("whitelily_material_stage") != "materials-v1":
        fail("AVATAR_MATERIAL_STAGE_INVALID")


def point_at(object_, target=(0.0, 0.0, 1.02)):
    object_.rotation_euler = (Vector(target) - object_.location).to_track_quat("-Z", "Y").to_euler()


def set_render_level(level):
    for material in bpy.data.materials:
        nodes = material.node_tree.nodes
        links = material.node_tree.links
        output = nodes["MaterialOutput"]
        for link in list(output.inputs["Surface"].links):
            links.remove(link)
        if level == "basic":
            links.new(nodes["BasicFallback"].outputs["BSDF"], output.inputs["Surface"])
        elif material.name == "MAT_Eyes":
            links.new(nodes["UnshadowedEyeHighlight"].outputs["Shader"], output.inputs["Surface"])
        else:
            links.new(nodes["WhiteLilyCelV1"].outputs["Shader"], output.inputs["Surface"])


def configure_lighting(scene, lighting):
    settings = {
        "day": {
            "world": (0.62, 0.76, 0.96, 1.0),
            "strength": 0.35,
            "lights": ((1050, (1.0, 0.92, 0.78)), (420, (0.68, 0.82, 1.0)), (760, (0.82, 1.0, 0.86))),
        },
        "night": {
            "world": (0.018, 0.028, 0.075, 1.0),
            "strength": 0.16,
            "lights": ((560, (0.48, 0.62, 1.0)), (210, (0.32, 0.45, 0.76)), (660, (0.62, 0.78, 1.0))),
        },
        "indoor": {
            "world": (0.16, 0.10, 0.06, 1.0),
            "strength": 0.24,
            "lights": ((820, (1.0, 0.72, 0.44)), (360, (0.84, 0.62, 0.38)), (480, (1.0, 0.88, 0.68))),
        },
    }[lighting]
    world = scene.world or bpy.data.worlds.new("WhiteLilyMaterialWorld")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = settings["world"]
    background.inputs["Strength"].default_value = settings["strength"]
    for light_name, (energy, color) in zip(
        ("LIGHT_KEY", "LIGHT_FILL", "LIGHT_RIM"), settings["lights"]
    ):
        light = bpy.data.objects[light_name]
        light.data.energy = energy
        light.data.color = color
        point_at(light)


def render_comparisons(output_directory):
    os.makedirs(output_directory, exist_ok=True)
    scene = bpy.context.scene
    rig = bpy.data.objects.get("RIG_WhiteLily")
    if rig is not None and rig.animation_data is not None:
        rig.animation_data.action = None
    scene.frame_set(1)
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 1024
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.use_file_extension = True
    scene.view_settings.look = "AgX - Medium High Contrast"
    camera = bpy.data.objects["CAM_FRONT"]
    camera.location = (0.0, -5.0, 1.02)
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 2.28
    point_at(camera)
    scene.camera = camera
    for lighting in ("day", "night", "indoor"):
        configure_lighting(scene, lighting)
        for level in ("advanced", "basic"):
            set_render_level(level)
            scene.render.filepath = os.path.join(output_directory, f"{lighting}-{level}.png")
            bpy.ops.render.render(write_still=True)
    set_render_level("advanced")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--output-dir")
    parser.add_argument("--render-comparisons", action="store_true")
    arguments = parser.parse_args(blender_arguments())
    if arguments.apply:
        apply_material_stage()
    if arguments.validate or not arguments.apply:
        validate_material_stage()
    if arguments.render_comparisons:
        if not arguments.output_dir:
            fail("AVATAR_MATERIAL_OUTPUT_DIRECTORY_REQUIRED")
        render_comparisons(os.path.abspath(arguments.output_dir))
    print("AVATAR_MATERIAL_CONTRACT_OK")


if __name__ == "__main__":
    main()
