# Arc

`reference.wav` is Arc's voice. Every chunk of speech is generated conditioned on
it, and that is the only reason Arc sounds like one person rather than a different
person every sentence.

It is committed rather than downloaded, unlike the model. It is 1.2 MB, it is the
product's identity, and it has to match the code that uses it — a voice that
arrives separately is a voice that can arrive wrong.

## Whose voice this is

Anodex's owner, recorded deliberately for this purpose and chosen by him from an
evening's worth of takes. Nobody else's voice was used and no public recording was
cloned. That matters beyond the legal question: a product voice borrowed from a
stranger is a thing you have to keep explaining.

Twenty-six seconds, which is all a reference needs — cloning takes timbre and
delivery from half a minute and ignores the rest. Fine-tuning, if it ever happens,
is the thing that wants hours.

## How it was chosen

By measurement, then by ear, in that order.

The target came from analysing a read-aloud that sounds considered: 140 Hz median
pitch, **40 Hz of pitch movement**, 181 words a minute. Pitch movement turned out
to be the number that matters — it is the difference between a voice that reports
things and one that sounds like it means them, and it is what "sounds
disinterested" actually measures.

Every take was scored on movement, level and noise floor, and the best 26-second
window inside each long recording was found by scanning. This one measures:

|              |                  |
| ------------ | ---------------- |
| movement     | **34 Hz**        |
| median pitch | 131 Hz           |
| peak level   | 86%, no clipping |
| noise floor  | 0                |

Later takes measured higher — up to 51 Hz — and were not chosen. They were
recorded further from the microphone, and distance puts room reflections into a
recording. Reverb can be added but never removed, and a cloner treats it as part
of the voice, so every sentence would have inherited the room. This one is closer,
drier, and won on listening.

## What was learned, for whoever records the next one

- **Movement, not pitch.** Raising a reference by resampling was tried and sounded
  plastic — the formants move with it. Getting more movement out of the delivery
  worked; shifting afterwards did not.
- **Close and quiet beats distant and loud.** Clipping and reverb are the two ways
  to ruin a reference, and backing off the microphone trades one for the other.
  Stay close, speak softly, aim for about 70% peak.
- **The best takes come late, and unscripted.** Reading the script carefully
  produced 23-30 Hz. Talking produced 49-51. Record several minutes, read it a few
  times, and let a scan find the best half minute.

## Why one fixed clip, and never chaining

Generating each sentence separately is what gives the voice a contour, and it also
lets the model invent a new speaker each time — 119, 154 and 104 Hz in a single
reply, unconditioned.

Two fixes, measured over the same eight sentences:

|                                          | spread    | wobble   |
| ---------------------------------------- | --------- | -------- |
| this clip, used for every chunk          | **24 Hz** | **8 Hz** |
| each chunk conditioned on the one before | 59 Hz     | 17 Hz    |

Chaining looked perfect over three chunks (2 Hz) and fell apart over eight,
because an odd chunk becomes the reference for the next and the error compounds.
The three-chunk result was luck. **Use this file for every chunk; never chain.**

±8 Hz between sentences is less variation than a person has, so this is good
enough to ship, and worth re-measuring if the model ever changes.

## Replacing it

Swap this file. Nothing else: no code, no migration, no rebuild of anything that
depends on it. That was the point of making the voice data rather than baking it
in, and it is why choosing a voice never had to block building the thing that
speaks.

The tools used to record and measure it are kept at `Desktop/voice recorder`.
