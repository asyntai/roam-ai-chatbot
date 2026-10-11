# Asyntai AI Chatbot for Roam Research

Turn your Roam graph into an AI assistant you can ask questions, and read your
website chats without leaving Roam.

## What it does

**Ask your own pages.** Choose the pages you want, and the extension keeps them
in your [Asyntai](https://asyntai.com) knowledge base. Open the panel, type a
question, and the answer comes from what you wrote. Press **Insert into page**
to drop the answer straight into your graph.

**Read your website chats.** The **Chats** tab lists the conversations your
Asyntai chatbot had with visitors on your website, with the full text of every
message. **Save as page** turns any conversation into a Roam page under
`Asyntai chats/`.

**See your leads.** The **Leads** tab shows the email addresses and phone
numbers visitors left in the chat, newest first.

**Stay in step.** Edit a page and it goes up again a few seconds after you stop
typing. Rename it out of your chosen pages, or delete it, and Asyntai follows.
Block references are sent as the text they point to, so a fact kept in one
place is sent with every page that references it.

## Install

1. In Roam, open **Settings**, go to the **Roam Depot** tab, press **Browse**,
   and install **Asyntai AI Chatbot**.
2. Sign in at [asyntai.com](https://asyntai.com), open **Settings → API**, and
   copy your API key.
3. In Roam, open **Settings → Asyntai AI Chatbot** and paste the key.
4. Put the pages you want to send in **Pages to send**, comma separated. `Docs`
   sends `Docs` and every page under it, such as `Docs/Refund policy`. Type `/`
   to send every page. An empty box sends nothing.
5. Run **Asyntai: send all pages** from the command palette (Ctrl+P, or Cmd+P
   on a Mac).

## Commands

| Command | What it does |
| --- | --- |
| Asyntai: open panel | Opens Ask, Chats and Leads |
| Asyntai: send this page | Sends the page you are on |
| Asyntai: remove this page | Takes the page out of Asyntai |
| Asyntai: send all pages | Sends every page you chose |
| Asyntai: remove all pages | Takes every sent page out of Asyntai |
| Asyntai: check API key | Shows the account the key belongs to |

Type `/Asyntai ask` at the end of a block to open the panel with that block's
text as the question. The button in the top bar opens the panel too.

## Settings

| Setting | Meaning |
| --- | --- |
| Asyntai API key | From Settings → API in your Asyntai dashboard |
| Pages to send | Page title prefixes to send. `/` means every page |
| Pages to leave out | Prefixes that stay out even when a parent is sent |
| Send daily notes | Off by default, because daily notes are usually private |
| Send changes automatically | Sends a page a few seconds after you stop typing |
| Asyntai address | Leave as it is unless support asks you to change it |

## Requirements

An Asyntai account on the Starter plan or higher, because the extension uses
the Asyntai API.

## Building

`build.sh` installs the dependencies and bundles `src/` into `extension.js`.
`npm test` runs the unit tests and the graph tests on the datascript engine.

## Support

Write to [hello@asyntai.com](mailto:hello@asyntai.com), or read the
[documentation](https://asyntai.com/documentation/integrations/roam-research/).

## Licence

MIT.
