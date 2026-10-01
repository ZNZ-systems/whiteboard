# Whiteboard inside Linear

The browser extension mounts the existing Whiteboard canvas inside a Linear
issue. Diagram steps open their pinned source, code can be inspected in an
adjacent pane, and the review's diff and commits remain in the same page. This is
not a Markdown export or an outbound link to another application.

This first release is a **local, read-only viewer** for explicitly selected saved
reviews. It is not a hosted team service, a Linear-native plugin, or a Chrome Web
Store release. It does not run in the Linear desktop or mobile apps. It requires
Chromium 140 or newer and a running Whiteboard headless server on the same machine
as the browser.

## Build and load

From this repository, with the documented Node 24 and pnpm 11 toolchain:

```sh
pnpm install --frozen-lockfile
pnpm browser:build
```

Open Chrome's Extensions page, enable Developer mode, choose **Load unpacked**,
and select `apps/review-browser/dist`. Pin Whiteboard in the browser toolbar if
you want a shortcut to its settings. Rebuild and choose **Reload** on the
Extensions page after changing extension code; reload open Linear tabs too.

The build compiles its protocol dependencies before the canvas. It bundles all
executable code locally. Database edge routing runs in the extension service
worker because restrictive host-page CSPs can prohibit WebAssembly compilation
from content scripts. The canvas itself remains in the issue page.

## Connect an existing review

1. Start the server against the profile that holds your saved reviews:

   ```sh
   pnpm review server start --state-dir /path/to/review-profile
   ```

   With an installed CLI, use `whiteboard server start` instead of `pnpm review
   server start`. The default headless profile is `~/.dev`, or `DEV_REVIEW_HOME`
   when configured. Desktop's profile is normally under
   `~/.dev/review-desktop/state`; select that profile explicitly to read its
   reviews. Keep the server running. This command does not create a review.

2. Open the extension's settings and import the server's private discovery file,
   `/path/to/review-profile/review-server/server.json`. The extension verifies
   the server identity before storing the connection. Do not paste or send this
   file to anyone: it contains a local API credential.

3. Open a Linear issue, choose it in settings, select a local saved review, and
   choose **Bind saved review to issue**. A full issue URL can also be entered.
   The binding includes the workspace, issue identifier, review ID, and saved
   version; the extension never guesses which review belongs to an issue.

4. Return to the issue and choose **Open Whiteboard**. Select a diagram step to
   read the corresponding code. **Open source** opens an adjacent source pane,
   not an editor application or another browser tab. The extension panel can be
   closed to return to the issue.

5. After the author saves another version, choose **Refresh saved version** to
   deliberately advance this binding. Until then, the diagram and its source
   stay at the selected version. Selecting a different review requires settings.

An agent can continue authoring through the existing CLI or MCP interface against
the same profile. For example, `whiteboard --state-dir /path/to/review-profile
api tools` lists the authoring tools. Browser authoring, review submission,
viewed-state writes, sharing controls, split-diff layout, and source-tree
navigation are intentionally unavailable in this release.

## Source fidelity

Use a commit-pinned review for immutable source inspection. The existing server
can read live working-tree files even when a review version is specified, so the
browser refuses those unpinned source reads rather than presenting current code
as historical evidence. Explicit immutable source references in a worktree
review remain usable.

The source viewer displays base/head line numbers and highlights the authored
ranges. It is a lightweight read-only viewer, not the desktop's Monaco editor;
language-server navigation and editing are not included.

## Privacy and permissions

- The extension requests storage plus host access to `linear.app` and loopback
  `127.0.0.1`. It makes no Linear API calls and posts no attachments or comments.
- The private server credential stays in local extension storage restricted to
  trusted extension contexts. It is not browser-synced, logged, displayed,
  embedded in page URLs, or passed to the content script.
- The content script can request only its issue's explicitly bound review and
  version. The background validates sender identity, current tab URL, routes,
  source pins, resource membership, and binding state before returning data.
  It rejects arbitrary URLs, redirects, writes, and cross-review requests.
- Rendered review text and code are part of the Linear page's DOM. Linear's page
  scripts can inspect that DOM. Shadow DOM isolates styles, **not confidential
  data**. Bind only reviews you are comfortable displaying in that host.
- Loopback responses have an 8 MiB limit and a 15-second timeout. Graph routing
  also validates and bounds its inputs. Large reviews may need to be split.
- Navigating to a different issue, closing the panel, removing a binding, or
  disconnecting tears down the current view. A late response cannot populate a
  newly selected issue. Disconnecting clears the credential and bindings.

Restarting the server rotates its credential; reimport the current discovery
file. Connecting a different server clears old issue bindings. Remove the
extension to remove its browser-local configuration.

## Verification

```sh
pnpm --filter @dev.fast/review-browser typecheck
pnpm --filter @dev.fast/review-browser test
pnpm exec playwright install chromium
pnpm --filter @dev.fast/review-browser test:e2e
```

The end-to-end test loads the **packaged extension** into Chromium using its
supported extension-debugging API, starts the real authenticated Whiteboard
server, creates a Git repository and saved review, and exercises pairing,
binding, diagrams, pinned code, refresh, and navigation cleanup. Its host page is
an explicitly labeled **synthetic Linear fixture** with restrictive CSP; it does
not prove compatibility with an authenticated live Linear page.

Set `WHITEBOARD_E2E_ARTIFACTS` to a directory to retain screenshots and recordings.
Do not present those fixture captures as live Linear screenshots. Live Linear
verification additionally requires a signed-in browser session and a real issue.

Before public distribution, complete the store/privacy and third-party license
review, particularly the LGPL `libavoid-js` and EPL `elkjs` obligations documented
in `packages/review/THIRD_PARTY_NOTICES.md`. The extension's static libavoid
binding transformation is source-controlled in
`apps/review-browser/libavoid-csp.ts`; it checks the exact upstream distribution
and fails the build if it changes. Hosted multi-user access, OAuth, billing, and
automatic cross-machine delivery are separate product work, not features of this
local release.
