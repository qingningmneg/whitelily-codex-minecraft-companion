"""Blender-side pinned version check used by the avatar build entrypoint."""

import os
import sys

import bpy

SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, SCRIPT_DIRECTORY)

from avatar_contract import BLENDER_VERSION


def validate_blender_version():
    if tuple(bpy.app.version[:3]) != BLENDER_VERSION:
        raise RuntimeError(
            "BLENDER_VERSION_MISMATCH: expected %s, received %s"
            % (".".join(map(str, BLENDER_VERSION)), ".".join(map(str, bpy.app.version[:3])))
        )


if __name__ == "__main__":
    validate_blender_version()
