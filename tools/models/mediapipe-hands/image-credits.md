# Hand gate fixture photographs

Two photographs are staged into the untracked `/hand-gate/images/` payload by
`stage-gate.sh`. They are **not committed** to the repository; only this
attribution record and their pinned digests are.

Both were chosen by running the converted models over a wider candidate set and
keeping the ones that survived — see "Selection" below. The COCO pose fixtures
used by `/pose-gate/` were rejected: they were chosen to show whole bodies, and
their hands are too small and too motion-blurred to exercise a 224×224 hand crop.

## `two-hands-sky.jpg`

| Field | Value |
| --- | --- |
| Title | Open Hands Facing The Heavens |
| Author | Mayordeeliteman |
| Source | https://commons.wikimedia.org/wiki/File:Open_Hands_Facing_The_Heavens.jpg |
| Licence | CC BY-SA 4.0 |
| Rendition | `https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/Open_Hands_Facing_The_Heavens.jpg/960px-Open_Hands_Facing_The_Heavens.jpg` |
| SHA-256 | `68cdcb3a2bc40b3e2dc6f0ae8cf1551ecd4abac661515a5ef0e75db39030b872` |
| Why | Two clearly separated open palms, arms spread, against plain sky. Detector accepts exactly two palms; presence 0.990 and 0.995; ROI rotations +72.5° and −59.8°. This is the two-hand fixture the gate's assignment and separation checks run on. |

## `one-hand-rotated.jpg`

| Field | Value |
| --- | --- |
| Title | Pride.be 2018-05-19 14-56-07 ILCE-6500 DSC08078 DxO (28675186077) |
| Author | Miguel Discart |
| Source | https://commons.wikimedia.org/wiki/File:Pride.be_2018-05-19_14-56-07_ILCE-6500_DSC08078_DxO_(28675186077).jpg |
| Licence | CC BY-SA 2.0 |
| Rendition | `https://upload.wikimedia.org/wikipedia/commons/thumb/6/64/Pride.be_2018-05-19_14-56-07_ILCE-6500_DSC08078_DxO_%2828675186077%29.jpg/960px-Pride.be_2018-05-19_14-56-07_ILCE-6500_DSC08078_DxO_%2828675186077%29.jpg` |
| SHA-256 | `340356d94b2cffc6581732c028677d24f6965939fe158a7cee09185a131b90c8` |
| Why | One hand, strongly rotated (ROI +87.8°), against a busy crowd background. Presence 0.954, 21/21 landmarks in the crop, 5/5 fingertips inside the expanded detection box. A near-upright hand would let a broken rotation term pass unnoticed; this one would not. |

Attribution is carried in the gate page itself as well as here, and share-alike
applies to the images, not to this repository's code.

## Selection

Eleven Wikimedia candidates were screened with `validate-cpu.py`. The results
are worth recording because they document the models' real limits:

| Candidate | Outcome |
| --- | --- |
| Open Hands Facing The Heavens | **kept** — 2 hands, presence 0.990 / 0.995 |
| Pride.be 2018 … DSC08078 | **kept** — 1 hand, presence 0.954, 87.8° rotation |
| 1964 Hammond Slides Student Raising Hand | usable — 1 hand, presence 0.735, but the hand is tiny |
| Stopp.jpg | weak — presence 0.766, one fingertip outside the expanded box |
| PauletteJordanIF21 | 2 hands, presence 0.644 / 0.578 — too marginal for a gate fixture |
| Biker Waving Hello | detector 0.578, **presence 0.044** — rejected by the landmark stage |
| STS-135 crew wave farewell | detector 0.583, **presence 0.017** — rejected by the landmark stage |
| Peace Sign (Unsplash) | no detection — the hand fills the frame; the palm detector wants a smaller palm |
| Massage-hand-1, Portrait India 49, Student in hijab | no detection |

The last four rows are the useful ones. Two of them show the palm detector
scoring a confident-looking 0.58 on something that is not a hand, with the
landmark model then reporting presence below 0.05. That is the concrete evidence
behind the plan's rule that confidence must come from **hand presence**, never
from a carried-over detector score.
