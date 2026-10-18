# BRTI replica

The tape recomputes the CME CF Bitcoin Real Time Index (BRTI) itself, every 200 ms,
from the constituent exchanges' public order books. The point is to see a move in
the index before Kalshi's official BRTI tick reaches the page, and to measure
whether that actually happens. It is research context: it never replaces the
official index, never settles anything and is not an input to the frozen
`brti-driftless-v4` model, buy calls, paper trades or sessions.

Canonical source: `shared-brti.js` (`brti-replica-v1`), embedded into
`public/index.html` by `npm run sync:model` and checked by `npm run check`.

## The calculation

Implemented from CF Benchmarks' *CME CF Real Time Indices Methodology* v17.0
(21 September 2026), sections 4–6, with the BTC-USD parameters:

1. Each constituent's relevant order book is cleaned: non-numeric or non-positive
   entries removed; books that are one-sided, crossed or unparseable are excluded;
   a book retrieved more than **10 s** before the calculation is excluded.
2. Potentially erroneous data: a book whose mid is more than **5%** from the median
   mid of the valid books is excluded, and readmitted only once back within **2.5%**.
3. The remaining books are merged by price into one consolidated book.
4. Dynamic order size cap from the uncapped consolidated book: ask levels within
   1.05× the best ask (or the first min(n, 50), whichever is more) and bid levels at
   or above 0.95× the best bid (likewise); sizes per price level; trim/winsorize
   k = ⌊1%·n⌋ per tail; cap = trimmed mean + **5** × winsorized standard deviation.
   Every level is capped at that size.
5. Uncrossing (added in v16.8, 29 June 2026): while the best bid is at or above
   the best ask, the smaller of the two sizes is removed from both.
6. Dynamic spacing s = min(level-based, density-based): the smaller side's total
   liquidity / **100**, and the mode of a Gaussian kernel density (bandwidth
   1.06·σ·n^−1/5) over the winsorized level sizes of the lower-liquidity side.
7. Ask and bid price-volume curves (marginal price at cumulative volume) on the
   grid s, 2s, …; mid = their average; mid-spread = ask / mid − 1.
8. Utilized depth v_T = the last grid point whose mid-spread is at most **5%**
   (floor s).
9. Index = Σ midPV(v)·w(v) over v ∈ {s, …, v_T}, w ∝ λe^(−λv), weights normalized
   to one, λ = 1 / (**0.3**·v_T). Published precision is $0.01.

## Where the replica can differ from the official index

- **Missing constituents.** The official BRTI uses seven exchanges (Bitstamp,
  Coinbase, Kraken, Gemini, Bullish, Crypto.com, LMAX Digital; itBit suspended
  27 July 2026). The page uses those it can read from a browser; the panel lists
  which.
- **Depth.** Some public feeds publish only the top N levels (see the adapter
  table). When the visible books run out before the 5% band, the panel says
  *depth-limited*: utilized depth and λ are then smaller than CF's, which pushes
  weight toward the top of the book. Levels more than 15% from an exchange's own
  touch are ignored for speed.
- **Unstated details.** The methodology does not give the search grid for the
  density mode; the replica evaluates it at the sample sizes. It is ambiguous on
  whether the density uses capped sizes; the replica uses the capped,
  uncrossed sizes the curves use. Standard deviations use n − 1.
- **Timing.** CF samples each exchange's book on its own schedule at each 200 ms
  effective time; the replica uses whatever each socket has delivered by the time
  it computes. Clock skew between this device and CF is not corrected.

None of these is assumed small. The tracking lines measure the result.

## Tracking

The panel keeps ten minutes of replica values and official 5 Hz BRTI ticks (both
the source timestamp and the time each tick reached the page) and, every 10 s,
reports:

- **Error at the same source time** — mean and median absolute dollars between the
  replica and the official value stamped at that moment. This is accuracy.
- **Best alignment against receipt** — the shift, in 200 ms steps from −2 s to
  +4 s, that minimizes the mean error between the replica and the official value
  *as received here*. Positive means the replica showed the value before the
  official tick arrived. This is the head start, if any.

These are descriptive statistics over a rolling window on one device. They are
not stored, not a calibration, and not evidence of a trading edge. A replica that
is accurate but not early is useless for trading; one that is early but noisy may
be worse than useless. Decide from a long prospective record, including the
seconds that matter (the final minute), before giving it any role in the model.
