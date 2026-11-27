# Landed: submission draft

Working copy for the DoraHacks BUIDL page (HSK Chain Horizon Hackathon · Seoul). Fields marked **[TODO]** get filled once HSP access and the mainnet deploy are done.

---

## Name
Landed

## Tagline
Landed late? Paid on landing.

## Track
Track 2: Agent Payments & A2A Settlement

## Links
- Site: https://landed-delay.vercel.app
- Live demo: https://landed-delay.vercel.app/demo.html
- Proof page (reads the chain directly): https://landed-delay.vercel.app/proof.html
- Code: https://github.com/0xvikram/landed
- Video (2:18, AI voice): https://youtu.be/TE_I-rVXaNY
- Mainnet contract (HSK Chain, 177): **[TODO]**
- Testnet contract (HSK testnet, 133): [0x2b44008428ce6ee69c0b44aec4daef74b22c5a71](https://testnet-explorer.hskchain.net/address/0x2b44008428ce6ee69c0b44aec4daef74b22c5a71)

## The problem
When a flight lands late, the passenger is often owed money. Under EU rules (EU261) that is €250 to €600 per person ([europa.eu](https://europa.eu/youreurope/citizens/travel/passenger-rights/air/index_en.htm)), and the UK and Canada have similar rules. To get it, the passenger has to find the rule, fill in a form, and wait weeks. The airline already knows the flight was late, and it already knows who was on board.

## What Landed does
Landed is the airline's payment agent. When a flight lands late:

1. The passenger's agent (or the passenger) sends a claim: flight, booking reference, wallet.
2. The airline's agent reads the published compensation rule from the `LandedPolicy` contract on HSK Chain. For example: 2 h late pays $10, 3 h pays $25, 5 h pays $60.
3. It **reserves** the booking on HSK Chain. Any second claim for the same booking is refused by the contract, even if the reference is typed differently.
4. A person at the airline approves, as HSP requires. The agent then pays through HashKey Settlement Platform: `create_order → prepare_payment → sign (EIP-712) → finalize_payment → submit_payment → query_payment`.
5. Once HSP reports the payment as safe, the agent **settles** the booking on HSK Chain with the HSP transaction hash. That becomes a public receipt anyone can check on the proof page.

If the payment fails before it is sent, the booking is released so the passenger can be paid later. If it fails *after* it is sent, the booking stays locked, so the airline can never pay twice.

## How HSP is used
- HSP Agentic Payment MCP (`mcp-qa.hashkeymerchant.com`) is used through the official MCP SDK, with all 8 tools ([agent/hsp.ts](agent/hsp.ts), [agent/payout.ts](agent/payout.ts)).
- x402 v2 cart mandate with an EIP-3009 USDC transfer authorisation, signed by the airline agent's wallet.
- Two human approvals, shown with pay-to, payer and the exact token amount: one before signing and one before submitting.
- `query_payment` is polled every 15 s, with `expected_merchant_name` and `attribution_verified` checked. Only `payment-safe` / `payment-finalized` count as paid.
- An expired quote (error 30043) is re-prepared, not retried blindly.

## What's on HSK Chain
`LandedPolicy.sol` ([contracts/LandedPolicy.sol](contracts/LandedPolicy.sol)):
- **Published rule:** delay tiers in USD cents, which the owner can update and which emit an event.
- **One payout per booking:** `reserve → settle` or `reserve → release`. Booking keys are a hash of flight, date and normalised reference, so no personal data goes on-chain.
- **Receipts:** a `PayoutPaid` event with the amount, passenger wallet, settlement chain and HSP transaction hash. The proof page reads these straight from the RPC.
- **Totals:** `paidCount` and `paidCentsTotal` on-chain.

## Status and honesty notes
- The contract has 7 Hardhat tests and the payout agent has 7 tests, covering the happy path, a duplicate claim, a short delay, a decline, a failed payment, errors before and after submit, and a timeout.
- On HSK testnet, a full run wrote a real reserve and settle and refused a second claim (`npx tsx agent/testnet-run.ts`).
- **Real HSP payment, 27 Nov 2026.** HSP allowlisted our IP and `npx tsx agent/hsp-run.ts` ran one full payout through the HSP QA gateway: order `b2df6155-ab2d-455d-bf6e-d2fa2f7b5c69`, quote locked, two approvals, EIP-3009 signature, `payment-safe`. HSP moved 10.002 USDC (the $10 tier plus a 0.002 USDC fee) from the airline agent wallet to the passenger on Base Sepolia, tx [0x9488b7ae…160a](https://sepolia.basescan.org/tx/0x9488b7ae400f1850d7e59afb88b31268dc699412665e382004a3d32aba91160a). LandedPolicy then wrote the receipt on HSK testnet, tx [0x594226d2…60cf](https://testnet-explorer.hskchain.net/tx/0x594226d27c5fafbc763cf56b7d5632b7bcda483e4e9d06cb668a74ff788360cf). The proof page marks it "HSP".
- **Second real HSP payment, recorded for the demo video, 27 Nov 2026.** Run from the live demo page (`demo.html` against the local agent, real HSP mode) with two human approvals: DA117, 2 h 14 m late, booking `M2V9QL`, HSP flow `a0d6e9af-9433-4596-92ac-30f3aef49311`, quote 10002001 raw units, `payment-safe`. HSP moved 10.002001 test USDC from the airline agent wallet to the passenger on Ethereum Sepolia, tx [0x69d358e2…d55e15](https://sepolia.etherscan.io/tx/0x69d358e2201d9bcb301b67aee49b7e430c3486083de40e9b94973eb104d55e15). LandedPolicy wrote the receipt on HSK testnet (settlement chain 11155111 recorded in the event), tx [0x849a8f6e…332dc2](https://testnet-explorer.hskchain.net/tx/0x849a8f6e1b11b94d143e453fef277a0ca7c56667740d4a3558a287818d332dc2); booking lock tx `0x4ed6e472…9750e0`. Claiming `m2v9ql` again was refused by the contract with no payment.
- Earlier receipts from before HSP access (21–26 Nov) came from a stand-in that returns the same fields. They carry chain id 999999 and the proof page shows them as "Stand-in, not a real payment". The live demo can still run in that labelled mode (`HSP_MODE=standin`) if the server is not on an allowlisted IP.
- Flight delays in the demo are simulated and labelled as such. HSP's QA environment settles in test USDC on test networks (Base Sepolia, Ethereum Sepolia); the rule, booking lock and receipts live on HSK Chain.

## What's next
- Read real arrival times from a flight-status feed instead of a simulated delay.
- Pay a passenger's own agent (A2A): the passenger agent submits the claim and receives the payout without a form.
- Several airlines on one contract, each with its own rule and agents.

## Team
Solo: 0xvikram. Built with Claude Code (Anthropic) as a coding assistant.

---

# Demo video script (2:18, AI voice)

The video uses real screens only. Lines marked **[HSP]** show a real HSP payment recorded on 27 Nov from the live demo page (test USDC on Ethereum Sepolia, booking lock and receipt on HSK testnet). The narration is an AI voice (Kokoro).

| # | Time | Screen | Voice |
|---|---|---|---|
| 1 | 0:00 | Kinetic type | Your flight lands three hours late. You're owed money. Getting it means a form, and weeks of waiting. |
| 2 | 0:08 | Problem section, EU261 line | Under EU rules, that's two hundred and fifty to six hundred euros a passenger. The UK and Canada have similar rules. And the airline already knows the flight was late, and who was on it. |
| 3 | 0:21 | Site hero | Landed is the airline's payment agent, built on HSK Chain and the HashKey Settlement Platform. Landed late? Paid on landing. |
| 4 | 0:32 | How it works: the rule on HSK Chain | The airline publishes its rule once, in a contract on HSK Chain. Two hours late pays ten dollars, three hours pays twenty-five. Code decides the amount, never an AI model. |
| 5 | 0:46 | **[HSP]** Demo page: DA117, 2 h 14 m late, "$10.00" | Here's the live demo. Pick a flight. It landed two hours fourteen minutes late, so the rule says ten dollars. |
| 6 | 0:55 | **[HSP]** Booking locked on HSK testnet, approval card (pay to, from, amount) | The agent checks the rule, and locks the booking on chain, so it can only be paid once. Then a person at the airline approves: who gets paid, from which wallet, and the exact amount. |
| 7 | 1:08 | **[HSP]** Step log: order, quote, signed, submitted, safe, receipt; result card Paid $10.00 with both links | Approved. Now the agent runs HSP's payment flow for real: order, quote, signature, submit, until HSP says the payment is safe. Then it writes the receipt on HSK Chain. |
| 8 | 1:22 | **[HSP]** The transfer on Blockscout (Ethereum Sepolia): 10.002001 test USDC, airline → passenger | One honest note. HSP's test environment settles in test USDC, on a test network. The rule, the booking lock and the receipt live on HSK Chain. Both transactions are one click away. |
| 9 | 1:38 | Same booking typed in lowercase, "already claimed" | Now claim the same booking again, even typed in lowercase. The contract refuses. No double payouts. |
| 10 | 1:46 | Proof page, HSP row read from HSK testnet | Every payout is public. This page reads the receipts straight from HSK Chain, not from our server. Real HSP payments are marked. |
| 11 | 1:57 | Under the hood: contract, HSP flow, approvals, tests | Under the hood: one contract for the rule and the receipts, and an agent that follows HSP's payment flow with two human approvals. Fourteen tests cover every way it can fail. |
| 12 | 2:11 | End card, landed-delay.vercel.app | Landed. Delay pay, the moment you land. |

Recording notes:
- Run the agent locally (`PAY_NETWORK=sepolia npm run agent`, real HSP mode, from an allowlisted IP) and open `demo.html?agent=http://localhost:8787`. The page must be served from an allowed origin, for example `python3 -m http.server 5500` inside `web/`.
- Capture with the product-demo-video skill: real screenshots, Kokoro AI voice, captions. Say in the description that the voice is AI.
