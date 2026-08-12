# Selective vision context

## Purpose

Anodex treats image pixels as expensive, task-specific context. An image attached to a message
is always available for that message, but it is not automatically replayed to a vision model on
later turns. This keeps ordinary code, planning, and writing follow-ups text-first even in a chat
that previously contained screenshots.

## Keeping an image for follow-ups

Each image card has a **Keep for follow-ups** control. Selecting it persists
`visionContextPinned: true` on that attachment's metadata. On later messages, each vision
provider reopens only pinned historical images, newest first, within the shared four-image limit.
Selecting **Kept for follow-ups** again removes that opt-in.

The current message's image attachments remain highest priority and always consume the image
budget first. Pinned historical images only fill the unused slots.

## Visual tools

`inspect_visual` is separate from attachment recall. When the model intentionally asks to inspect
a workspace image or rendered HTML page, the captured pixels are supplied only to the next tool
round of that response. An initial long-HTML inspection samples up to three named page sections,
including the page's earliest sections; it leaves room for the model to request one specific
section by its HTML id when an area needs a closer check. The tool result remains a compact textual
record in conversation history; the pixels are not silently replayed later.

## Persistence and compatibility

Image bytes are never written into conversation JSON. Anodex persists a file reference, MIME type,
size, and the optional `visionContextPinned` flag; pixels are reopened and validated only when a
provider needs them. Existing conversations have no flag and therefore retain the safe default:
their historical images are not replayed automatically.
