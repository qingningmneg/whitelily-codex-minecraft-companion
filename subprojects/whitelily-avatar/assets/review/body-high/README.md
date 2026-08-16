# Body-high clay review

Generated from the controlled Blender 4.5.3 source with:

```powershell
$env:WHITELILY_BLENDER_PATH = 'C:\Users\Admin\.cache\whitelily-tools\blender-4.5.3\blender-4.5.3-windows-x64\blender.exe'
npm run avatar:anime:check -- --stage body-high
```

`front.png`, `back.png`, `left.png`, and `right.png` are fixed-camera monochrome clay reviews. `contact-sheet.png` combines those four views. `masks/` contains the six 1024×1024 alpha silhouettes used by `base-silhouette.json`; top and bottom masks are retained for future drift checks even though they are not part of the four-view clay sheet.

The body-high stage is an art review source, not a rigged, textured, armored, or publishable runtime avatar.
