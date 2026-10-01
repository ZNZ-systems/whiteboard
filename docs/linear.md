# Whiteboard in Linear issues

Publish a saved Whiteboard as a **native rich issue attachment**. Linear shows
the review's title, version, source revisions, and section-by-section explanation
in its attachment modal. Opening the attachment's link takes you to the full
review. This does not install a custom canvas or tab in Linear's code-review UI.

The integration uses Linear's documented
[rich attachment metadata](https://linear.app/developers/attachments) and
[GraphQL API](https://linear.app/developers/graphql). It runs from the Whiteboard
CLI against either the desktop app or a headless authoring server. It needs no
browser extension, webhook receiver, or additional hosted service.

## Publish a review

1. Use a Whiteboard build containing this integration. From this repository,
   run `pnpm install --frozen-lockfile` and use `pnpm review` in place of
   `whiteboard` in the commands below.
2. Create the Whiteboard and pin it to commits. Record the review ID and saved
   version. Worktree targets must be pinned before publication.
3. Choose an HTTPS link that opens **that same review version** for your readers.
   Use your existing hosted viewer, or create an immutable Whiteboard share:

   ```sh
   whiteboard share --review <review-id> --version <version>
   ```

   Sharing is a separate, explicit step: it uploads retained images, maps, and
   full trace conversations. Anyone with the share link can download those
   resources. Repository access is still needed to fetch pinned code. Review
   the contents and audience before sharing. This integration never creates a
   share or uploads resources automatically.
4. Preview exactly what will be sent, without Linear credentials or writes:

   ```sh
   whiteboard linear attach \
     --review <review-id> --version <version> \
     --issue ENG-123 --url '<https-review-link>' --dry-run
   ```

   The output is JSON containing the attachment payload. Treat it as sensitive:
   it contains review content and the complete link, including any share capability.
5. Configure **one** credential in the command's environment through your secret
   manager: `LINEAR_API_KEY` for a personal API key, or `LINEAR_ACCESS_TOKEN` for
   an existing OAuth access token. The identity must be able to read the issue
   and create attachments. An OAuth token needs `read` and `write` access. Tokens
   are not CLI arguments and are never saved by this command. This initial
   integration does not perform OAuth registration, authorization, or refresh.
6. Publish by omitting `--dry-run`:

   ```sh
   whiteboard linear attach \
     --review <review-id> --version <version> \
     --issue ENG-123 --url '<https-review-link>' --json
   ```

   The result identifies the attachment, issue, review, and saved version. It
   does not print the credential or share link. Open the issue in Linear and
   select the attachment to read the native preview.

Use an issue identifier or UUID with `--issue`. Without `--version`, the command
reads the latest saved version once. The supplied URL is not fetched or verified;
you are responsible for matching its content and access controls to that version.
For headless authoring, place `--state-dir <directory>` before `linear`, or set
`DEV_REVIEW_SERVER_DIR`, exactly as for other Whiteboard authoring commands.

## What appears inside Linear

- Authored prose is grouped into sections. Diagram relationships are rendered
  as text, not as an interactive diagram or Mermaid embed.
- Code blocks become readable previews, not byte-identical copies: active-content
  syntax is neutralized. Code references link to pinned GitHub
  revisions when the review records a matching repository and commit; otherwise
  they remain readable source locations. The command does not fetch source files.
- Images and software maps are described rather than uploaded. Trace quotes are
  omitted. This is not a secret scanner: secrets pasted into authored prose or
  code would still be exported, so review the dry-run output.
- Large reviews get a bounded preview with a truncation notice. The full review
  remains available through the attachment link.

The preview is a copy stored in Linear and visible to everyone who can access
the issue, even if they cannot access the original repository. Revoking a
Whiteboard share does not erase the already-published preview in Linear.

## Updates and retries

Linear uses the **issue ID plus attachment URL** as an idempotent key. Re-running
the command with the same issue and URL updates the attachment, rather than
adding another. A new immutable share URL creates a separate attachment; remove
the old one in Linear if you no longer want it visible. There is no automatic
sync when a Whiteboard changes.

The command rejects HTTP failures, GraphQL errors (including partial success),
and responses without a confirmed attachment ID. On a timeout, check the issue
before retrying with the same URL. Credentials go only to Linear's fixed HTTPS
GraphQL endpoint, and redirects are refused. Raw remote errors are not printed
because they may echo credentials or private attachment content.

## Verify in your workspace

Publish to a test issue first. Check that opening the attachment shows the
section messages and revision attributes, that the full-review link opens the
intended saved version, and that publishing again with the same URL updates
rather than duplicates the attachment. Rendering and link access must be checked
in your authenticated Linear workspace; local tests exercise the real Whiteboard
snapshot API and a simulated Linear GraphQL service, not Linear's UI.
