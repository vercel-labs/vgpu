# Big Buck Bunny excerpt

`big-buck-bunny-360p-glide.mp4` is a modified excerpt of **Big Buck Bunny**.

- Creator and copyright: © 2008 Blender Foundation / [www.bigbuckbunny.org](https://www.bigbuckbunny.org/)
- Project and attribution terms: [Blender Peach Open Movie](https://peach.blender.org/about/)
- License: [Creative Commons Attribution 3.0 Unported](https://creativecommons.org/licenses/by/3.0/)
- Official source artifact: [BigBuckBunny_640x360.m4v.zip](https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_640x360.m4v.zip)
- Retrieved: 2026-09-21
- Source archive SHA-256: `7118242b6728d40c871479c5b3c0f0fb27d748089df15d7f1b469f297c74a2d6`
- Extracted `BigBuckBunny_640x360.m4v` SHA-256: `738e2f999860553d056dd79c952f58f63cbb73892a57c72342ce9e5330d9d2d7`

The committed file is a derivative: it selects the 10.4-second flying-squirrel shot beginning at
398.95 seconds, removes audio, scales the source's 640×359 video to square-pixel 640×360, converts
24 fps to 30 fps, encodes H.264 High Profile at CRF 22, and adds title, artist, and license metadata.
This use does not imply endorsement by the Blender Foundation.

Reproduction command, run with FFmpeg 8.0.1:

```sh
ffmpeg -ss 398.95 -i BigBuckBunny_640x360.m4v -an \
  -vf "scale=640:360:flags=lanczos,setsar=1,fps=30" -frames:v 312 \
  -c:v libx264 -profile:v high -crf 22 -preset veryslow -movflags +faststart \
  -metadata "title=Big Buck Bunny (excerpt)" \
  -metadata "artist=Blender Foundation" \
  -metadata "copyright=CC BY 3.0" \
  big-buck-bunny-360p-glide.mp4
```

Committed output SHA-256: `8b1644dfdd43cec98454d8a7f51fa95acc1d5aa4fe85af25cad5c4784a70f056`
(531,437 bytes; 312 frames; 10.4 seconds; no audio).
