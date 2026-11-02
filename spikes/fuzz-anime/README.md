# Spike: Fuzz's body, moved with anime.js

Can the body from `spikes/fuzz-body` move more normally if anime.js runs its animations? This page lets you judge by
watching the old and new versions side by side.

Open `spikes/fuzz-anime/index.html` in a browser. It works straight from the file system, or from any static server
started at the repo root. The page loads the real `css/app.css`, `css/fuzz.css` and `js/fuzz-svg.js`, and runs the
untouched `spikes/fuzz-body/fuzz-body.js` as the Before. anime.js 4.5.0 is checked in under `vendor/`, so there is no
install step and nothing loads from a CDN.

## What's here

- **Same rig, new motion** (`fuzz-anime.js`): the head, torso, ringed limbs and claws are drawn exactly as in the first
  spike, so any difference you see comes from the motion.
- **21 reactions**: the first spike's 21, minus Finger guns, plus Bored: old tape. Each is now a short list of key poses
  instead of a sine wave per joint. A pose says how long it takes to get there, how long to stay, and which ease to use.
- **Bored: old tape**: Fuzz slumps, a VHS tape pops out of the chest slot, and the claw holds it up to read both sides
  before sliding it home. It plays once and goes back to what Fuzz was doing. Only After knows this one.
- **Side by side**: one set of buttons plays the reaction on both, large and at app size on a task card.
- **Sitting on the card**: Sit & doze and Power off hop onto the top edge of the card below and dangle their legs over
  its front. The swing runs on its own clock, like the breath, and a pose only sets how big it is, so the legs settle
  and hang still for Sit & doze, and sway to a stop on Power off. Any standing reaction hops back up first.
- **Slow motion, Calm and Cycle through all**. Calm now reaches the limbs: Fuzz does the gesture once and holds still.

## The studio

`spikes/fuzz-anime/studio.html` is Fuzz on its own, for refining the motion. It runs on the jointed rig in
`spikes/fuzz-joints/fuzz-joints.js`, not on the hoses in this folder, so elbows and knees solve themselves and there are
no arm bend fields. Your edits stay in this browser, survive a reload, and never touch the code. To keep them, use
**Copy changes** and paste the result into `fuzz-joints.js`, or hand it to Claude.

- **Beats:** change the timing, ease and pose of any beat, or duplicate, delete and reorder beats. Clicking into a pose
  field freezes Fuzz on that beat, so you see each change as you type. Changing timing replays the reaction.
- **Transitions:** pick **Start from** to replay the move between any two reactions from the same place each time.
  Sit down and Get up can be edited like reactions. **Feel** holds the settings that shape every reaction: how much the
  hips lead the arms and head, and how Fuzz leaves whatever it was doing.
- **Emotions:** every head mood is shown live. Click one to use it for the reaction, or for the frozen beat. The moods
  themselves are CSS in `css/fuzz.css`, so their own motion can't be edited here.
- **Playback:** Space plays and pauses, the arrow keys step one frame, R replays. Speed goes down to 10%, and Repeat
  loops a transition. A small Fuzz on a card plays alongside at app size.

## Why it looks different

- **Holds.** Fuzz gets somewhere and stops. About 80% of the frames in Idle, Point and Arms crossed are still, apart
  from a slow breath that runs underneath.
- **Anticipation.** A jump starts with a dip and a shrug with a small sink.
- **Weight.** A jump rises on `out()` and falls on `in()`, which is the shape of a real arc. Sit & doze sinks slowly
  and catches itself fast, which one sine wave can't do.
- **Overlap.** In every pose the hips move first, then the arms, then the head, then the claws.
- **Arcs.** Hands are stored as an angle and a reach from the shoulder, so they swing instead of sliding in a straight line.

## First impressions

- **Better:** the gestures now have a start and a finish, so Shrug, Point, Cheer and Wave read as one deliberate action
  rather than a constant wobble. At app size Fuzz is also calmer, because the limbs spend most of their time still and
  leave the face to do the talking. That should ease the first spike's worry about busy limbs pulling the eye from the face.
- **What anime.js gave us:** a timeline, a good set of eases, and global speed control. The improvement comes mostly
  from authoring key poses, not from the library. The same reactions could probably run on a small hand-written
  tweener with no dependency (untested), but we would be rebuilding what anime.js already does well.
- **Cost:** 118 KB minified, 41 KB gzipped, for the whole library. The app has no build step, so we can't tree-shake it.
  Reactions take more lines too (about 165 against 95), though they are easier to adjust: a timing is a number on a pose.
- **Still JavaScript every frame.** anime.js tweens the numbers, but the limbs are still recomputed and redrawn from them.
  That part costs the same as before.
- **Limits of this spike:** the limbs are still bendy hoses, so a fully bent arm can look noodly however well it moves
  (Thinking and Arms crossed are the tightest). Arm layers still flip instantly, so leaving Floss can pop an arm from behind the
  torso. The timings were tuned on frame-by-frame sheets, and nobody has judged them at full speed yet.
- **Seated Fuzz needs room:** the legs hang about 35 px down the card at app size, so here Fuzz perches to the right of
  the title. A real card with a long title would need the same space kept clear.
- **Not done:** dark-theme check, and wiring any of this into the app.
