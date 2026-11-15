# btc-race-bot

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/jembot21/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/jembot21/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

A deep-dip snapback bot for cbBTC/USDC minute bars. It waits flat until the
latest close falls at least 1.60% below its trailing 150-bar mean and the
fall has paused, then buys with the whole equity. It sells on a +0.70%
take-profit, on a recovery to the mean worth at least +1.00%, on a trailing
stop (armed at +0.60%, giving back 0.30%), on a -2.00% stop loss, or after
five hours in the trade. If half the window passes with no trade at all, a
shallower 0.90% dip may enter instead, so the bot never sits the whole
race out. All arithmetic is integer-only: no clock, no randomness, the
same bars always give the same orders.

On the kit's dev window (the 24 hours before the bounty opened) it made
four round trips, all winners, for a net PnL of +21.44 USDC on the 1,000
USDC paper start, with a 1.56% maximum drawdown.

`main.ts` is the strategy; the agent-fun/bars-replay/v1 wire protocol is
spoken by the kit's shim, vendored unchanged under `vendor/`.

## Run it

```sh
node /bot/main.ts   # the harness runs it this way; it speaks newline-delimited JSON on stdin/stdout
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8vr38xr3&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
