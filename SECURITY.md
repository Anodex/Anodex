# Security policy

Anodex runs local models, executes tools, edits files in your workspace, reaches the
network, and pairs with a phone over a channel it authenticates itself. There is a lot of
surface here, and the whole argument for publishing the source is that you should be able
to check it rather than believe it.

**Security research on Anodex is welcome.** Read it, probe it, take it apart. The licence
puts no restriction on that, and finding something is a service.

## Reporting a vulnerability

**Please report privately first, and please do not open a public issue for anything
exploitable.**

Use GitHub's private vulnerability reporting on this repository — the **Report a
vulnerability** button under the **Security** tab. It opens a private thread visible only
to the maintainer, and it is the right channel precisely because it does not tell everyone
else how to do the thing you found.

If that button is not available to you for some reason, open a public issue saying only
that you have found a security problem and asking how to send the details. Do not put the
details in it.

## What to include

As much as you would want if you were fixing it:

- what an attacker can actually do, and what they need in order to do it;
- the steps to reproduce;
- the affected version and platform;
- a proof of concept if you have one.

**Leave out anything sensitive.** Real API keys, tokens, certificates, pairing secrets,
the contents of a private mailbox, the contents of your workspace. Redact them, or
describe them. This applies to public issues especially, but to private reports too — a
report should not be the reason a credential leaks.

## What happens next

A report gets acknowledged, investigated, and answered. If it is real, it gets fixed and
shipped, and the release notes say what was wrong in enough detail to be useful without
being a recipe.

There is no bounty programme and no formal response-time commitment — one person
maintains this, and promising a window would be pretending otherwise. You will not be
ignored.

If you would like credit, say so and you will get it. If you would rather not be named,
that is fine too.

## Disclosure

Please give a reasonable chance to fix something before publishing it. What is reasonable
depends on how bad it is; if you tell me your timeline, I will tell you honestly whether
it is achievable.

Publishing a working exploit for an unfixed issue affects the people using the software,
not the person who wrote it.

## Worth knowing about the threat model

Some of these are deliberate design decisions rather than oversights, and it may save you
time to know which:

- **Anodex runs code on your machine on purpose.** Approved tool calls execute commands
  and write files. That a tool _can_ do something destructive is the feature; that it can
  do so **without an approval you actually saw** is a bug, and a serious one.
- **Prompt injection is in scope.** Content Anodex reads — a web page, an email, a file,
  a repository — is untrusted input. Anything that turns that content into an action
  taken without your consent is a real finding.
- **The phone is a display, not an authority.** The paired app cannot grant itself
  permissions the desktop would refuse. A way for it to do so is a finding.
- **Updates are signature-checked** against a key compiled into the app, and an update
  that fails verification is refused rather than warned about. A way to get an unsigned or
  wrongly-signed build installed is a serious finding.
- **Your model, your data, your machine.** Local conversations, projects and keys are not
  meant to leave it. Anything that sends them somewhere unexpected is a finding.
