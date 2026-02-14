# 3D Models for AR Face Tracking

## 📁 Required Files

Place your GLB/GLTF models in this directory with these exact names:

- `glasses.glb` - Sunglasses or glasses model
- `beard.glb` - Beard model  
- `mustache.glb` - Mustache model
- `hair.glb` - Hair/wig model

## 📐 Model Recommendations

### Scale & Pivot Point
- **Origin (0,0,0)** should be at the CENTER of the accessory
- **Unit scale**: Approximately 1 unit = 1 meter (adjust in Blender before export)
- Models will be scaled automatically based on face size

### Glasses
- Position: Center between eyes
- Orientation: Looking forward (Z-axis toward viewer)
- Recommended width: ~15cm in Blender units

### Beard
- Position: Center at chin/lower face
- Orientation: Facing forward
- Recommended size: ~10-12cm width

### Mustache  
- Position: Center above upper lip
- Orientation: Facing forward
- Recommended size: ~8-10cm width

### Hair
- Position: Center at top of head
- Orientation: Facing forward
- Recommended size: ~20-25cm (covers head)
- Tip: Origin should be at the crown of the head

## 🎨 Materials

- **Textures**: Embedded in GLB (recommended) or separate files
- **Transparency**: Alpha channel supported
- **PBR Materials**: Metallic/Roughness workflow preferred
- **Colors**: RGB + Alpha

## 🛠️ Export Settings (Blender)

1. Select object(s)
2. File → Export → glTF 2.0 (.glb)
3. Settings:
   - ✅ Format: glTF Binary (.glb)
   - ✅ Include: Selected Objects
   - ✅ Transform: +Y Up
   - ✅ Geometry: Apply Modifiers
   - ✅ Materials: Export
   - ✅ Compression: None (or Draco if size is an issue)

## 🔍 Testing Your Models

After placing the files:
1. Refresh the browser (Ctrl+F5)
2. Check browser console for loading messages:
   - ✅ `Loaded 3D model: [name]`
   - ❌ Error messages if files are missing/corrupted

## 📦 Where to Get Models

### Free Sources
- **Sketchfab**: https://sketchfab.com (filter by "Downloadable")
- **Poly Pizza**: https://poly.pizza
- **Quaternius**: https://quaternius.com

### AI Generation
- **Meshy.ai**: Text-to-3D in minutes
- **CSM.ai**: Image/text to 3D model
- **Rodin**: AI 3D generation

### Manual Creation
- **Blender** (free): https://blender.org
