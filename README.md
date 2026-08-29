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

**Light** (`js/image.js`). Everything downstream works on one byte per pixel,
and what goes in that byte is not luminance. Brightness is the largest colour
channel, plus half the chroma. Both departures come from watching a real
outdoor screening: projected film often sits on one saturated hue for minutes,
and saturated colour carries little luminance - a deep red picture computes
dimmer than the plain grey of the screen it is projected onto - while grey is
what ambient light looks like and colour is what a projector looks like. A
black-and-white film has brightness to spare and is unaffected.

**Change** (`js/image.js` ChangeTracker, `js/pipeline.js`). The second channel,
and in a lit room the decisive one: the difference between the current frame
and a reference from a few tenths of a second ago, WARPED by the camera's own
estimated motion. The warp is not an optimisation - without it, ordinary hand
tremor lights up ghosts of every static edge in the room, and the film drowns
in them: the first version of this channel never locked at all in the very
scene it was built for unless the phone was propped against something. Motion
is estimated twice per frame by capped-loss block matching (the cap stops a
panning film or a passing person from dragging the estimate): once against the
previous frame, which is the camera's true motion, and once against the
reference, which is the warp. A saturated estimate with a HIGH residual is a
shot cut, not a pan - the camera did not move, and cuts are a film's loudest
evidence. Frames the comparison cannot be trusted on - real pans, exposure and
white-balance ramps (the whole frame's quietest decile moving at once) - are
dropped rather than folded into any memory.

A slow film moves by only a few grey levels per frame - beneath the sensor
noise - but against the half-second reference it accumulates, and noise does
not. Change is measured on the bare largest channel rather than the boosted
one, because the boost pushes a bright picture against the top of the byte and
differences taken up there come back crushed. Two memories build on it: a fast
decaying peak ("is a film playing there now") and a slow one lasting minutes
("where has a film ever played"), with the noise floor subtracted so grain
never accumulates into fake evidence.

A lamp-lit bedroom is why this exists. The wall under warm light outshines a
tablet's picture in every brightness measure, and the first version of this app
- built and tested against dark rooms - found the wall, told the user to "zoom
out until the whole screen is in view", and executed any hand-placed outline
within three frames because the wall outside it looked like stray screen light.
A wall is bright but still; a screen is bright and moving.

Brightness leads, change arbitrates. The bright blob is the screen in every
dark room - including one showing a mostly-static film whose only change is a
talking head or a subtitle strip - so a bright candidate that CONTAINS the film
wins outright; preferring change outright turned out to lock onto the subtitle
strip itself. The change candidate is the answer only where brightness has
none: the lit room, where the wall out-shines the picture and no usable bright
quad exists. A bright blob with the film substantially OUTSIDE it - a poster
beside the television - is furniture. The stray-light check (has the outline
been dragged off the screen?) demands a COHERENT region - bright, playing,
two-dimensional, and clear of a guard band around the outline - because
compensation residuals glow along the screen's own border and ghost texture
speckles single points, and a second verification round caught the check
executing perfect locks over exactly those. Its counterpart looks inward: a
lock whose interior stays part-picture, part-furniture over several looks is
wrong however confidently it tracks. The film memory fades over seconds, not
minutes, so the trail of a person walking across the frame does not veto real
screens after they have passed - and a bright quad that stays put for a full
second while nothing else is lockable overrides the veto outright.

**Acquire** (`js/detect.js`). With no prior guess, the screen is found as the
bright region in a darker room - or, once a film has been seen anywhere, as the
region where it plays. A single frame is not enough — a dark scene or
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

**Predict** (`js/pipeline.js`). Between frames, the outline moves by a motion
model built from exactly what the measured edges can testify to: their
perpendicular displacement, fitted to a translation plus a uniform scale about
the centroid. A line pins nothing along itself, and any model that reads
corner deltas swallows the unconstrained parallel component - the prediction
feeding itself. That subtlety was found the hard way twice: per-corner
velocity inflated a resting lock to three times its size, and a similarity
fitted through two collinear corners flung the free edge a hundred pixels up a
wall under nothing but hand tremor. Two opposite edges separating is a zoom,
measured; the direction no edge can see honestly stays put.

**Solve** (`js/track.js`). The outline is solved for, not intersected. Four
visible edges give four lines and eight equations for the eight corner
coordinates - which is just the four corners of the quadrilateral, arrived at
the long way round. The point is what happens when there are fewer. Zoom in,
or let someone stand in front of the screen, and some edges are not there to
measure; the equations that remain are solved together with a weak pull towards
where the camera's motion says the corners should be. Whatever the evidence
pins down, it pins down; whatever it leaves free comes from the prediction. The
corners can sit far outside the frame and still be tracked, because nothing in
the solve requires them to be visible.

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
almost correct, so it falls back cleanly. The construction goes unstable on a
few frames in every few hundred even while tracking is perfect, so readings
that come back out of range are dropped, and readings that merely disagree are
damped rather than rejected - rejecting them would let one unlucky value taken
at the moment of lock stretch the picture permanently, since every later
reading would then look like the outlier.

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
- **Stats** shows what the tracker is doing: state, confidence, the measured
  aspect ratio and how it was arrived at, how often the outline had to be
  re-seeded, and the frame rate.

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
and refusal to lock onto a lamp or an empty room. The awkward cases have their
own: a zoom that carries every corner out of the frame, an obstruction sweeping
across the screen, a screen too large to fit in the view. `screening.test.mjs`
reconstructs an outdoor screening in colour from photographs of one - inflatable
screen, unlit margins around the picture, deeply saturated content, heads of the
front row along the bottom edge - and `litroom.test.mjs` does the same for a
lamp-lit bedroom with a tablet, from a photograph of the app failing in it.
Both are the reason for several of the choices above. `test/smoke.mjs`
drives the real page in jsdom with a fake camera and a fake WebGL context, and
checks both the matrix that reaches the shader and that a pinch asks the camera
for the zoom it should.

## Deploying

`./deploy.sh` copies the static files into `public/`, which the server hosts
directly. No build step.
