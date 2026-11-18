# Label History for Confluence

[![Check](https://github.com/srcplugins/atlassian-confluence-label-history/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/srcplugins/atlassian-confluence-label-history/actions/workflows/check.yml?query=branch%3Amain)

**Label history for your Confluence pages.**

See who added or removed labels on your Confluence pages, and when. Review the history and restore a label removed by mistake.

[Website](https://srcplugins.com/plugins/atlassian/label-history-for-confluence/)

## Features

- **Track label changes.** Select **Label History** under a page's title to see its latest 100 changes, newest first, with who made each one and when.
- **Restore removed labels.** Choose **Restore** next to a removal and confirm. The label is added back as you and recorded under your name. You need permission to edit the page.
- **Ask Rovo.** Ask the read-only **Label History for Confluence** agent about up to 20 recent changes on a page you can view.

History starts at installation, in every space, personal spaces included. Only page labels are recorded, excluding personal (`my:`) and team (`team:`) labels. Changes on pages whose view restriction excludes the app aren't recorded. No configuration is required.

For installation, usage, limits and troubleshooting, see the [website documentation](https://srcplugins.com/plugins/atlassian/label-history-for-confluence/).

## Changes to Confluence

- **Installation:** adds **Label History** under each page's title and, where Rovo is available, the read-only **Label History for Confluence** agent.
- **Restore:** adds one removed label back to a page as the current user.
- **Uninstallation:** existing pages, labels and spaces stay unchanged.

The app never removes labels or changes page content or spaces.

## Permissions

History reads and restores respect Confluence's user permissions. You can view history only for pages you can access and restore labels only on pages you can edit, excluding archived pages. Trashed and deleted pages show no history. The app reads each page as you, so it shows only what Confluence shows you. Recording runs from Confluence's events, as the app.

| Scope | Purpose |
| --- | --- |
| `read:confluence-content.summary` | Receive label added and label removed events. |
| `read:confluence-space.summary` | Receive label events with their space. |
| `read:page:confluence` | Read page titles, check view and edit access, and check labels before restoring. |
| `report:personal-data` | Report the stored account IDs to Atlassian each week, as its user privacy rules require, and learn which accounts were closed. |
| `storage:app` | Store recorded label changes. |
| `write:confluence-content` | Restore removed labels and receive page deletion events to remove their history. |

## Data

Label History stores page IDs, the label's ID and name, whether it was added or removed, when and the actor's account ID in Atlassian Forge, and for each account ID when the app first stored it. Page titles are read as you when needed; page content, other labels, display names and email addresses aren't stored. History has no time limit: a page's older changes are removed only as new ones are recorded. Each week the app reports the account IDs it stores to Atlassian; when an account is closed, its ID is removed and its changes show an unknown actor.

Moved and archived pages keep their history. Trashed pages keep it hidden. Confluence's page deletion event removes the history; deleting a whole space may leave hidden records in storage.

The app declares no external network access and does not log page content or labels. Forge retains app data for 28 days after uninstall, but reinstalling does not automatically restore it.

**Privacy note:** Anyone who can view a page can see its recorded label history, including changes made before they had access.

Rovo requests and responses are processed under [Atlassian's Rovo data policies](https://support.atlassian.com/rovo/docs/rovo-data-privacy-and-usage-guidelines/), potentially using third-party AI models.

## Support

For questions, bug reports, or feature requests, email **support@srcplugins.com** or open an issue on [**GitHub**](https://github.com/srcplugins/atlassian-confluence-label-history/issues).

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).

Third-party components and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
