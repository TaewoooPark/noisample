<h1 align="center">Nois(ampl)e</h1>

<p align="center"><strong>The room is already playing.</strong></p>
<p align="center"><em>Catch a peak. Give it a pulse. Let it go.</em></p>

<p align="center">
  <a href="https://taewooopark.github.io/noisample/">Open Nois(ampl)e</a> ·
  <a href="#the-entire-workflow">Workflow</a> ·
  <a href="#six-voices-one-room">Voices</a> ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/JavaScript-f2f2f2?style=flat-square&logo=javascript&logoColor=666666" alt="JavaScript">
  <img src="https://img.shields.io/badge/Web_Audio-f2f2f2?style=flat-square&logoColor=666666" alt="Web Audio">
  <img src="https://img.shields.io/badge/120_BPM-f2f2f2?style=flat-square" alt="120 BPM">
  <img src="https://img.shields.io/badge/Browser_local-f2f2f2?style=flat-square" alt="Browser local">
</p>

<p align="center">
  <img src="./docs/assets/hero.png" alt="Nois(ampl)e — a passing waveform opens into fragments of rhythm" width="100%">
</p>

## Why Nois(ampl)e?

A cup meets a table. A chair shifts. Someone laughs across the room. These sounds pass through the day without asking to become music. Repeat one of them, and something changes: you begin to expect its return. An accident acquires a place in time.

Nois(ampl)e makes that small change audible. The microphone catches brief peaks, cuts them into samples and gives them positions in a steady beat. The clock stays at 120 BPM while the room supplies the texture. A familiar rhythm holds together sounds that have never met before.

Read the parentheses in **Nois(ampl)e** as an amplifier inside noise: a reminder that attention can make an ordinary sound feel larger. The screen follows the same idea. One passing waveform becomes six lines of recurring fragments. There are no visible words or instrument controls to negotiate; you make a sound and hear what happens to it.

The piece lasts for a visit. Refresh, and its collected sounds disappear. The next beat begins with whatever is happening now.

## Start in 60 seconds

