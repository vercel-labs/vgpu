# Depth fixture image credits

Two indoor photographs drive the depth gate (and are the candidates for the
example's committed default source). Both are redistributable; both were chosen
because they contain a clear near/far layering the model must reproduce.

`stage-gate.sh` downloads them from the pinned Wikimedia upload URLs and verifies
the SHA-256 digests below.

## room-a.jpg — modern living room

| Field | Value |
| --- | --- |
| Title | *Modern living room with stylish furniture and a view of the outdoors in a cozy apartment setting* |
| File page | https://commons.wikimedia.org/wiki/File:Modern_living_room_with_stylish_furniture_and_a_view_of_the_outdoors_in_a_cozy_apartment_setting.jpg |
| Author | Shixart1985 (own work) |
| License | CC BY 2.0 — https://creativecommons.org/licenses/by/2.0 |
| Original | 7360×4912, 23,676,053 bytes, Commons SHA-1 `215202ba1ee88e690d0230a1b4638a9a2af3fbef` |
| Retrieved rendition | 1280 px wide thumbnail, `https://upload.wikimedia.org/wikipedia/commons/thumb/4/49/Modern_living_room_with_stylish_furniture_and_a_view_of_the_outdoors_in_a_cozy_apartment_setting.jpg/1280px-Modern_living_room_with_stylish_furniture_and_a_view_of_the_outdoors_in_a_cozy_apartment_setting.jpg` |
| Local bytes | 258,906 bytes, 1280×854 |
| SHA-256 | `3d0ca0c9289afd6d1228481c57119c394603277946f22a70f90c6633f6f6cc80` |
| Required attribution | "Modern living room… by Shixart1985, CC BY 2.0, via Wikimedia Commons" |

## room-b.jpg — furnished bedroom with a doorway

| Field | Value |
| --- | --- |
| Title | *Larkspur Bedroom & Dressing Room (2) 2024-10-08* |
| File page | https://commons.wikimedia.org/wiki/File:Larkspur_Bedroom_%26_Dressing_Room_(2)_2024-10-08.jpg |
| Author | Andy Li |
| License | CC0 1.0 (public-domain dedication) |
| Retrieved rendition | 1280 px wide thumbnail, `https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Larkspur_Bedroom_%26_Dressing_Room_%282%29_2024-10-08.jpg/1280px-Larkspur_Bedroom_%26_Dressing_Room_%282%29_2024-10-08.jpg` |
| Local bytes | 338,848 bytes, 1280×964 |
| SHA-256 | `8f83f23be3759c7655590ebad24d572036d7f9767ad569bbc8b92cc55fc614d6` |
| Required attribution | none (CC0); credited anyway |

## Rejected candidates

| Image | Why rejected |
| --- | --- |
| *Interieur woonkamer — Living Room Interior (5260603106)* (Flickr Commons, "no known copyright restrictions") | monochrome 1920s archival photo: the model is out of domain on it (10% of pixels clamp to 0 m, max 19 m) |
| *Home interior, living room furniture LCCN2016825250* (LoC, public domain) | same problem: monochrome archival plate |
| *Interior of living room 01* | CC BY-SA 4.0; share-alike is avoided for a committed asset |

If `room-a.jpg` becomes the example's committed default
(`apps/docs/public/examples/depth-estimation/source.jpg`), the CC BY 2.0
attribution must be reproduced in the example page, not only in this file.
