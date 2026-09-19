# Arc

`reference.wav` is Arc's voice. Every chunk of speech is generated conditioned on
it, and that is the only reason Arc sounds like one person rather than a
different person every sentence.

It is committed rather than downloaded, unlike the model. It is 350 KB, it is the
product's identity, and it has to match the code that uses it — a voice that
arrives separately is a voice that can arrive wrong.

## Where it came from

Ten candidates were generated unconditioned, then measured against the profile of
a read-aloud that sounds considered: 140 Hz median pitch, 40 Hz of pitch movement,
181 words a minute. This one fitted best — and notably had the most pitch
movement, which is the hardest of the three to come by and the one that reads as
intelligence rather than recitation.

Nobody's voice was cloned. It is the model's own range, chosen by measurement.

## Why one fixed clip, and never chaining

Generating each sentence separately is what gives the voice a contour, but it also
lets the model invent a new speaker each time — 119, 154 and 104 Hz in a single
reply, unconditioned.

Two fixes were measured over the same eight sentences:

|                                          | spread    | wobble   |
| ---------------------------------------- | --------- | -------- |
| this clip, used for every chunk          | **24 Hz** | **8 Hz** |
| each chunk conditioned on the one before | 59 Hz     | 17 Hz    |

Chaining looked perfect over three chunks (2 Hz) and fell apart over eight,
because an odd chunk becomes the reference for the next and the error compounds.
The three-chunk result was luck. **Use this file for every chunk; never chain.**

±8 Hz between sentences is less variation than a person has, so this is good
enough to ship and worth re-measuring if the model changes.
