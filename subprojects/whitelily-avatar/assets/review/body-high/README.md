# Body-high clay review

Fix Round 2 was generated from the controller-approved Blender 4.5.3 source whose
SHA-256 is `978EB165A4AA2E13E8F2583F2874CE58B0FA1696847117D774F005AC589AAE6F`.
The approved replacement baseline and all fixed-camera review images were
rebuilt together with:

```powershell
& $env:WHITELILY_BLENDER_PATH --background --python-exit-code 12 subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend --python subprojects/whitelily-avatar/tools/blender/validate_silhouette.py -- --baseline subprojects/whitelily-avatar/assets/measurements/base-silhouette.json --output-dir subprojects/whitelily-avatar/assets/review/body-high --write-baseline
```

The ordinary no-write verification command is:

```powershell
$env:WHITELILY_BLENDER_PATH = 'C:\Users\Admin\.cache\whitelily-tools\blender-4.5.3\blender-4.5.3-windows-x64\blender.exe'
npm run avatar:anime:check -- --stage body-high
```

`front.png`, `back.png`, `left.png`, and `right.png` are fixed-camera monochrome clay reviews. `contact-sheet.png` combines those four views. `masks/` contains the six 1024×1024 alpha silhouettes used by `base-silhouette.json`; top and bottom masks are retained for future drift checks even though they are not part of the four-view clay sheet.

The evaluated `BODY_HIGH + OUTFIT_BASE` total for this promoted source is 79,468 triangles.

The body-high stage is an art review source, not a rigged, textured, armored, or publishable runtime avatar.
