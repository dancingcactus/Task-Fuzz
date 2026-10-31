# Spike: Fuzz with a body

Does giving Fuzz a body, arms and legs help or hurt? This page lets you judge by watching it.

Open `spikes/fuzz-body/index.html` in a browser. It works straight from the file system, or from any static server
started at the repo root. The page loads the real `css/app.css`, `css/fuzz.css` and `js/fuzz-svg.js`, so the head,
its moods and its colours are exactly what the app ships.

## What's here

- **Rig** (`fuzz-body.js`): the head sits on a small cabinet torso with a tape slot. The arms are segmented tubes,
  like Bender's: six ring bands and no elbows. Each arm is a single curve that keeps about the same length, so it
  bows when the hand comes in close and goes straight when the hand reaches out. A pose can also make an arm a little
  longer or shorter (to reach overhead, or around the head to the antenna). The rings spread apart when an arm
  stretches, like an accordion. The hands are Lego-style C claws: a pose sets how far the claw is open, and some
  reactions snap it open and shut. The legs use the same ringed tubes (five bands each) and end in little can feet.
- **20 reactions**: idle, wave, cheer, dance, hands on hips, thumbs up, point at a task, finger guns, thinking,
  working, rushing, worried, sheepish, shrug, grateful, arms crossed, sit & doze, power off, boop, and antenna flick.
  Each one pairs an existing head mood with a body pose. Switching reactions blends from one pose to the next.
- **Show body toggle**, so you can compare against today's head-only Fuzz in the middle of a reaction.
- **Perch comparison**: today's 112 px head next to two body sizes at real app scale on a task card.

## First impressions

- **Better:** the body adds gestures the face can't make. Pointing at the task, a shrug, hands on hips, arms
  crossed, a claw on the chin, and scratching the head all land right away. The claws can't point or give a
  thumbs up, so those gestures come from where the arm aims, and the claw clack takes the thumbs-up's place. Running finally looks like running.
- **Risk:** at perch size the screen face does most of the talking. The body either pushes the card down
  about 77 px (same head size) or shrinks the face by about 30% (same footprint). Busy limbs (rush, dance) pull
  the eye away from the face.
- **Possible middle ground:** keep the head-only perch, and bring the body out only for big moments (inbox zero,
  check-in, onboarding) or have Fuzz stand on the edge of the card.
- **Not done in the spike:** the Calm setting doesn't calm the limbs yet, there's no dark-theme check, and the
  limbs are animated with JavaScript every frame (the head is pure CSS).
