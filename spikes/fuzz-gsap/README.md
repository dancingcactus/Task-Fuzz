# Spike: Fuzz on GSAP

Does swapping anime.js for GSAP make Fuzz move any better? This page runs the two side by side.

Open `spikes/fuzz-gsap/index.html` in a browser. It works straight from the file system, or from any static server
started at the repo root. GSAP 3.15.0 is checked in under `vendor/`. The left side runs
`spikes/fuzz-joints/fuzz-joints.js` and the anime.js copy in `spikes/fuzz-anime/vendor/`, so keep the three spikes together.

## What's here

- **An engine swap and nothing else** (`fuzz-gsap.js`): the rig, poses and timing are the ones from `spikes/fuzz-joints`.
  Only the calls into the engine changed, and a small `ease()` function gives GSAP the same curves.
- **One deliberate difference**: Worried trembles on a single GSAP CustomWiggle ease that fades out, where anime.js
  steps through five authored poses.

## Findings

- **Motion: no difference.** Seeking both engines to the same moments, every pose channel matched to within 0.001
  through all 22 reactions and all 18 loops, except Worried, which differs on purpose. GSAP can't look better here
  because it is producing the same numbers.
- **Speed: no measurable difference.** With four Fuzzes dancing, anime.js used 9.1 to 9.5 ms of script per second and
  GSAP 8.4 to 11.3 ms, in headless Chromium. The runs overlap.
- **Size: GSAP is a little smaller.** 82 KB minified and 32 KB gzipped with the two wiggle plugins, against 118 KB and
  41 KB. Neither can be tree-shaken without a build step.
- **Authoring: a small win for GSAP.** Five poses of Worried became one line, and CustomWiggle has no direct anime.js
  equivalent. Worried is the only place that was tried.
- **Porting was easy.** Only the engine calls moved, so going either way later would be a small job. The rig needs
  nothing from either engine beyond timelines, eases and a tick.
- **License: anime.js is MIT, GSAP is not.** GSAP uses its own no-charge license at https://gsap.com/standard-license.
  Those terms were not reviewed here, so read them before shipping it.

## Recommendation

Stay on anime.js unless a GSAP feature is wanted for its own sake. The improvements so far came from key poses and the
rig, and the next ones (antenna and claw follow-through, interruptions that keep their speed) don't depend on the engine.

## Not done

Worried's wiggle was checked by sampling its values and still frames, and nobody has judged it at full speed yet. Other
GSAP features such as InertiaPlugin were not tried, and neither was a dark-theme check.
