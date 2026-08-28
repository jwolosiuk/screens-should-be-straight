# Screens should be straight

Point your phone's camera at a screen you can only see from an angle — a TV
across the room, a cinema screen from the front row, a monitor on someone
else's desk — and this page shows you the picture head-on, corrected live while
you move the phone around.

Everything happens in the browser. There is no backend, no database and no
upload: the camera feed never leaves the device.

## How it works

A rectangle seen from an angle projects to a quadrilateral, and the mapping
between the two is a **homography**. Recover the four corners in the camera
frame, solve for the homography, and the inverse of it un-warps the picture.
Finding those four corners, every frame, while the phone moves and the film
underneath keeps changing, is the whole problem.

**Acquire** (`js/detect.js`). With no prior guess, the screen is found as the
bright region in a darker room. A single frame is not enough — a dark scene or
a letterbox band would carve the region into pieces — so acquisition works on a
slowly decaying per-pixel *maximum* over roughly the last second. Anything that
lit up recently still counts as screen. The largest bright blob is hulled,
thinned and reduced to the largest quadrilateral inside it, then checked: does
the blob fill that quad, does the quad account for the hull, is the inside
really brighter than the outside. This is the one stage that wants the camera
held still, because the peak image smears if it moves.

**Track** (`js/track.js`). Once there is an outline, each frame refines it
instead of starting over. Twenty points along each edge look sideways for the
luminance step that marks the border of the screen. Two rules make this hold on
to the right edge:

- take the *outermost* candidate, not the strongest one — the border of the
  screen is always outside anything happening within the picture;
- judge each candidate by what lies several pixels either side of it — room on
  the outside, lit picture on the inside. A cut inside the film has picture on
  both sides and is rejected however sharp it is.

The second rule matters more than it looks. Vertical edges within a film are
exactly parallel to the sides of the screen, so a whole row of samples can
agree on the wrong line and out-vote the right one; without that test the
outline creeps inward over a few seconds and ends up following whatever is
moving on screen. Each edge is then fitted by consensus, so a hand over part of
the bezel or a reflection along one side costs nothing.

**Verify** (`js/pipeline.js`). Every frame the outline is checked for
convexity, area and sane edge lengths. A few bad frames in a row — a hand in
front of the lens, a cut to black — are coasted through rather than dropped.
Occasionally the pipeline also takes a fresh look at the whole frame: if the
lit area is much larger than what is being tracked, the outline has slipped
inside the picture and is re-seeded.

**Aspect ratio** (`js/aspect.js`). Un-warping to a fixed 16:9 box would stretch
anything that is not 16:9. The two vanishing points of the quadrilateral give
both the camera's focal length and the true proportions of the rectangle
(Zhang & He, *Whiteboard Scanning and Image Enhancement*, 2007), so the output
shape is measured rather than assumed. Near a straight-on view there are no
vanishing points to measure, which is also the case where the quad is already
almost correct, so it falls back cleanly.

**Render** (`js/render.js`). The un-warp itself is a WebGL fragment shader: for
each pixel of the output rectangle, the homography says where to read in the
camera frame. A 2D canvas cannot do this — its transforms are affine, and an
affine transform is precisely what cannot express a change of viewpoint.

Analysis runs on a 320-pixel-wide grayscale copy of each frame (about 0.6 ms
per frame on a desktop core), while the picture is rendered from the
full-resolution video.

## Using it

- Hold reasonably still for a second while it finds the screen; after that,
  move freely.
- **Adjust** — place the four corners by hand if the automatic search struggles
  (a bright room, a screen among other bright things). The tracker takes over
  from wherever you put them.
- **Shape** — `auto` measures the screen's true proportions; the fixed options
  are there when you know better.
- **Rotate** — 90° steps, for a phone held sideways or a screen mounted in
  portrait.
- **Re-scan** — forget the current outline and search again.
- Tapping the status pill toggles a small stats panel (state, confidence,
  measured aspect ratio, frame rate).

Known limits: the screen has to be brighter than its surroundings, which is the
assumption acquisition is built on. If more than one edge of the screen leaves
the frame the outline is dropped — there is nothing there to correct. Very dark
scenes lasting several seconds can lose the lock; it re-acquires by itself.

## Tests

```sh
./test/run.sh          # geometry, detection, tracking, pipeline, then jsdom
./test/run.sh --unit   # skip the jsdom pass (which installs jsdom)
```

There is no node on the host, so everything runs in a `node:22-alpine`
container. The tests build synthetic camera frames — a lit screen with changing
content, seen at an angle in a dark room — so every assertion has ground truth
to compare against: corner accuracy under 120 frames of hand-held motion, the
recovered aspect ratio of a known 16:9 rectangle, recovery after a blackout,
and refusal to lock onto a lamp or an empty room. `test/smoke.mjs` drives the
real page in jsdom with a fake camera and a fake WebGL context, and checks the
matrix that reaches the shader actually maps the output rectangle onto the
screen.

## Deploying

`./deploy.sh` copies the static files into `public/`, which the server hosts
directly. No build step.
