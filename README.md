# Label History for Confluence

[![Check](https://github.com/srcplugins/atlassian-confluence-label-history/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/srcplugins/atlassian-confluence-label-history/actions/workflows/check.yml?query=branch%3Amain)

A starter Confluence space settings page that checks whether you can read the current space. Replace this description with the plugin's job once it is specified.

## Usage

Open **Space settings → Integrations → Label History for Confluence** in a space and click **Check space access**. The page names the space you can read, or explains why the check failed.

## Permissions

| Scope | Why it is needed |
|---|---|
| `read:space:confluence` | Read the current space as you to confirm your access. |

Requests run as you. Opening the settings page doesn't replace the server-side check. Guests and anonymous users are outside the starter's scope.

## Data

Read-only. The app reads the current space's ID, key and name. It stores nothing, sends nothing outside Atlassian and logs no content.

## Support

For questions, bug reports, or feature requests, email **support@srcplugins.com** or open an issue on [**GitHub**](https://github.com/srcplugins/atlassian-confluence-label-history/issues).

## License

[PolyForm Noncommercial License 1.0.0](LICENSE.md). Third-party production dependencies are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
