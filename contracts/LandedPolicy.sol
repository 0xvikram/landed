// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LandedPolicy
/// @notice An airline publishes its delay-compensation rule here. Its payment agent
/// reserves a booking before paying (so nobody is paid twice), pays through HSP,
/// then settles the reservation with the HSP transaction as the receipt.
contract LandedPolicy {
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

    address public owner;
    string public airline;
    uint64 public policyVersion;
    Tier[] private _tiers;
    mapping(address => bool) public isAgent;
    mapping(bytes32 => Payout) private _payouts; // by bookingKey
    uint256 public paidCount;
    uint256 public paidCentsTotal;

    event PolicyPublished(uint64 indexed version, uint32[] minDelayMinutes, uint64[] amountCents);
    event AgentSet(address indexed agent, bool allowed);
    event PayoutReserved(bytes32 indexed bookingKey, bytes32 indexed flightKey, address passenger, uint32 delayMinutes, uint64 amountCents);
    event PayoutReleased(bytes32 indexed bookingKey, string reason);
    event PayoutPaid(bytes32 indexed bookingKey, bytes32 indexed flightKey, address passenger, uint64 amountCents, uint64 settlementChainId, bytes32 settlementTx);

    error NotOwner();
    error NotAgent();
    error BadPolicy();
    error AlreadyClaimed(bytes32 bookingKey);
    error NotReserved(bytes32 bookingKey);
    error NotEligible(uint32 delayMinutes);
    error BadInput();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (!isAgent[msg.sender]) revert NotAgent();
        _;
    }

    constructor(string memory airline_, uint32[] memory minDelayMinutes, uint64[] memory amountCents) {
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

    // ---------- agent ----------

    /// @notice Lock a booking before paying. Reverts if it was already reserved or paid.
    function reserve(bytes32 bookingKey, bytes32 flightKey, address passenger, uint32 delayMinutes)
        external
        onlyAgent
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

    /// @notice The HSP payment failed or expired: free the booking so it can be retried.
    function release(bytes32 bookingKey, string calldata reason) external onlyAgent {
        if (_payouts[bookingKey].status != Status.Reserved) revert NotReserved(bookingKey);
        delete _payouts[bookingKey];
        emit PayoutReleased(bookingKey, reason);
    }

    /// @notice Record the HSP payment that settled this booking.
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
