# Windows desktop-control runtime

This directory is populated by `npm run prepare:desktop-control` on Windows.
The generated helper is packaged as an extra resource and is the only future
desktop input bridge. It accepts a bounded JSON protocol; Anodex never routes
desktop control through a shell or arbitrary script.
