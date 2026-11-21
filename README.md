# Landed

**Landed late? Paid on landing.** An airline's payment agent pays a passenger's delay compensation the moment the flight lands late, through HashKey Settlement Platform (HSP), with a one-payout-per-booking receipt on HSK Chain.

Entry for the HSK Chain Horizon Hackathon · Seoul, Track 2: Agent Payments & A2A Settlement.

## How it works
1. The passenger's agent sends its claim: flight, booking reference, wallet.
2. The airline's agent reads the published rule from the `LandedPolicy` contract on HSK Chain and **reserves** the booking (a second claim is refused).
3. A person at the airline approves; the agent pays through HSP (`create_order → prepare_payment → sign → finalize_payment → submit_payment → query_payment`).
4. The agent **settles** the booking on HSK Chain with the HSP transaction hash as the receipt.

Flight delays in the demo are simulated and labelled as such. HSP's hackathon (QA) environment settles on test networks; the policy and receipts contract is on HSK Chain mainnet.

## Status
Work in progress (started 21 Nov 2026). Site: https://landed-delay.vercel.app
- [x] `contracts/LandedPolicy.sol` + tests (`npx hardhat test`)
- [x] HSP MCP client (`agent/hsp.ts`) and reachability check (`npx tsx agent/inspect.ts`)
- [ ] Full payment flow (waiting on HSP QA IP allowlist)
- [x] Site, live demo page, proof page (web/), agent server (agent/server.ts)
- [ ] Mainnet deploy

## AI use
Built with Claude Code (Anthropic) as a coding assistant.

## License
MIT
