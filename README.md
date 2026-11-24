# marksix

A single-page Mark Six checker for the Hong Kong lottery. Open `index.html` (or the GitHub Pages site) in a browser.

- **Save your bets.** Singles (6 numbers), multiples (7+ numbers) and banker bets (1–5 bankers plus any number of legs). Bets are stored in the browser's localStorage, so they stay on that device.
- **Check a draw.** Tap the 6 drawn numbers and the special to see which entries win and how much the 4th–7th divisions pay. Random draw makes a what-if draw. Share result as image makes a PNG summary of the draw and what each bet won, ready to send (share sheet on phones, download on laptops). When the bets came from a group pool, tick Show who picked each number to put each picker's name under their number and list who picked the numbers that came up.
- **Official results.** Last draw fetches the latest official draw from HKJC, in your browser, and fills it into the checker, so the site never needs redeploying for new results. With three or more bets saved (or a locked pool open), a Check the last draw button above the list does the same. Past 5 ▾ lists the last five draws with what your bets won (tap Hide ▴ to fold it away); tap one to fill the checker and see its details as HKJC publishes them: draw number, date, snowball, total turnover, and each division's unit prize and winning units. Your winnings use those official unit prizes, so 1st–3rd division prizes show real amounts.

  This uses the same results service as HKJC's own results page (`info.cld.hkjc.com/graphql`). It isn't a documented public API, so it can stop working if HKJC changes its site. If it does, the page says so and you can still type the numbers in.
- **Odds.** The chance of each division for your bets, recalculated as you enter the draw. It is exact unless there are too many overlapping bets, in which case it is estimated by simulating draws. The card hides once the full draw is in, when the result says it all.
- **Share.** Share copies a link with your bets (and the draw, once it's fully entered). The link opens in a read-only "Shared bets" view, which the person can save to their own bets.
- **Group pool.** Group pool makes a shared pool: pick how many bets and how many numbers each (say 2 bets of 7), then Invite friends sends the link. Everyone who opens it adds their numbers from their own phone and sees everyone else's the moment they're picked. Anyone with the link can add, remove or change anything (no accounts); each number shows who picked it, and Recent changes lists who did what. A bet plays once it has 6 numbers, and while the pool is open the draw checker, odds and share image use the pool's bets. Once the ticket is bought, Lock freezes the pool for everyone so the numbers keep matching it; anyone can Unlock it again (both show in Recent changes). Save to my bets copies them into your own list, keeping who picked each number (shown under the balls). Export PNG makes a picture of the pool, each number with who picked it, ready to send to the group. Pools you've opened are listed in the Group pool dialog, and a pool is removed 60 days after its last change.

  The pool lives on a small Cloudflare Worker in [`worker/`](worker/README.md) (one Durable Object per pool, kept in step over a WebSocket).
- **CSV import / export.** Export PNG (next to Export CSV) makes a picture of your bets, with hit rings once a draw is entered. Export saves your bets as a `.csv` file (also a handy backup); Import adds bets from one and skips any you already have. **Clear all** deletes every saved bet.

  ```csv
  name,bankers,legs
  Office pool,,1 2 3 4 5 6 7 8
  Banker bet,10 20,11 12 13 14 15
  ```

  Numbers inside a field are separated by spaces. Import also accepts a plain list of bets, one per row, with each number in its own cell:

  ```csv
  1,2,3,4,5,6
  7,8,9,10,11,12
  ```

  A name cell (e.g. `Mon,1,2,3,4,5,6`), a title row such as `N1,N2,…,N6`, and full-width commas (`，`) are all fine. A row with 7 or more numbers imports as a multiple.

Not affiliated with the HKJC.

## License

MIT — see [LICENSE](LICENSE).
