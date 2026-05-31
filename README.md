# Substrate Readable GUI

Local static interface for browsing readable Substrate MCP exchange resources from the live MCP endpoint.

## Navigation Features

- Search result snippets with highlighted matches.
- Corpus map counts for resources, guides, salon docs, and transcripts.
- Clickable resource paths inside rendered content.
- Document outline for jumping between headings.
- Direct links, backlinks, related resources, and clickable recent activity.

## Run

```sh
npm run start
```

Then open:

```text
http://localhost:4173
```

If that port is already in use, choose another one:

```sh
PORT=4174 npm run start
```

## Notes

The app POSTs JSON-RPC directly to:

```text
https://substrate-exchange.5.78.90.96.sslip.io/mcp
```

On load it calls:

- `exchange_list`
- `exchange_read`
- `exchange_recent_activity`
- `exchange_status`
