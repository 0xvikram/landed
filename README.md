# Landed

**Landed late? Paid on landing.** An airline's payment agent pays a passenger's delay compensation the moment the flight lands late, through HashKey Settlement Platform (HSP), with a one-payout-per-booking receipt on HSK Chain.

Entry for the HSK Chain Horizon Hackathon · Seoul, Track 2: Agent Payments & A2A Settlement.

## How it works
1. The passenger's agent signs its claim with its own wallet (EIP-712): flight, date, a hash of the booking reference, delay, the wallet to pay, deadline, nonce. An optional AI intake turns a plain-text message into those fields for the passenger to confirm; it never sets money.
2. The airline's agent verifies the signature, reads the published rule from the `LandedPolicyV2` contract on HSK Chain and **reserves** the booking with `reserveWithClaim` (the contract re-checks that the signer is the wallet being paid; a second claim is refused).
3. A person at the airline approves; the agent pays through HSP (`create_order → prepare_payment → sign → finalize_payment → submit_payment → query_payment`).
4. The agent **settles** the booking on HSK Chain with the HSP transaction hash as the receipt.

Flight delays in the demo are simulated and labelled as such. HSP's hackathon (QA) environment settles on test networks; the policy and receipts contracts are on HSK testnet (mainnet only if picked as a finalist).

## Run it
- `npm test` (16 contract tests) and `npm run test:agent` (17 agent tests)
- `PAY_NETWORK=sepolia npm run agent` on the HSP-allowlisted machine, then serve `web/` on port 5500 and open `demo.html?agent=http://localhost:8787`. `HSP_MODE=standin` runs a labelled stand-in instead of HSP.
- Offline, `demo.html` plays a replay of a real payment from `web/replay.json` (`node scripts/build-replay.mjs [runs/<a2a run>.jsonl]` rebuilds it, checking every hash on-chain).
- `.env` keys: `RECEIPT_WRITER_KEY`, `AGENT_PAYER_KEY`, `PASSENGER_AGENT_KEY`, `POLICY_ADDRESS` (v2), `HSP_MERCHANT_NAME`, optional `GROQ_API_KEY` for the AI intake.

## Status
Work in progress (started 21 Nov 2026). Site: https://landed-delay.vercel.app
- [x] `contracts/LandedPolicy.sol` + tests (`npx hardhat test`)
- [x] HSP MCP client (`agent/hsp.ts`) and reachability check (`npx tsx agent/inspect.ts`)
- [x] Full payout run on HSK testnet with an HSP stand-in (`npx tsx agent/testnet-run.ts`; contract `0x2b44008428ce6ee69c0b44aec4daef74b22c5a71`)
- [x] Real HSP payment through the QA gateway: $10 paid on Base Sepolia ([tx](https://sepolia.basescan.org/tx/0x9488b7ae400f1850d7e59afb88b31268dc699412665e382004a3d32aba91160a)), receipt on HSK testnet ([tx](https://testnet-explorer.hskchain.net/tx/0x594226d27c5fafbc763cf56b7d5632b7bcda483e4e9d06cb668a74ff788360cf)) (`npx tsx agent/hsp-run.ts`)
- [x] Site, live demo page, proof page (web/), agent server (agent/server.ts)
- [x] `LandedPolicyV2` with agent-to-agent claims, deployed and source-verified on HSK testnet: [`0xac5f455d7e59933781680b4fb0217e111f4961ef`](https://testnet-explorer.hskchain.net/address/0xac5f455d7e59933781680b4fb0217e111f4961ef#code)
- [x] Passenger agent with its own wallet, `/api/a2a/claims`, demo "Passenger agent" panel; A2A dry run, then a paid A2A run through real HSP
- [x] Replay mode on the demo page when the agent is offline
- [x] AI intake (Groq `openai/gpt-oss-120b`), live, with a mocked-LLM test suite
- [x] Real A2A payment: the passenger agent signed, HSP paid it $10 on Base Sepolia ([tx](https://sepolia.basescan.org/tx/0x508af3a1fbc2594814a0d7da08528df3aafd5349bb4130a3049f34f30f2e398b)), and the receipt is on V2 ([tx](https://testnet-explorer.hskchain.net/tx/0x4cae2562efc31a5bc90721a8faaaafa428269d0f7b851831b94bbe494cfb2d4e))
- [ ] Mainnet deploy

## AI use
Built with Claude Code (Anthropic) as a coding assistant.

## License
MIT
