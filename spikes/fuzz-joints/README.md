# Spike: Fuzz with hidden elbows and knees

Do real pivots fix the noodly poses left over from `spikes/fuzz-anime`, without giving up the tube look? This page lets
you judge by watching the hoses and the new limbs side by side.

Open `spikes/fuzz-joints/index.html` in a browser. It works straight from the file system, or from any static server
started at the repo root. The page runs the untouched `spikes/fuzz-anime/fuzz-anime.js` on the left, and uses the
anime.js copy from that folder, so keep the two spikes together.

## What's here

- **Hidden pivots** (`fuzz-joints.js`): each arm and leg moves as two equal segments that pivot at an elbow or knee,
  but it is drawn as one ringed tube that rounds the corner. The six arm rings and five leg rings are spaced along
  the whole limb, as they were on the hoses.
- **Show hinges**: a toggle on the page draws the same pivots as pinned joints, with the tube's corner left sharp.
  The two share all their motion, so you can flip between them during a reaction.
- **Elbows that find their own way**: each elbow is pulled toward a point down and out from its shoulder. That
  replaces the per-pose bend settings, and the bend comes out right in all 21 reactions: elbows drop when the hands go
  up and stick out on the hips. When a hand crosses that line the elbow swings past the viewer, so it never snaps across.
- **The studio runs here**: `spikes/fuzz-anime/studio.html` uses this rig, so this file also carries what the studio
  needs from the anime.js spike: sitting on the card, swinging legs, the slower Floss, and the transitions.
- **Wave hello**: the upper arm holds still and the forearm swings from the elbow. To change it, edit `WAVE_ARM`,
  `WAVE_DROP` and the forearm angles in the `wave()` calls.
- **Finger guns are gone**: the pose didn't read on claws, so there are 21 reactions here.
- **Same timing**: the reactions are the ones from the anime.js spike. A few poses changed: Thinking and Shrug lost
  their shortened arms because the elbow now folds, Cheer lost an exaggerated leg bend, Sit & doze and Power off rest
  their hands on the knees, and the arm in Flick antenna stretches less.

- **Bored: old tape**: a new reaction, on this rig only. Fuzz slumps, looks down, and a VHS tape pops out of the chest
  slot. The claw pulls it out and holds it up, Fuzz reads the label, turns it over to the back, then slides it home.
  It plays once and goes back to what Fuzz was doing.

## First impressions

- **Better than the hoses:** Hands on hips, the head scratch, Shrug and Arms crossed read at a glance, because an arm
  now has a clear upper and lower part.
- **Better than visible hinges:** Fuzz keeps the tube character, and the chest poses are much cleaner with no hinges
  piled on a 48-wide torso. Worried and Grateful gain the most. Claws on the chest are still the busiest part.
- **Still a cheat:** arms stretch to reach. Flick antenna's arm is about two and a half times its normal length,
  though it is easier to accept on a tube than on a jointed arm.
- **Cost:** almost nothing. A draw takes about 0.12 ms against about 0.08 ms for the hoses, on one rig in headless Chromium.
- **Not done:** dark-theme check, follow-through on the antennas and claws, and wiring any of this into the app. The
  poses were judged on still frames, and nobody has judged them at full speed yet.
