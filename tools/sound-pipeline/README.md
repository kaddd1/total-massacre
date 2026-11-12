# Sound pipeline

How the CC0 source recordings become `assets/sounds/*.mp3`. The game does not need this folder:
it loads the prebuilt `js/sound-data.js`. This is the reproducible recipe: where every sound came
from and how it was processed.

## Steps

1. **Search and download** (`oga_search.py`, `oga_page.py`, `fs_search.py`, `fs_fetch.py`,
   `dl.py`, `extract.py`). The license of every page is checked and only CC0 material is kept.
   Author, link and license are stored in `oga_meta.json` and `fs_meta.json`. The Kenney packs
   come from `kenney.nl/assets/impact-sounds` and `kenney.nl/assets/rpg-audio`.
2. **Decoding** (`lab.mjs pcm`): headless Chrome decodes WAV, OGG, MP3 and FLAC to mono 44.1 kHz.
   The list of sources is `sources.json`.
3. **Processing** (`process.mjs`):
   - multi-take recordings are split into single hits or shouts by their envelope;
   - high-pass filter and short fades so nothing clicks;
   - loudness normalised by K-weighted RMS (100 ms window maximum for short sounds, average for
     loops) with a −1 dBFS peak ceiling;
   - loops are cross-faded and encoded wrapped as [tail | loop | head]; the bundle stores the
     exact length and a fingerprint of the first 512 samples, and the game cuts the loop by that
     fingerprint, so MP3 encoder delay and padding never leave a gap or click at the seam;
   - MP3 encoding: 80 kbit/s for hits and loops, 64 kbit/s for voices.

   The script writes `assets/sounds/*.mp3`, `manifest.json` and `CREDITS.md`.
4. **Bundle**: `node tools/build-sound-bundle.mjs` packs the MP3 files into `js/sound-data.js`
   (base64), so the game works from `file://` and offline.

## Running

```
cd tools/sound-pipeline
npm install --no-save @breezystack/lamejs      # MP3 encoder, needed by the pipeline only
set TM_SOUND_WORK=<folder with dl/ and pcm/>    # defaults to ./work
node lab.mjs pcm <items.json> <work>/pcm        # decode the sources
node process.mjs ../..                          # process and write assets/sounds
cd ../.. && node tools/build-sound-bundle.mjs   # build js/sound-data.js
```

The source archives (~1 GB) are not part of the repository; they can be downloaded again from the
links in `CREDITS.md`.

## Replacing a single sound

Put your MP3 (mono, 44.1 kHz, about −14…−12 dB RMS, with silence at the edges) over the file in
`assets/sounds/` with the same name and run `node tools/build-sound-bundle.mjs`. The category of
a sound is given by its name prefix (`clash_`, `death_` …); the categories are listed in
`manifest.json`. If you change a source, update `CREDITS.md`.
