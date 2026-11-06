// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Etched onto 0x16b in tests. `capacity` defaults to false so the first
/// schedule is deferred one second, which is the HIP-1215 retry path.
contract MockScheduleService {
    bool public capacity;
    bytes public lastData;
    uint256 public lastExpiry;
    address public lastTo;

    function setCapacity(bool value) external {
        capacity = value;
    }

    function hasScheduleCapacity(uint256, uint256) external view returns (bool) {
        return capacity;
    }

    function scheduleCall(address to, uint256 expirySecond, uint256, uint64, bytes calldata callData)
        external
        returns (int64, address)
    {
        lastTo = to;
        lastExpiry = expirySecond;
        lastData = callData;
        return (22, address(0x5C11ED));
    }
}
