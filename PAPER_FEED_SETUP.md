# Personal paper feed setup

The feed is already added to the repository at the unlisted path

```text
/cosmos-briefing-7f3c91/
```

Nothing links to this path from the public website. The page also asks search engines not to index or archive it.

## What is included

- Daily arXiv submissions from `astro-ph.CO`, `gr-qc`, `hep-ph`, and `hep-th`
- A first section for papers containing a priority author
- A ranked main-submission section
- A separate cross-listing section at the end
- Upvotes and downvotes that train author, topic, and category weights
- A Saved tab that persists across daily releases
- Automatic saving of priority-author papers until you explicitly remove them
- Browser-local saving as an immediate fallback
- Optional repository synchronization through the included Cloudflare Worker

Only paper titles are rendered in the lists. A title opens the corresponding arXiv abstract page.

## One-time website deployment

Commit and push the modified repository to its current deployment branch.

```bash
git add .
git commit -m "Add personal arXiv paper feed"
git push origin hugo-dem2
```

The application is inside Hugo's `static` directory, so the existing Hugo deployment copies it without needing a new template or menu item.

Open the Actions tab on GitHub and manually run the workflow named `Update paper feed` once. This replaces the bundled sample data with the current arXiv release.

In the repository settings, open Actions, then General, then Workflow permissions. Make sure workflows can write repository contents. The workflow uses that permission only to update

```text
static/cosmos-briefing-7f3c91/data/papers.json
```

The scheduled update runs on weekdays shortly after the new arXiv listing is normally available. A failed fetch never overwrites the last successful feed.

## Repository-backed votes and saved papers

GitHub Pages and other static hosts cannot accept writes directly from browser JavaScript. The included Worker is a small authenticated bridge. It writes one transparent JSON file to a dedicated branch named

```text
paper-feed-state
```

This keeps every click out of the website deployment history while leaving the data visible and editable in your repository.

### Create a restricted GitHub token

Create a fine-grained personal access token in GitHub with the following scope.

- Repository access limited to `SergioSevi/hugo-demo2`
- Repository permission `Contents` set to `Read and write`
- No other repository permissions required

Copy the token when GitHub displays it. Do not add it to this repository or to the website JavaScript.

### Deploy the Worker

Install Node.js if needed, then run

```bash
cd paper-feed-worker
npx wrangler login
npx wrangler deploy
```

The first deployment creates the Worker and prints its endpoint. It is expected that repository operations will fail until the two secrets below are added.

Add the GitHub token as an encrypted Worker secret.

```bash
npx wrangler secret put GITHUB_TOKEN
```

Generate a separate write key and keep a copy of it.

```bash
openssl rand -hex 32
```

Add that value as the second encrypted Worker secret.

```bash
npx wrangler secret put WRITE_KEY
```

The second secret command deploys a new Worker version. Test the endpoint by opening its `/health` path. It should return JSON containing `ok` set to `true`.

### Connect the page

Open the hidden paper page and select `Authors and learning`.

Enter

- The Worker endpoint printed by Wrangler
- The write key generated above

Select `Save and connect`.

The page first merges any browser-local history, then creates the `paper-feed-state` branch automatically and writes

```text
paper-feed-state.json
```

A green `Synced to GitHub` indicator confirms that the remote write succeeded.

## Editing the feed

### Priority authors

The initial collaborator list is in

```text
static/cosmos-briefing-7f3c91/data/state.json
```

Before the first synchronization, edit that file directly. After synchronization, the easiest method is the `Authors and learning` tab. Its changes are stored in `paper-feed-state.json` on the state branch.

Name aliases are supported in the seed JSON. They are useful for initials, accents, and hyphenated variants.

### Categories

The four monitored categories are set in

```text
scripts/fetch_arxiv.py
```

They are also displayed in

```text
static/cosmos-briefing-7f3c91/config.json
```

Keep those two lists aligned if the categories are changed later.

### Hidden path

Rename the directory below to change the unlisted URL.

```text
static/cosmos-briefing-7f3c91
```

No other website file refers to that directory, apart from the updater output path in the workflow and Python script. Update those paths as well after renaming it.

## How ranking works

Every vote stores a compact snapshot of the paper's authors, arXiv categories, and weighted title and abstract terms.

An upvote adds positive weights. A downvote adds negative weights. New papers are scored against the accumulated weights. Papers are then ranked within their own section, so cross-listings always remain in the final section and priority-author papers always remain first.

Clicking the same vote a second time removes it.

## Save behavior

- Selecting the star saves a paper permanently
- Priority-author papers are starred automatically
- Removing an automatically saved priority paper records an opt-out
- That paper is not automatically re-added on the next visit
- Manually saving it again reverses the opt-out
- Saved papers retain their title and arXiv link after they disappear from the daily feed

## Backup and recovery

The `Authors and learning` tab includes JSON export and import controls. Browser-local state also remains active if the Worker is temporarily unavailable. The next successful synchronization merges changes by their individual timestamps rather than replacing the entire state blindly.

## Files added

```text
.github/workflows/update-paper-feed.yml
PAPER_FEED_SETUP.md
paper-feed-worker/
scripts/fetch_arxiv.py
static/cosmos-briefing-7f3c91/
tests/
```
