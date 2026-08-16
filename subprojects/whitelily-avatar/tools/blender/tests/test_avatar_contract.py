import os
import sys
import unittest

BLENDER_TOOLS_DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BLENDER_TOOLS_DIRECTORY not in sys.path:
    sys.path.insert(0, BLENDER_TOOLS_DIRECTORY)

from avatar_contract import REQUIRED_COLLECTIONS, REQUIRED_SOURCE_DIGESTS


class AvatarContractTest(unittest.TestCase):
    def test_contract_names_are_stable(self):
        self.assertEqual(
            REQUIRED_COLLECTIONS,
            (
                "REF", "BODY_HIGH", "BODY_LOW", "OUTFIT_BASE", "ARMOR",
                "RIG", "CAMERAS", "LIGHTS",
            ),
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
