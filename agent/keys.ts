import { keccak256, toHex } from "viem";

/** "BA117" + "2026-12-01" -> keccak256("BA117|2026-12-01") */
export function flightKey(flight: string, date: string) {
  return keccak256(toHex(`${flight.trim().toUpperCase()}|${date}`));
}

/** One payout per booking per flight. The booking reference itself never goes on chain. */
export function bookingKey(flight: string, date: string, bookingRef: string) {
  return keccak256(toHex(`${flight.trim().toUpperCase()}|${date}|${bookingRef.trim().toUpperCase()}`));
}

export function centsToUsd(cents: bigint | number) {
  return (Number(cents) / 100).toFixed(2);
}