[Open Nois(ampl)e](https://taewooopark.github.io/noisample/), tap the screen and allow microphone access. Clap, tap a surface or make a short vocal sound. Watch each captured fragment travel into a lane, then listen as the playhead returns to it.

<p align="center">
  <a href="https://taewooopark.github.io/noisample/">
    <img src="./docs/assets/qr.png" alt="Scan to open Nois(ampl)e on your phone" width="180">
  </a>
  <br>
  <a href="https://taewooopark.github.io/noisample/">Scan, touch, listen.</a> ·
  <a href="./docs/assets/qr.svg">Print the QR</a>
</p>

Keep the page open while playing. Headphones help separate the room's sound from the beat coming back through the microphone. The refresh icon clears the session; tap the screen again to begin collecting.

## The entire workflow

```text
1. Touch. Let the browser connect to your microphone.
2. Make a sound. A peak rises above the surrounding level.
3. Watch it move. The captured fragment settles into an instrument lane.
4. Listen again. More sounds fill the beat and replace older textures.
5. Refresh. Let this room's rhythm go and start another.
```

Sampling, placement and playback are automatic. Each session chooses one of six two-bar presets: three boom bap grooves and three trap grooves. All use 4/4 at 120 BPM. There is no genre selector; a fresh session makes a fresh choice.

## Six voices, one room

| Lane, top to bottom | How the recording becomes an instrument |
|---|---|
| Kick | A short loop cut from the recording, filtered low with a falling pitch and a trace of the original attack. |
| Snare | A clipped, high-pass version of the recorded texture with a quick decay. |
| Bass | A looped grain from the recording, filtered and repitched into a repeating low phrase. |
| Closed hi-hat | Driven, normalized high-frequency detail, pitched up and cut short. |
| Open hi-hat | A brighter version of the texture with a longer decay. |
| Percussion | A brief, band-pass accent that retains some of the source's character. |

Low-frequency energy, brightness, zero crossings and decay guide the assignment. Empty lanes take priority so the first six accepted sounds fill the instrument. Each lane holds up to three recordings, limited by its available pattern positions; new arrivals eventually replace its oldest sound. The rhythm stays legible while its material changes.

Every voice starts with captured microphone audio. The instrument uses no prerecorded drum pack, generative model or remote audio service.

## A small control dictionary

| What you see or do | What it means |
|---|---|
| Touch the canvas / focus it and press `Enter` or `Space` | Starts the microphone and audio, or resumes an interrupted session. |
| Microphone outline | Ready to start. |
| Rotating arc | Waiting for microphone access. |
| Small black dot | Listening and collecting. |
| Crossed microphone | Access was denied or the microphone could not connect. Check the browser's site permissions, then touch again. |
| Pause mark | Audio was interrupted; touch to resume. |
| Moving vertical line | The current position in the two-bar loop. |
| Refresh icon / browser reload | Discards every sample and starts an empty session. |

Status messages are available to screen readers. Reduced-motion preferences remove the traveling sample animation while preserving the waveform and timing display.

## From a peak to a pulse

An `AudioWorklet` measures the input against an adaptive noise floor. A minimum threshold, onset check, quiet rearm period and cooldown keep silence and sustained sounds from filling the sampler repeatedly. Captures include a short pre-roll and last roughly 160–360 ms. Playback-aware thresholding and browser echo cancellation help reduce self-triggering.

The captured fragment is cleaned, shaped for its assigned voice and placed on the selected pattern. It becomes playable at a sixteenth-note boundary after its placement animation. Web Audio's clock schedules the sound independently of the canvas animation; swing, velocity accents and small bass variations give the fixed pattern movement.

The threshold uses **dBFS**, the microphone signal's digital level. It is not a calibrated measurement of environmental sound pressure in dB SPL. Sensitivity and feedback depend on the device, its speaker level and the room.

## Let the moment pass

Captured audio stays in this page's memory. It is never uploaded or written to browser storage. Refreshing or closing the page releases the recordings. Each phone builds its own beat; sessions are not synchronized across devices.

There is no save, export or account flow. The reset button belongs to the instrument: it makes room for a different set of sounds and a different moment of attention.

## The instrument in view

| At a desk | In your pocket |
|---|---|
| ![Desktop Nois(ampl)e](./docs/screenshots/desktop.png) | ![Mobile Nois(ampl)e](./docs/screenshots/mobile.png) |

These are actual interface captures driven by a synthetic microphone during browser testing. The cover image is an AI-generated interpretation of the instrument, separate from the interface screenshots. Its [generation prompt and provenance](./docs/assets/hero-prompt.md) are included.

## Development

Node.js 24 recommended. There are no runtime packages to install and no build step.

```bash
git clone https://github.com/TaewoooPark/noisample.git
cd noisample
npm run dev

npm run check
npm test
```

The local server runs at `http://localhost:4173`. `dist/capture-worklet.js` detects and extracts transients. `dist/engine.js` manages the microphone, sample voices, presets and audio scheduling. `dist/app.js` draws the waveform, sample movement and sequencer. Tests exercise capture behavior, noise adaptation, sample limits, timing, reset and permission cleanup.

Pushes to `main` run checks and tests, then publish `dist/` through GitHub Pages. Relative module and worklet URLs support the `/noisample/` project path. No application server or API credentials are required.

Microphone access needs HTTPS or localhost and a user gesture. A phone opening a development machine's LAN HTTP address does not get the localhost exception. Open the published site directly in a current browser if an embedded preview blocks microphone access. Locking the phone, taking a call or changing apps may interrupt audio; return to the page and touch to resume.

Desktop and phone-sized browser layouts and synthetic microphone playback have been checked. Physical iOS/Android microphone behavior and acoustic feedback remain device-testing work.

---

Made by [Taewoo Park](https://taewoopark.com) · [GitHub](https://github.com/TaewoooPark)

*Aligning physics, code, and culture toward a civilization-scale solution.*
