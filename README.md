# Vote

Very minimalist live poll for talks / presentations.

Show a claim on your own set of slides; the audience then opens a URL on their phones and rates their agreement on a slider from 1 to 10.

You can then view and show the average score and distribution of ratings.

- **Audience page** (`index.html`): one slider, 0–10 in 0.1 steps. **No login**, saves immediately.
- **Host page** (`host.html`): average, n, median, SD, histogram, join QR code. Google sign-in, locked to one account.

It's plain HTML, CSS, and JS with no build step. Any static host works; the steps below use GitHub Pages. Shared state lives in Firebase (Cloud Firestore + Auth).

## What you need

- A GitHub account (or any other static host)
- A Google account for Firebase
- Python 3, only for testing locally

## Setup

Throughout, replace `<user>` with your GitHub username and `<repo>` with the repo name you choose (for example `vote`).

### 1. Get the code

Fork this repo, or copy its files into a new repo. The repo name becomes the URL path: a repo named `vote` is served at `https://<user>.github.io/vote/`.

> **`config.js` and `firestore.rules` contain the original author's Firebase project and host uid.** Replace both with your own (steps 2 and 3). Otherwise your copy sends votes to someone else's database.

### 2. Create the Firebase project

1. In the [Firebase console](https://console.firebase.google.com/), create a project. The free Spark plan is enough; Google Analytics is not needed.
2. **Build → Authentication → Get started**. Under **Sign-in method**, enable **Anonymous** and **Google**.
3. Authentication → **Settings → Authorized domains**: add `<user>.github.io` (or your own domain). `localhost` is already listed.
4. **Build → Firestore Database → Create database**. Pick a location near your audience and start in **production mode**.
5. **Project settings → General → Your apps**: add a **Web** app (no Hosting needed). Replace the `firebaseConfig` values in `config.js` with yours.

These config values are public by design: every visitor's browser receives them. Access control comes entirely from the security rules in step 3.

### 3. Make yourself the host

1. Serve the folder locally from the repo root:

   ```bash
   python -m http.server 8000
   ```

2. Open http://localhost:8000/host.html and sign in with Google. The page shows `Not authorized` and your uid.
3. Paste that uid into `config.js` as `HOST_UID`, and into `firestore.rules` inside `isHost()`, replacing the uid that's there.
4. In the Firebase console, go to **Firestore Database → Rules**, replace the contents with `firestore.rules`, and click **Publish**.
5. Reload `host.html`. You now see the dashboard. On first load it creates `state/current` as `{ round: 1, open: true }`.

To test voting, open http://localhost:8000/ in another browser or a phone on the same network. Each browser counts as one voter.

### 4. Deploy

Commit `config.js` and `firestore.rules` with your values and push. Then, on GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder `/ (root)`.

- Audience: `https://<user>.github.io/<repo>/`
- Host: `https://<user>.github.io/<repo>/host.html`

The join URL and QR code on the host page come from wherever the page is served, so nothing else needs changing. If you name the repo `<user>.github.io`, the site is served at the domain root instead.

## Running a session

| Key | Effect |
|---|---|
| `N` | Next round: empty round, voting open, every phone resets |
| `C` | Close or reopen voting |
| `H` | Hide or show results (only on this screen; n stays visible) |
| `Q` | Full-screen join QR (`Esc` or click to close) |

Results start hidden each round, so a projected running average doesn't anchor people who haven't voted yet. A typical flow per claim:

1. Show the claim on your slide and press `N`.
2. Wait for n to settle, then press `C` to close voting.
3. Press `H` to reveal the results.

Clicking **Next round** asks for confirmation if the round has votes; the `N` key doesn't, to keep things fast during a talk. Earlier rounds are listed under **Past rounds** at the bottom of the host page.

## How it works

```
state/current               { round, open, updated }
rounds/{round}/votes/{uid}  { value: 0–10, ts }
```

- Each phone signs in anonymously and writes one document per round, keyed by its uid. Changing a vote overwrites it.
- Next round only increments `round`. Nothing is deleted, so every past round stays in Firestore.
- The rules only let a voter write their own vote, only to the current round, only while voting is open, and only a number from 0 to 10 (the slider moves in 0.1 steps; the histogram rounds each vote to the nearest whole number). Only the host can change `state/current` or read other people's votes.

## Limits

- **Duplicate votes:** an anonymous identity is per browser, so someone using several browsers or private windows can vote more than once.
- **Free quota:** Spark allows 20,000 Firestore writes and 50,000 reads per day. Each vote or change is one write, and the host page reads each vote as it arrives. A room of a few hundred people over a dozen claims stays well inside that.
- **Connections:** Firestore has no simultaneous-connection cap on Spark, which is why this uses Firestore rather than the Realtime Database (capped at 100).

## Customizing

- **Labels:** the `disagree` / `agree` words are in `index.html`.
- **Colors:** all colors are CSS variables at the top of `app.css`, with a light and a dark set. The page follows the device's theme.
- **Firebase SDK version:** pinned in the import URLs in `firebase.js`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pages say `Not configured` | `config.js` has placeholder values (step 2.5). |
| Sign-in fails with `auth/unauthorized-domain` | Add the site's domain under Authentication → Settings → Authorized domains. |
| Phones show `Couldn't connect` | Anonymous sign-in isn't enabled (step 2.2). |
| Host page shows `Not authorized` after setup | `HOST_UID` in `config.js` doesn't match the uid shown; check for stray spaces. |
| Dashboard errors with `permission-denied` | The uid in the published rules isn't yours, or the rules weren't published. |
| Phones say `Couldn't save` while voting is open | Same as above: the rules in the console don't match `firestore.rules`. |

## Files

| File | Purpose |
|---|---|
| `index.html`, `voter.js` | Audience page |
| `host.html`, `host.js` | Host page |
| `app.css` | Shared styles |
| `firebase.js` | Firebase init and SDK imports |
| `config.js` | Your Firebase config and host uid |
| `firestore.rules` | Security rules to paste into the Firebase console (not loaded by the site) |
