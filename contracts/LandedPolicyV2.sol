// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title LandedPolicyV2
/// @notice Same rule, booking lock and receipts as LandedPolicy (v1), plus agent-to-agent claims:
/// a passenger's agent signs an EIP-712 claim with its own wallet, the airline's agent submits it
/// with `reserveWithClaim`, and the contract only accepts it if the signer is the wallet being paid.
/// The contract still decides the amount from the published tiers; the claim never carries money.
contract LandedPolicyV2 is EIP712 {
    struct Tier {
        uint32 minDelayMinutes; // delay at or above this earns `amountCents`
        uint64 amountCents; // USD cents
    }

    enum Status {
        None,
        Reserved,
        Paid
    }

    struct Payout {
        Status status;
        bytes32 flightKey; // keccak256("BA117|2026-12-01")
        address passenger;
        uint32 delayMinutes;
        uint64 amountCents;
        uint64 settlementChainId; // chain HSP settled on
        bytes32 settlementTx; // HSP transaction hash
        uint64 reservedAt;
        uint64 paidAt;
    }

    /// @notice What a passenger's agent signs. No raw booking reference: only its hash.
    struct Claim {
        string flight; // "BA117", upper case
        string date; // "2026-12-01"
        bytes32 bookingKey; // keccak256("BA117|2026-12-01|XK4P2Q")
        uint32 delayMinutes;
        address payTo; // the passenger agent's wallet, and the signer
        uint64 deadline; // unix seconds
        uint256 nonce; // one use per payTo
    }

    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "Claim(string flight,string date,bytes32 bookingKey,uint32 delayMinutes,address payTo,uint64 deadline,uint256 nonce)"
    );

    address public owner;
    string public airline;
    uint64 public policyVersion;
    Tier[] private _tiers;
    mapping(address => bool) public isAgent;
    mapping(bytes32 => Payout) private _payouts; // by bookingKey
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    uint256 public paidCount;
    uint256 public paidCentsTotal;

    event PolicyPublished(uint64 indexed version, uint32[] minDelayMinutes, uint64[] amountCents);
    event AgentSet(address indexed agent, bool allowed);
    event PayoutReserved(bytes32 indexed bookingKey, bytes32 indexed flightKey, address passenger, uint32 delayMinutes, uint64 amountCents);
    event ClaimAccepted(bytes32 indexed bookingKey, address indexed payTo, uint256 nonce, bytes32 digest);
    event PayoutReleased(bytes32 indexed bookingKey, string reason);
    event PayoutPaid(bytes32 indexed bookingKey, bytes32 indexed flightKey, address passenger, uint64 amountCents, uint64 settlementChainId, bytes32 settlementTx);

    error NotOwner();
    error NotAgent();
    error BadPolicy();
    error AlreadyClaimed(bytes32 bookingKey);
    error NotReserved(bytes32 bookingKey);
    error NotEligible(uint32 delayMinutes);
    error BadInput();
    error ClaimExpired(uint64 deadline);
    error NonceUsed(address payTo, uint256 nonce);
    error WrongSigner(address signer, address payTo);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (!isAgent[msg.sender]) revert NotAgent();
        _;
    }

    constructor(string memory airline_, uint32[] memory minDelayMinutes, uint64[] memory amountCents) EIP712("Landed", "2") {
        owner = msg.sender;
        airline = airline_;
        isAgent[msg.sender] = true;
        emit AgentSet(msg.sender, true);
        _publish(minDelayMinutes, amountCents);
    }

    // ---------- owner ----------

    function publishPolicy(uint32[] calldata minDelayMinutes, uint64[] calldata amountCents) external onlyOwner {
        _publish(minDelayMinutes, amountCents);
    }

    function setAgent(address agent, bool allowed) external onlyOwner {
        isAgent[agent] = allowed;
        emit AgentSet(agent, allowed);
    }

    // ---------- reads ----------

    /// @return amount in USD cents owed for this delay (0 = not eligible)
    function quote(uint32 delayMinutes) public view returns (uint64) {
        uint64 amount;
        for (uint256 i = 0; i < _tiers.length; i++) {
            if (delayMinutes >= _tiers[i].minDelayMinutes) amount = _tiers[i].amountCents;
        }
        return amount;
    }

    function tiers() external view returns (Tier[] memory) {
        return _tiers;
    }

    function payoutOf(bytes32 bookingKey) external view returns (Payout memory) {
        return _payouts[bookingKey];
    }

    /// @notice EIP-712 digest a passenger agent signs for this claim.
    function claimDigest(Claim calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CLAIM_TYPEHASH,
                    keccak256(bytes(c.flight)),
                    keccak256(bytes(c.date)),
                    c.bookingKey,
                    c.delayMinutes,
                    c.payTo,
                    c.deadline,
                    c.nonce
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------- agent ----------

    /// @notice v1 path: the airline agent reserves on the passenger's behalf. Kept for compatibility.
    function reserve(bytes32 bookingKey, bytes32 flightKey, address passenger, uint32 delayMinutes)
        external
        onlyAgent
        returns (uint64 amountCents)
    {
        return _reserve(bookingKey, flightKey, passenger, delayMinutes);
    }

    /// @notice A2A path: reserve from a claim signed by the passenger's agent. Only that signer can be paid.
    function reserveWithClaim(Claim calldata c, bytes calldata signature) external onlyAgent returns (uint64 amountCents) {
        if (c.deadline < block.timestamp) revert ClaimExpired(c.deadline);
        if (nonceUsed[c.payTo][c.nonce]) revert NonceUsed(c.payTo, c.nonce);
        bytes32 digest = claimDigest(c);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != c.payTo || signer == address(0)) revert WrongSigner(signer, c.payTo);
        nonceUsed[c.payTo][c.nonce] = true;
        bytes32 flightKey = keccak256(abi.encodePacked(c.flight, "|", c.date));
        amountCents = _reserve(c.bookingKey, flightKey, c.payTo, c.delayMinutes);
        emit ClaimAccepted(c.bookingKey, c.payTo, c.nonce, digest);
    }

    /// @notice The HSP payment failed or expired: free the booking so it can be retried.
    function release(bytes32 bookingKey, string calldata reason) external onlyAgent {
        if (_payouts[bookingKey].status != Status.Reserved) revert NotReserved(bookingKey);
        delete _payouts[bookingKey];
        emit PayoutReleased(bookingKey, reason);
    }

    /// @notice Record the HSP payment that settled this booking. Pays only the reserved passenger (claim.payTo).
    function settle(bytes32 bookingKey, uint64 settlementChainId, bytes32 settlementTx) external onlyAgent {
        Payout storage p = _payouts[bookingKey];
        if (p.status != Status.Reserved) revert NotReserved(bookingKey);
        if (settlementChainId == 0 || settlementTx == bytes32(0)) revert BadInput();
        p.status = Status.Paid;
        p.settlementChainId = settlementChainId;
        p.settlementTx = settlementTx;
        p.paidAt = uint64(block.timestamp);
        paidCount += 1;
        paidCentsTotal += p.amountCents;
        emit PayoutPaid(bookingKey, p.flightKey, p.passenger, p.amountCents, settlementChainId, settlementTx);
    }

    // ---------- internal ----------

    function _reserve(bytes32 bookingKey, bytes32 flightKey, address passenger, uint32 delayMinutes)
        internal
        returns (uint64 amountCents)
    {
        if (bookingKey == bytes32(0) || flightKey == bytes32(0) || passenger == address(0)) revert BadInput();
        if (_payouts[bookingKey].status != Status.None) revert AlreadyClaimed(bookingKey);
        amountCents = quote(delayMinutes);
        if (amountCents == 0) revert NotEligible(delayMinutes);

        _payouts[bookingKey] = Payout({
            status: Status.Reserved,
            flightKey: flightKey,
            passenger: passenger,
            delayMinutes: delayMinutes,
            amountCents: amountCents,
            settlementChainId: 0,
            settlementTx: bytes32(0),
            reservedAt: uint64(block.timestamp),
            paidAt: 0
        });
        emit PayoutReserved(bookingKey, flightKey, passenger, delayMinutes, amountCents);
    }

    function _publish(uint32[] memory minDelayMinutes, uint64[] memory amountCents) internal {
        uint256 n = minDelayMinutes.length;
        if (n == 0 || n != amountCents.length || n > 8) revert BadPolicy();
        delete _tiers;
        for (uint256 i = 0; i < n; i++) {
            if (amountCents[i] == 0) revert BadPolicy();
            if (i > 0 && (minDelayMinutes[i] <= minDelayMinutes[i - 1] || amountCents[i] < amountCents[i - 1])) {
                revert BadPolicy();
            }
            _tiers.push(Tier(minDelayMinutes[i], amountCents[i]));
        }
        policyVersion += 1;
        emit PolicyPublished(policyVersion, minDelayMinutes, amountCents);
    }
}
