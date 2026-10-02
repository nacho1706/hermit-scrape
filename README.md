# Marketplace Listing Assistant

A browser extension that helps people evaluate marketplace listings against what they are looking for. It reads visible listing cards, compares them with a search brief, and labels each result `MATCH`, `SKIP`, or `REVIEW`. A side panel shows the results and session summary, with an option to export the session as CSV.

The project is intended to grow into a marketplace-independent tool, with support for sites such as Facebook Marketplace, Mercado Libre, Alibaba, and others. At present, the implemented listing integration is Facebook Marketplace. Support for Mercado Libre, Alibaba, and additional marketplaces is a future direction, not a current feature.

The extension is built with [WXT](https://wxt.dev/) and TypeScript. It evaluates listings through Jev (`jev-1.13`) using your own OpenRouter API key. Requests may incur charges on your OpenRouter account.

## How it works

1. On a Facebook Marketplace listing grid, the extension watches the listing cards that appear on the page. It reads the page and adds visual labels; it does not click, scroll, or type on your behalf.
2. Open the extension's side panel and describe what you are looking for.
3. The search brief and visible listing details are sent to Jev, which estimates how well each listing matches and whether it contains a concrete reason to reject it.
4. The extension marks listings `MATCH`, `SKIP`, or `REVIEW` and updates the counts, response time, and reported cost in the panel. Local price and location filters can also reject listings when their details are readable.
5. Export the current session's results as a CSV file.

Newly appearing listings are processed in small batches. Judgments are cached for the browser session to avoid scoring the same listing repeatedly. Editing the search brief starts evaluation for the updated criteria.

## Requirements

- Node.js and npm.
- A Chromium-based browser with support for Manifest V3 extensions and the side panel API.
- An OpenRouter account and API key with access to the Jev endpoint.

## Development setup

```sh
git clone <repository-url>
cd hermit
npm install
npm run dev
```

WXT starts the development workflow and shows how to load the extension in a browser. To build the extension:

```sh
npm run build
```

The build output is generated in `.output/` for Chromium by default. In Chrome or Edge, enable developer mode on the extensions page and load the generated extension directory.

## Configuration and use

1. Install or load the extension, then open its options page.
2. Save your OpenRouter API key in the **OpenRouter key** field. The key is stored in the browser's local extension storage, is not shown again, and is sent to the service only in the request's authorization header.
3. Open a Facebook Marketplace listing grid and open the extension's side panel.
4. Fill in the search brief:
   - **Query**: the product name or a short description. This is required to start evaluation.
   - **Maximum price** and **currency**: an optional price limit. The default currency is ARS. The price filter is inactive when no maximum is set.
   - **Location**: one or more locations, separated by semicolons.
   - **Note**: additional requirements for evaluating a listing.
5. Review the labels and summary. Select **Export CSV** to download the session results.

The search brief and API key are stored locally in the browser. Listing evaluation requires an internet connection and uses your OpenRouter account.

## Manual verification status

The **Query** field (product name) and **Location** field have been manually tried. **Price**, **Currency**, and **Currency type** have not been manually tested. These fields are present in the interface, but their behavior has not yet been verified manually.

## Available commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start WXT in development mode. |
| `npm run build` | Build the extension. |
| `npm run test` | Run the existing automated tests. |
| `npm run typecheck` | Check TypeScript types. |
