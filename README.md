# marksix

A single-page Mark Six checker for the Hong Kong lottery. Open `index.html` (or the GitHub Pages site) in a browser.

- **Save your bets.** Singles (6 numbers), multiples (7+ numbers) and banker bets (1–5 bankers plus any number of legs). Bets are stored in the browser's localStorage, so they stay on that device.
- **Check a draw.** Tap the 6 drawn numbers and the special to see which entries win and how much the 4th–7th divisions pay. 🎲 Random draw makes a what-if draw.
- **Odds.** The chance of each division for your bets, recalculated as you enter the draw. It is exact unless there are too many overlapping bets, in which case it is estimated by simulating draws.
- **Share.** 🔗 Share copies a link with your bets (and the draw, once it's fully entered). The link opens in a read-only "Shared bets" view, which the person can save to their own bets.
- **CSV import / export.** Export saves your bets as a `.csv` file (also a handy backup); Import adds bets from one and skips any you already have. **Clear all** deletes every saved bet.

  ```csv
  name,bankers,legs
  Office pool,,1 2 3 4 5 6 7 8
  Banker bet,10 20,11 12 13 14 15
  ```

  Numbers inside a field are separated by spaces. Import also accepts files without a header: one bet per row, numbers in their own cells or together in one, with an optional name.

Not affiliated with the HKJC.

## License

MIT — see [LICENSE](LICENSE).
